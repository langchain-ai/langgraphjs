import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { uuid6 } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { DurableObjectSqliteSaver } from "../index.js";
import { BetterSqliteBackend } from "../backends/better-sqlite3.js";

function createSaver() {
  const backend = BetterSqliteBackend.fromConnString(":memory:");
  return new DurableObjectSqliteSaver(backend, {
    listChannels: new Set(["messages"]),
  });
}

function closeSaver(saver: DurableObjectSqliteSaver) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((saver as any).backend as BetterSqliteBackend).close();
}

async function putCheckpoint(
  saver: DurableObjectSqliteSaver,
  threadId: string,
  parentCheckpointId: string | undefined,
  messages: unknown[],
  step: number
): Promise<RunnableConfig> {
  const checkpointId = uuid6(step);
  return saver.put(
    {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: parentCheckpointId,
      },
    },
    {
      v: 4,
      id: checkpointId,
      ts: new Date().toISOString(),
      channel_values: { messages },
      channel_versions: { messages: step + 1 },
      versions_seen: { chatbot: { messages: step } },
    },
    {
      source: "loop",
      step,
      parents: parentCheckpointId ? { "": parentCheckpointId } : {},
    },
    { messages: step + 1 }
  );
}

async function getMessages(
  saver: DurableObjectSqliteSaver,
  config: RunnableConfig
): Promise<unknown[]> {
  const tuple = await saver.getTuple(config);
  return (tuple?.checkpoint.channel_values.messages as unknown[]) ?? [];
}

describe("Segment-specific tests", () => {
  let saver: DurableObjectSqliteSaver;

  beforeEach(() => {
    saver = createSaver();
  });

  afterEach(() => {
    closeSaver(saver);
  });

  it("linear chain: all items share same segment", async () => {
    const threadId = uuid6(-3);
    const c0 = await putCheckpoint(saver, threadId, undefined, ["m1", "m2"], 0);
    const c1 = await putCheckpoint(
      saver,
      threadId,
      c0.configurable!.checkpoint_id as string,
      ["m1", "m2", "m3", "m4"],
      1
    );
    const c2 = await putCheckpoint(
      saver,
      threadId,
      c1.configurable!.checkpoint_id as string,
      ["m1", "m2", "m3", "m4", "m5"],
      2
    );

    // C0 should reconstruct with only first 2 messages
    expect(await getMessages(saver, c0)).toEqual(["m1", "m2"]);
    // C1 should have 4
    expect(await getMessages(saver, c1)).toEqual(["m1", "m2", "m3", "m4"]);
    // C2 should have all 5
    expect(await getMessages(saver, c2)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
    ]);
  });

  it("fork creates new segment, both branches reconstruct correctly", async () => {
    const threadId = uuid6(-3);
    // C0 -> C1 -> C2 (branch A)
    //                \-> C3 (branch B)
    const c0 = await putCheckpoint(saver, threadId, undefined, ["m1", "m2"], 0);
    const c0Id = c0.configurable!.checkpoint_id as string;

    const c1 = await putCheckpoint(
      saver,
      threadId,
      c0Id,
      ["m1", "m2", "m3"],
      1
    );
    const c1Id = c1.configurable!.checkpoint_id as string;

    // Branch A: continue from C1
    const c2 = await putCheckpoint(
      saver,
      threadId,
      c1Id,
      ["m1", "m2", "m3", "m4_a"],
      2
    );

    // Branch B: fork from C1 (C1 already has child C2)
    const c3 = await putCheckpoint(
      saver,
      threadId,
      c1Id,
      ["m1", "m2", "m3", "m4_b"],
      3
    );

    // Both should share prefix m1, m2, m3
    expect(await getMessages(saver, c2)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4_a",
    ]);
    expect(await getMessages(saver, c3)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4_b",
    ]);

    // Parent checkpoints should still be correct
    expect(await getMessages(saver, c0)).toEqual(["m1", "m2"]);
    expect(await getMessages(saver, c1)).toEqual(["m1", "m2", "m3"]);
  });

  it("continue after fork: appends to fork's segment", async () => {
    const threadId = uuid6(-3);
    const c0 = await putCheckpoint(saver, threadId, undefined, ["m1"], 0);
    const c0Id = c0.configurable!.checkpoint_id as string;

    // First child
    const c1 = await putCheckpoint(
      saver,
      threadId,
      c0Id,
      ["m1", "m2"],
      1
    );

    // Fork from c0
    const c2 = await putCheckpoint(
      saver,
      threadId,
      c0Id,
      ["m1", "m3"],
      2
    );
    const c2Id = c2.configurable!.checkpoint_id as string;

    // Continue from fork
    const c3 = await putCheckpoint(
      saver,
      threadId,
      c2Id,
      ["m1", "m3", "m4"],
      3
    );
    const c3Id = c3.configurable!.checkpoint_id as string;

    const c4 = await putCheckpoint(
      saver,
      threadId,
      c3Id,
      ["m1", "m3", "m4", "m5"],
      4
    );

    expect(await getMessages(saver, c1)).toEqual(["m1", "m2"]);
    expect(await getMessages(saver, c2)).toEqual(["m1", "m3"]);
    expect(await getMessages(saver, c3)).toEqual(["m1", "m3", "m4"]);
    expect(await getMessages(saver, c4)).toEqual(["m1", "m3", "m4", "m5"]);
  });

  it("deep tree: multiple levels of forking", async () => {
    const threadId = uuid6(-3);
    // C0 -> C1 -> C2a -> C3a
    //        \         \-> C3b
    //         \-> C2b
    const c0 = await putCheckpoint(saver, threadId, undefined, ["root"], 0);
    const c0Id = c0.configurable!.checkpoint_id as string;

    const c1 = await putCheckpoint(
      saver,
      threadId,
      c0Id,
      ["root", "L1"],
      1
    );
    const c1Id = c1.configurable!.checkpoint_id as string;

    // Branch A
    const c2a = await putCheckpoint(
      saver,
      threadId,
      c1Id,
      ["root", "L1", "L2a"],
      2
    );
    const c2aId = c2a.configurable!.checkpoint_id as string;

    // Branch B from c1
    const c2b = await putCheckpoint(
      saver,
      threadId,
      c1Id,
      ["root", "L1", "L2b"],
      3
    );

    // Sub-branches from c2a
    const c3a = await putCheckpoint(
      saver,
      threadId,
      c2aId,
      ["root", "L1", "L2a", "L3a"],
      4
    );
    const c3b = await putCheckpoint(
      saver,
      threadId,
      c2aId,
      ["root", "L1", "L2a", "L3b"],
      5
    );

    expect(await getMessages(saver, c2a)).toEqual(["root", "L1", "L2a"]);
    expect(await getMessages(saver, c2b)).toEqual(["root", "L1", "L2b"]);
    expect(await getMessages(saver, c3a)).toEqual([
      "root",
      "L1",
      "L2a",
      "L3a",
    ]);
    expect(await getMessages(saver, c3b)).toEqual([
      "root",
      "L1",
      "L2a",
      "L3b",
    ]);
  });

  it("empty list channel", async () => {
    const threadId = uuid6(-3);
    const c0 = await putCheckpoint(saver, threadId, undefined, [], 0);
    expect(await getMessages(saver, c0)).toEqual([]);
  });

  it("list replacement (not append)", async () => {
    const threadId = uuid6(-3);
    const c0 = await putCheckpoint(
      saver,
      threadId,
      undefined,
      ["a", "b", "c"],
      0
    );
    const c0Id = c0.configurable!.checkpoint_id as string;

    // Replace with completely different list
    const c1 = await putCheckpoint(
      saver,
      threadId,
      c0Id,
      ["x", "y"],
      1
    );

    expect(await getMessages(saver, c0)).toEqual(["a", "b", "c"]);
    expect(await getMessages(saver, c1)).toEqual(["x", "y"]);
  });

  it("mixed list + non-list channels", async () => {
    const threadId = uuid6(-3);
    const checkpointId = uuid6(0);

    await saver.put(
      {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: "",
        },
      },
      {
        v: 4,
        id: checkpointId,
        ts: new Date().toISOString(),
        channel_values: {
          messages: ["hello", "world"],
          temperature: 0.7,
        },
        channel_versions: { messages: 1, temperature: 1 },
        versions_seen: {},
      },
      { source: "loop", step: 0, parents: {} },
      { messages: 1, temperature: 1 }
    );

    const tuple = await saver.getTuple({
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: checkpointId,
      },
    });

    expect(tuple?.checkpoint.channel_values.messages).toEqual([
      "hello",
      "world",
    ]);
    expect(tuple?.checkpoint.channel_values.temperature).toEqual(0.7);
  });
});
