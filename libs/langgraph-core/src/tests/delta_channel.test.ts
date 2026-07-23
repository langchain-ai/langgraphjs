import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import {
  MemorySaver,
  DeltaSnapshot,
  isDeltaSnapshot,
  type Checkpoint,
  type CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import { DeltaChannel } from "../channels/delta.js";
import {
  channelsFromCheckpoint,
  createCheckpoint,
  deltaChannelsToSnapshot,
  exitDeltaTaskId,
} from "../channels/base.js";
import {
  messagesDeltaReducer,
  REMOVE_ALL_MESSAGES,
  type Messages,
} from "../graph/messages_reducer.js";
import { Annotation } from "../graph/index.js";
import { StateGraph } from "../graph/state.js";
import { START, END, Overwrite } from "../constants.js";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

// A simple associative batch reducer over arrays.
const listReducer = (state: number[], writes: number[][]): number[] => {
  const out = [...state];
  for (const w of writes) out.push(...w);
  return out;
};

describe("DeltaChannel (unit)", () => {
  it("rejects a non-positive snapshotFrequency", () => {
    expect(() => new DeltaChannel(listReducer, { snapshotFrequency: 0 })).toThrow();
    expect(
      () => new DeltaChannel(listReducer, { snapshotFrequency: -1 })
    ).toThrow();
    expect(() => new DeltaChannel(listReducer, { snapshotFrequency: 1.5 })).toThrow();
  });

  it("update applies the batch reducer", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer);
    expect(ch.isAvailable()).toBe(false);
    ch.update([[1, 2], [3]]);
    expect(ch.get()).toEqual([1, 2, 3]);
    ch.update([[4]]);
    expect(ch.get()).toEqual([1, 2, 3, 4]);
  });

  it("update returns false for empty values", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer);
    expect(ch.update([])).toBe(false);
  });

  it("checkpoint() always returns undefined (sentinel)", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer);
    ch.update([[1]]);
    expect(ch.checkpoint()).toBeUndefined();
  });

  it("fromCheckpoint restores from MISSING, DeltaSnapshot, and plain value", () => {
    const spec = new DeltaChannel<number[], number[]>(listReducer);

    const fromMissing = spec.fromCheckpoint(undefined);
    expect(fromMissing.get()).toEqual([]);

    const fromSnapshot = spec.fromCheckpoint(new DeltaSnapshot([1, 2, 3]));
    expect(fromSnapshot.get()).toEqual([1, 2, 3]);

    const fromPlain = spec.fromCheckpoint([9, 8]);
    expect(fromPlain.get()).toEqual([9, 8]);
  });

  it("replayWrites folds writes oldest-to-newest", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer).fromCheckpoint(
      undefined
    );
    ch.replayWrites([
      ["t1", "messages", [1]],
      ["t2", "messages", [2, 3]],
      ["t3", "messages", [4]],
    ]);
    expect(ch.get()).toEqual([1, 2, 3, 4]);
  });

  it("replayWrites treats the last Overwrite as a reset point", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer).fromCheckpoint(
      [100]
    );
    // The Overwrite resets the base; only writes after it are replayed. (The
    // loop force-snapshots on Overwrite, so replay never actually sees an
    // Overwrite with siblings still after it — this just documents the
    // defensive reset behaviour.)
    ch.replayWrites([
      ["t1", "messages", [1]],
      ["t2", "messages", { __overwrite__: [50] }],
      ["t3", "messages", [4]],
    ]);
    expect(ch.get()).toEqual([50, 4]);
  });

  it("update rejects multiple Overwrite values in one step", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer);
    expect(() =>
      ch.update([{ __overwrite__: [1] }, { __overwrite__: [2] }])
    ).toThrow();
  });

  it("update: an Overwrite wins the whole super-step (option A)", () => {
    // A plain write precedes AND follows the Overwrite within one step.
    const ch = new DeltaChannel<number[], number[]>(listReducer).fromCheckpoint(
      [100]
    );
    ch.update([[1], { __overwrite__: [50] }, [4]]);
    // Both siblings ([1] and [4]) are discarded; only the overwrite survives.
    expect(ch.get()).toEqual([50]);
  });

  it("update: Overwrite result is independent of intra-step order", () => {
    for (const order of [
      [[1], { __overwrite__: [50] }, [4]],
      [{ __overwrite__: [50] }, [1], [4]],
      [[1], [4], { __overwrite__: [50] }],
    ] as number[][][]) {
      const ch = new DeltaChannel<number[], number[]>(
        listReducer
      ).fromCheckpoint([100]);
      ch.update(order);
      expect(ch.get()).toEqual([50]);
    }
  });

  it("equals compares reducer and snapshotFrequency", () => {
    const a = new DeltaChannel(listReducer);
    const b = new DeltaChannel(listReducer);
    const c = new DeltaChannel(listReducer, { snapshotFrequency: 5 });
    const d = new DeltaChannel((s: number[], w: number[][]) =>
      listReducer(s, w)
    );
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.equals(d)).toBe(false);
  });
});

describe("messagesDeltaReducer", () => {
  it("appends, dedups by id and is batching-invariant", () => {
    const m1 = new HumanMessage({ id: "1", content: "a" });
    const m2 = new AIMessage({ id: "2", content: "b" });
    const m2b = new AIMessage({ id: "2", content: "b-updated" });

    const once = messagesDeltaReducer([], [[m1], [m2], [m2b]]);
    const split = messagesDeltaReducer(
      messagesDeltaReducer([], [[m1], [m2]]),
      [[m2b]]
    );
    expect(once.map((m) => m.content)).toEqual(["a", "b-updated"]);
    // associativity: same result whether applied in one batch or two
    expect(split.map((m) => m.content)).toEqual(once.map((m) => m.content));
    expect(split.map((m) => m.id)).toEqual(once.map((m) => m.id));
  });

  it("tombstones via RemoveMessage", () => {
    const m1 = new HumanMessage({ id: "1", content: "a" });
    const m2 = new AIMessage({ id: "2", content: "b" });
    const out = messagesDeltaReducer(
      [m1, m2],
      [[new RemoveMessage({ id: "1" })]]
    );
    expect(out.map((m) => m.id)).toEqual(["2"]);
  });

  it("coerces raw string writes to typed messages (#7680)", () => {
    // HTTP-driven graphs may emit raw strings instead of BaseMessage objects.
    const out = messagesDeltaReducer([] as BaseMessage[], [
      "hello" as unknown as Messages,
      "there" as unknown as Messages,
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((m) => BaseMessage.isInstance(m))).toBe(true);
    expect(out.map((m) => m.content)).toEqual(["hello", "there"]);
  });

  it("coerces a deserialized state of raw messages on the slow path", () => {
    // Simulates a state restored from a blob where the first element is a
    // plain object rather than a BaseMessage instance.
    const rawState = [
      { type: "human", content: "old", id: "x" },
    ] as unknown as BaseMessage[];
    const out = messagesDeltaReducer(rawState, [
      [new AIMessage({ id: "y", content: "new" })],
    ]);
    expect(out.map((m) => m.content)).toEqual(["old", "new"]);
    expect(out.every((m) => BaseMessage.isInstance(m))).toBe(true);
  });

  it("flattens array writes and treats non-arrays as single messages", () => {
    const a = new AIMessage({ id: "a", content: "x" });
    const b = new AIMessage({ id: "b", content: "y" });
    const out = messagesDeltaReducer([], [[a, b], b]);
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("clears prior state on REMOVE_ALL_MESSAGES sentinel", () => {
    const m1 = new HumanMessage({ id: "1", content: "a" });
    const m2 = new AIMessage({ id: "2", content: "b" });
    const out = messagesDeltaReducer(
      [m1, m2],
      [[new RemoveMessage({ id: REMOVE_ALL_MESSAGES })]]
    );
    expect(out).toEqual([]);
  });

  it("keeps messages following the REMOVE_ALL_MESSAGES sentinel", () => {
    const m1 = new HumanMessage({ id: "1", content: "a" });
    const m2 = new AIMessage({ id: "2", content: "b" });
    const fresh = new HumanMessage({ id: "3", content: "c" });
    const out = messagesDeltaReducer(
      [m1, m2],
      [[new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), fresh]]
    );
    expect(out.map((m) => m.id)).toEqual(["3"]);
    expect(out.map((m) => m.content)).toEqual(["c"]);
  });

  it("clears earlier writes in the same batch as the sentinel", () => {
    const existing = new HumanMessage({ id: "1", content: "old" });
    const stale = new AIMessage({ id: "2", content: "stale" });
    const kept = new HumanMessage({ id: "3", content: "kept" });
    const out = messagesDeltaReducer(
      [existing],
      [[stale, new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), kept]]
    );
    expect(out.map((m) => m.id)).toEqual(["3"]);
  });

  it("is batching-invariant across the REMOVE_ALL_MESSAGES sentinel", () => {
    const m1 = new HumanMessage({ id: "1", content: "a" });
    const m2 = new AIMessage({ id: "2", content: "b" });
    const fresh = new HumanMessage({ id: "3", content: "c" });
    const writes: Messages[] = [
      [m1],
      [new RemoveMessage({ id: REMOVE_ALL_MESSAGES })],
      [m2],
      [fresh],
    ];

    const once = messagesDeltaReducer([], writes);
    const split = messagesDeltaReducer(
      messagesDeltaReducer([], writes.slice(0, 2)),
      writes.slice(2)
    );
    expect(once.map((m) => m.id)).toEqual(["2", "3"]);
    expect(split.map((m) => m.id)).toEqual(once.map((m) => m.id));
    expect(split.map((m) => m.content)).toEqual(once.map((m) => m.content));
  });
});

describe("createCheckpoint / deltaChannelsToSnapshot", () => {
  it("omits delta channels from channel_values unless snapshotting", () => {
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_versions = { messages: 1, other: 1 };
    const channels = {
      messages: new DeltaChannel<number[], number[]>(listReducer),
      other: new DeltaChannel<number[], number[]>(listReducer),
    };
    channels.messages.update([[1, 2]]);
    channels.other.update([[9]]);

    const cp = createCheckpoint(checkpoint, channels, 0, {
      channelsToSnapshot: new Set(["messages"]),
    });
    // snapshotted channel stored as a DeltaSnapshot, the other omitted
    expect(isDeltaSnapshot(cp.channel_values.messages)).toBe(true);
    expect((cp.channel_values.messages as DeltaSnapshot).value).toEqual([1, 2]);
    expect("other" in cp.channel_values).toBe(false);
  });

  it("deltaChannelsToSnapshot fires on update OR superstep bound", () => {
    const channels = {
      a: new DeltaChannel<number[], number[]>(listReducer, {
        snapshotFrequency: 3,
      }),
      b: new DeltaChannel<number[], number[]>(listReducer, {
        snapshotFrequency: 1000,
      }),
    };
    channels.a.update([[1]]);
    channels.b.update([[1]]);
    // a reached its update frequency (3); b reached the superstep bound
    const out = deltaChannelsToSnapshot(channels, {
      a: [3, 3],
      b: [0, 5000],
    });
    expect(out.has("a")).toBe(true);
    expect(out.has("b")).toBe(true);
    // neither bound reached
    expect(deltaChannelsToSnapshot(channels, { a: [1, 1], b: [0, 1] }).size).toBe(
      0
    );
  });
});

describe("exitDeltaTaskId", () => {
  const isPostgresUuid = (id: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id
    );

  it("produces valid RFC UUIDs that sort by superstep", () => {
    const tid = "4f7226e4-0270-bf16-1ef8-fb321bef9f3d";
    const id1 = exitDeltaTaskId(1, tid);
    const id7 = exitDeltaTaskId(7, tid);

    expect(isPostgresUuid(id1)).toBe(true);
    expect(isPostgresUuid(id7)).toBe(true);
    expect(id1 < id7).toBe(true);
    expect(id1.split("-")[0]).toBe("00000001");
    expect(id7.split("-")[0]).toBe("00000007");
    expect(id1.endsWith("-0270-bf16-1ef8-fb321bef9f3d")).toBe(true);
    expect(isPostgresUuid(`${String(1).padStart(8, "0")}-${tid}`)).toBe(false);
  });

  it("rejects invalid task ids", () => {
    expect(() => exitDeltaTaskId(1, "not-a-uuid")).toThrow(
      /Invalid task id for exit delta/
    );
  });

  it("handles NULL_TASK_ID", () => {
    const synth = exitDeltaTaskId(3, "00000000-0000-0000-0000-000000000000");
    expect(isPostgresUuid(synth)).toBe(true);
    expect(synth).toBe("00000003-0000-0000-0000-000000000000");
  });
});

describe("MemorySaver.getDeltaChannelHistory", () => {
  it("walks ancestors collecting writes oldest→newest with a snapshot seed", async () => {
    const saver = new MemorySaver();
    const threadId = "t-history";
    const baseConfig = {
      configurable: { thread_id: threadId, checkpoint_ns: "" },
    };

    // cp0: snapshot seed [0]
    const cp0: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-000000000000",
      channel_values: { messages: new DeltaSnapshot([0]) },
      channel_versions: { messages: 1 },
    };
    const meta: CheckpointMetadata = { source: "loop", step: 0, parents: {} };
    const c0 = await saver.put(baseConfig, cp0, meta);
    await saver.putWrites(c0, [["messages", [1]]], "task0");

    // cp1: delta (no value), writes [2]
    const cp1: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-000000000001",
      channel_values: {},
      channel_versions: { messages: 2 },
    };
    const c1 = await saver.put(c0, cp1, meta);
    await saver.putWrites(c1, [["messages", [2]]], "task1");

    // cp2: delta (no value), target
    const cp2: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-000000000002",
      channel_values: {},
      channel_versions: { messages: 3 },
    };
    const c2 = await saver.put(c1, cp2, meta);

    const hist = await saver.getDeltaChannelHistory({
      config: c2,
      channels: ["messages"],
    });
    expect(isDeltaSnapshot(hist.messages.seed)).toBe(true);
    expect((hist.messages.seed as DeltaSnapshot).value).toEqual([0]);
    // writes collected from cp0 (seed ancestor) and cp1, oldest→newest
    expect(hist.messages.writes).toEqual([
      ["task0", "messages", [1]],
      ["task1", "messages", [2]],
    ]);
  });

  it("orders concurrent same-super-step writes by task id", async () => {
    const saver = new MemorySaver();
    const cfg = { configurable: { thread_id: "t-group", checkpoint_ns: "" } };
    const meta: CheckpointMetadata = { source: "loop", step: 0, parents: {} };

    // cp0: snapshot seed [0], with two concurrent writes in the same step.
    const cp0: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000c0",
      channel_values: { messages: new DeltaSnapshot([0]) },
      channel_versions: { messages: 1 },
    };
    const c0 = await saver.put(cfg, cp0, meta);
    // Persist out of task-id order to prove writes are sorted by task id.
    await saver.putWrites(c0, [["messages", [2]]], "task-b");
    await saver.putWrites(c0, [["messages", [1]]], "task-a");

    // cp1: a single later-step write.
    const cp1: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000c1",
      channel_values: {},
      channel_versions: { messages: 2 },
    };
    const c1 = await saver.put(c0, cp1, meta);
    await saver.putWrites(c1, [["messages", [3]]], "task-c");

    const cp2: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000c2",
      channel_values: {},
      channel_versions: { messages: 3 },
    };
    const c2 = await saver.put(c1, cp2, meta);

    const hist = await saver.getDeltaChannelHistory({
      config: c2,
      channels: ["messages"],
    });
    // cp0's two concurrent writes are ordered by task id, then cp1's write.
    expect(hist.messages.writes).toEqual([
      ["task-a", "messages", [1]],
      ["task-b", "messages", [2]],
      ["task-c", "messages", [3]],
    ]);

    // The base default implementation must agree with the override.
    const base = await Object.getPrototypeOf(
      Object.getPrototypeOf(saver)
    ).getDeltaChannelHistory.call(saver, { config: c2, channels: ["messages"] });
    expect(base.messages.writes).toEqual(hist.messages.writes);
  });

  it("replays on-path writes when the seed is a plain (migration) value", async () => {
    // A thread migrated from a pre-delta channel has a plain
    // value blob at the migration-boundary checkpoint. Writes stored on that
    // checkpoint are the deltas that produce its child and must be replayed on
    // top of the plain seed — a guard that skipped writes for non-DeltaSnapshot
    // seeds dropped them, losing post-migration state on reload.
    const saver = new MemorySaver();
    const threadId = "t-migration";
    const baseConfig = {
      configurable: { thread_id: threadId, checkpoint_ns: "" },
    };
    const meta: CheckpointMetadata = { source: "loop", step: 0, parents: {} };

    // cp0: plain migration blob [0, 1], with a post-migration write [2].
    const cp0: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000b0",
      channel_values: { messages: [0, 1] },
      channel_versions: { messages: 1 },
    };
    const c0 = await saver.put(baseConfig, cp0, meta);
    await saver.putWrites(c0, [["messages", [2]]], "task0");

    // cp1: delta child (no value), target reconstructed via the plain seed.
    const cp1: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000b1",
      channel_values: {},
      channel_versions: { messages: 2 },
    };
    const c1 = await saver.put(c0, cp1, meta);

    const hist = await saver.getDeltaChannelHistory({
      config: c1,
      channels: ["messages"],
    });
    // Plain seed retained as-is, and the migration-boundary write is replayed.
    expect(isDeltaSnapshot(hist.messages.seed)).toBe(false);
    expect(hist.messages.seed).toEqual([0, 1]);
    expect(hist.messages.writes).toEqual([["task0", "messages", [2]]]);

    // The optimized override must agree with the base implementation.
    const base = await Object.getPrototypeOf(
      Object.getPrototypeOf(saver)
    ).getDeltaChannelHistory.call(saver, { config: c1, channels: ["messages"] });
    expect(base.messages.seed).toEqual(hist.messages.seed);
    expect(base.messages.writes).toEqual(hist.messages.writes);
  });

  it("base default implementation agrees with the override for snapshots", async () => {
    // The base implementation walks getTuple()+parentConfig.
    const saver = new MemorySaver();
    const threadId = "t-base";
    const cfg = { configurable: { thread_id: threadId, checkpoint_ns: "" } };
    const meta: CheckpointMetadata = { source: "loop", step: 0, parents: {} };

    const cp0: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000a0",
      channel_values: { messages: new DeltaSnapshot([0]) },
      channel_versions: { messages: 1 },
    };
    const c0 = await saver.put(cfg, cp0, meta);
    await saver.putWrites(c0, [["messages", [1]]], "task0");
    const cp1: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000a1",
      channel_values: {},
      channel_versions: { messages: 2 },
    };
    const c1 = await saver.put(c0, cp1, meta);

    const override = await saver.getDeltaChannelHistory({
      config: c1,
      channels: ["messages"],
    });
    // Call the base prototype implementation directly.
    const base = await Object.getPrototypeOf(
      Object.getPrototypeOf(saver)
    ).getDeltaChannelHistory.call(saver, { config: c1, channels: ["messages"] });
    expect((override.messages.seed as DeltaSnapshot).value).toEqual(
      (base.messages.seed as DeltaSnapshot).value
    );
    expect(override.messages.writes).toEqual(base.messages.writes);
  });
});

describe("DeltaChannel end-to-end via StateGraph", () => {
  const buildGraph = (snapshotFrequency: number) => {
    const State = Annotation.Root({
      messages: new DeltaChannel<BaseMessage[], Messages>(
        messagesDeltaReducer,
        { snapshotFrequency }
      ),
    });
    let turn = 0;
    return new StateGraph(State)
      .addNode("chat", () => {
        turn += 1;
        return { messages: [new AIMessage({ content: `reply ${turn}` })] };
      })
      .addEdge(START, "chat")
      .addEdge("chat", END)
      .compile({ checkpointer: new MemorySaver() });
  };

  const durabilities = ["async", "sync", "exit"] as const;
  for (const durability of durabilities) {
    it(`reconstructs accumulated messages across turns (durability=${durability}, no snapshots)`, async () => {
      const graph = buildGraph(1000);
      const config = {
        configurable: { thread_id: "thread-1" },
        durability,
      };

      for (let i = 0; i < 4; i += 1) {
        await graph.invoke({ messages: [new HumanMessage(`hi ${i}`)] }, config);
      }

      const state = await graph.getState(config);
      const contents = (state.values as { messages: BaseMessage[] }).messages.map(
        (m) => m.content
      );
      expect(contents).toEqual([
        "hi 0",
        "reply 1",
        "hi 1",
        "reply 2",
        "hi 2",
        "reply 3",
        "hi 3",
        "reply 4",
      ]);
    });
  }

  it("does not store the full value in non-snapshot checkpoint blobs", async () => {
    const graph = buildGraph(1000);
    const saver = (graph as unknown as { checkpointer: MemorySaver })
      .checkpointer;
    const config = { configurable: { thread_id: "thread-blobs" } };
    for (let i = 0; i < 3; i += 1) {
      await graph.invoke({ messages: [new HumanMessage(`hi ${i}`)] }, config);
    }
    // Inspect every stored checkpoint: messages must never appear as a plain
    // accumulated value (only absent, since snapshotFrequency=1000).
    let sawPopulated = false;
    for await (const tup of saver.list(config)) {
      const cv = tup.checkpoint.channel_values as Record<string, unknown>;
      if ("messages" in cv && cv.messages !== undefined) {
        sawPopulated = true;
        expect(isDeltaSnapshot(cv.messages)).toBe(true);
      }
    }
    expect(sawPopulated).toBe(false);
  });

  it("writes periodic snapshots and bounds replay depth", async () => {
    const graph = buildGraph(2);
    const saver = (graph as unknown as { checkpointer: MemorySaver })
      .checkpointer;
    const config = { configurable: { thread_id: "thread-snap" } };
    for (let i = 0; i < 6; i += 1) {
      await graph.invoke({ messages: [new HumanMessage(`hi ${i}`)] }, config);
    }
    // At least one checkpoint must store a DeltaSnapshot blob.
    let snapshots = 0;
    for await (const tup of saver.list(config)) {
      const cv = tup.checkpoint.channel_values as Record<string, unknown>;
      if (isDeltaSnapshot(cv.messages)) snapshots += 1;
    }
    expect(snapshots).toBeGreaterThan(0);

    const state = await graph.getState(config);
    const contents = (state.values as { messages: BaseMessage[] }).messages.map(
      (m) => m.content
    );
    // 6 human + 6 replies = 12 messages reconstructed correctly.
    expect(contents).toHaveLength(12);
    expect(contents[0]).toBe("hi 0");
    expect(contents[contents.length - 1]).toBe("reply 6");
  });

  it("reconstructs from a fresh graph instance (cold read)", async () => {
    const saver = new MemorySaver();
    const State = Annotation.Root({
      messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer),
    });
    let turn = 0;
    const makeGraph = () =>
      new StateGraph(State)
        .addNode("chat", () => {
          turn += 1;
          return { messages: [new AIMessage({ content: `r${turn}` })] };
        })
        .addEdge(START, "chat")
        .addEdge("chat", END)
        .compile({ checkpointer: saver });

    const config = { configurable: { thread_id: "cold" } };
    await makeGraph().invoke({ messages: [new HumanMessage("first")] }, config);
    await makeGraph().invoke({ messages: [new HumanMessage("second")] }, config);

    // brand new compiled graph sharing only the saver
    const fresh = makeGraph();
    const state = await fresh.getState(config);
    const contents = (state.values as { messages: BaseMessage[] }).messages.map(
      (m) => m.content
    );
    expect(contents).toEqual(["first", "r1", "second", "r2"]);
    // ids are stable across reconstruction reads
    const second = await fresh.getState(config);
    expect((second.values as { messages: BaseMessage[] }).messages.map((m) => m.id)).toEqual(
      (state.values as { messages: BaseMessage[] }).messages.map((m) => m.id)
    );
  });

  // When a plain write and an Overwrite are applied concurrently in one
  // super-step, the Overwrite wins the entire step (option A): the concurrent
  // plain write is discarded regardless of task ordering. The loop then
  // force-snapshots the channel (it saw an Overwrite), so the post-overwrite
  // value is materialized in `channel_values` and the cold read reconstructs
  // from that snapshot — identical to live, deterministically. Each iteration
  // uses a fresh thread (fresh task ids) to guard against ordering
  // nondeterminism across runs.
  it("reconstructs concurrent plain + Overwrite writes consistently with live", async () => {
    const State = Annotation.Root({
      messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer),
    });
    const makeGraph = (saver: MemorySaver) =>
      new StateGraph(State)
        .addNode("plain", () => ({
          messages: [new AIMessage({ id: "plain-msg", content: "plain" })],
        }))
        .addNode("reset", () => ({
          messages: new Overwrite([
            new AIMessage({ id: "over-msg", content: "over" }),
          ]),
        }))
        .addEdge(START, "plain")
        .addEdge(START, "reset")
        .addEdge("plain", END)
        .addEdge("reset", END)
        .compile({ checkpointer: saver });

    for (let i = 0; i < 8; i += 1) {
      const saver = new MemorySaver();
      const config = { configurable: { thread_id: `fanin-${i}` } };
      const live = await makeGraph(saver).invoke(
        { messages: [new HumanMessage({ id: "start-msg", content: "start" })] },
        config
      );
      // A brand-new graph instance reconstructs purely from the saver.
      const cold = await makeGraph(saver).getState(config);

      const liveContents = (live as { messages: BaseMessage[] }).messages.map(
        (m) => m.content
      );
      const coldContents = (
        cold.values as { messages: BaseMessage[] }
      ).messages.map((m) => m.content);

      expect(coldContents).toEqual(liveContents);
      // The Overwrite wins the whole super-step: "over" always survives while
      // both the pre-overwrite "start" input and the concurrent "plain" write
      // are always discarded — deterministically, for any task ordering.
      expect(liveContents).toEqual(["over"]);
      expect(liveContents).not.toContain("plain");
      expect(liveContents).not.toContain("start");
    }
  });

  // The same invariant must hold for savers that rely on the base
  // `getDeltaChannelHistory` walk. SqliteSaver is the strongest test: its
  // pending-writes query has no ORDER BY, so writes come back in arbitrary
  // storage order. Because the loop force-snapshots on Overwrite, the cold
  // read seeds from the materialized post-overwrite snapshot and never has to
  // replay the (unordered) concurrent writes at all — so reconstruction
  // matches live independent of storage order.
  it("reconstructs concurrent plain + Overwrite writes consistently with live via the base walk (SqliteSaver)", async () => {
    const State = Annotation.Root({
      messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer),
    });
    const makeGraph = (saver: SqliteSaver) =>
      new StateGraph(State)
        .addNode("plain", () => ({
          messages: [new AIMessage({ id: "plain-msg", content: "plain" })],
        }))
        .addNode("reset", () => ({
          messages: new Overwrite([
            new AIMessage({ id: "over-msg", content: "over" }),
          ]),
        }))
        .addEdge(START, "plain")
        .addEdge(START, "reset")
        .addEdge("plain", END)
        .addEdge("reset", END)
        .compile({ checkpointer: saver });

    for (let i = 0; i < 8; i += 1) {
      const saver = SqliteSaver.fromConnString(":memory:");
      const config = { configurable: { thread_id: `fanin-${i}` } };
      const live = await makeGraph(saver).invoke(
        { messages: [new HumanMessage({ id: "start-msg", content: "start" })] },
        config
      );
      const cold = await makeGraph(saver).getState(config);

      const liveContents = (live as { messages: BaseMessage[] }).messages.map(
        (m) => m.content
      );
      const coldContents = (
        cold.values as { messages: BaseMessage[] }
      ).messages.map((m) => m.content);

      expect(coldContents).toEqual(liveContents);
      expect(liveContents).toEqual(["over"]);
      expect(liveContents).not.toContain("plain");
      expect(liveContents).not.toContain("start");
    }
  });
});

// Cross-language parity with the Python PRs that align DeltaChannel Overwrite
// semantics: #8124 (live: an Overwrite wins its whole super-step) and #8125
// (replay: force-snapshot any channel that saw an Overwrite). These mirror the
// Python graph-level tests so JS and Python agree on the *observable* result
// for live execution AND checkpoint replay. The parallel case is the one an
// automated reviewer flagged: live returns ["b", "d"], and because step 2's
// Overwrite force-snapshots `messages` to ["b"], the cold read seeds from that
// snapshot and replays only step 3's ["d"] — matching live.
describe("DeltaChannel Overwrite parity (langgraph#8124, #8125)", () => {
  const strListReducer = (state: string[], writes: string[][]): string[] => {
    const out = [...state];
    for (const w of writes) out.push(...w);
    return out;
  };
  const State = Annotation.Root({
    messages: new DeltaChannel<string[], string[]>(strListReducer),
  });
  const messages = (v: unknown) => (v as { messages: string[] }).messages;

  it("sequential Overwrite bypasses the whole prior history", async () => {
    const saver = new MemorySaver();
    const graph = new StateGraph(State)
      .addNode("a", () => ({ messages: ["a"] }))
      .addNode("b", () => ({ messages: new Overwrite(["b"]) }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: "seq" } };

    const live = await graph.invoke({ messages: ["START"] }, config);
    const cold = await graph.getState(config);
    expect(messages(live)).toEqual(["b"]);
    expect(messages(cold.values)).toEqual(["b"]);
  });

  it("parallel Overwrite + plain wins its super-step; reload == live", async () => {
    // a -> (b: Overwrite["b"], c: ["c"]) -> d: ["d"]. The Overwrite wins step 2,
    // discarding the concurrent "c"; "d" appends in step 3 => ["b", "d"].
    const saver = new MemorySaver();
    const graph = new StateGraph(State)
      .addNode("a", () => ({ messages: ["a"] }))
      .addNode("b", () => ({ messages: new Overwrite(["b"]) }))
      .addNode("c", () => ({ messages: ["c"] }))
      .addNode("d", () => ({ messages: ["d"] }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("a", "c")
      .addEdge("b", "d")
      .addEdge("c", "d")
      .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: "par" } };

    const live = await graph.invoke({ messages: ["START"] }, config);
    // Reconstruct purely from the saver with a fresh graph instance.
    const cold = await new StateGraph(State)
      .addNode("a", () => ({ messages: ["a"] }))
      .addNode("b", () => ({ messages: new Overwrite(["b"]) }))
      .addNode("c", () => ({ messages: ["c"] }))
      .addNode("d", () => ({ messages: ["d"] }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("a", "c")
      .addEdge("b", "d")
      .addEdge("c", "d")
      .compile({ checkpointer: saver })
      .getState(config);

    expect(messages(live)).toEqual(["b", "d"]);
    // Force-snapshotting on the step-2 Overwrite makes reload equal live.
    expect(messages(cold.values)).toEqual(["b", "d"]);
  });

  it("force-snapshots a channel that saw an Overwrite (snapshot supersteps)", async () => {
    // Mirrors Python #8125 `test_delta_channel_overwrite_superstep_snapshots`:
    // even with a high snapshotFrequency, an Overwrite materializes the
    // post-overwrite value into `channel_values` at that checkpoint.
    const saver = new MemorySaver();
    const graph = new StateGraph(State)
      .addNode("a", () => ({ messages: ["a"] }))
      .addNode("b", () => ({ messages: new Overwrite(["b"]) }))
      .addNode("c", () => ({ messages: ["c"] }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("a", "c")
      .addEdge("b", END)
      .addEdge("c", END)
      .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: "snap-ow" } };

    const live = await graph.invoke({ messages: ["START"] }, config);
    expect(messages(live)).toEqual(["b"]);

    const tup = await saver.getTuple(config);
    expect(tup).toBeDefined();
    const snap = (tup!.checkpoint.channel_values as Record<string, unknown>)
      .messages;
    expect(isDeltaSnapshot(snap)).toBe(true);
    expect((snap as DeltaSnapshot).value).toEqual(["b"]);
    // The forced snapshot reset the channel's counters.
    const counters = (
      tup!.metadata as {
        counters_since_delta_snapshot?: Record<string, unknown>;
      }
    )?.counters_since_delta_snapshot;
    expect(counters?.messages).toBeUndefined();
  });

  it("two concurrent Overwrites in one super-step throw", async () => {
    const saver = new MemorySaver();
    const graph = new StateGraph(State)
      .addNode("a", () => ({ messages: ["a"] }))
      .addNode("b", () => ({ messages: new Overwrite(["b"]) }))
      .addNode("c", () => ({ messages: new Overwrite(["c"]) }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("a", "c")
      .addEdge("b", END)
      .addEdge("c", END)
      .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: "par-err" } };

    await expect(
      graph.invoke({ messages: ["START"] }, config)
    ).rejects.toThrow(/only one Overwrite/i);
  });

  // "exit" durability emits a single checkpoint per run. A channel that saw an
  // Overwrite anywhere in the run is force-snapshotted into that final
  // checkpoint with its full post-run value, and its exit-mode delta writes are
  // excluded from replay — so an Overwrite in an earlier step must NOT discard a
  // later step's append. This is the exit-mode analogue of the parallel case.
  it("exit durability: an Overwrite keeps later-superstep appends on reload", async () => {
    const saver = new MemorySaver();
    const makeGraph = () =>
      new StateGraph(State)
        .addNode("a", () => ({ messages: new Overwrite(["x"]) }))
        .addNode("b", () => ({ messages: ["y"] }))
        .addEdge(START, "a")
        .addEdge("a", "b")
        .addEdge("b", END)
        .compile({ checkpointer: saver });
    const config = {
      configurable: { thread_id: "exit-ow" },
      durability: "exit" as const,
    };

    // a overwrites to ["x"] (dropping the "start" input); b appends "y" in the
    // next super-step => ["x", "y"].
    const live = await makeGraph().invoke({ messages: ["start"] }, config);
    // Fresh graph reconstructs purely from the single exit-mode checkpoint.
    const cold = await makeGraph().getState(config);

    expect(messages(live)).toEqual(["x", "y"]);
    // The bug this guards against: if the channel were NOT force-snapshotted,
    // replaying the run's writes would let the step-1 Overwrite swallow the
    // step-2 "y", yielding ["x"] on reload.
    expect(messages(cold.values)).toEqual(["x", "y"]);
  });
});

describe("channelsFromCheckpoint", () => {
  it("replays writes for absent delta channels using the saver", async () => {
    const saver = new MemorySaver();
    const cfg = { configurable: { thread_id: "cfc", checkpoint_ns: "" } };
    const meta: CheckpointMetadata = { source: "loop", step: 0, parents: {} };
    const cp0: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000b0",
      channel_values: { messages: new DeltaSnapshot([1]) },
      channel_versions: { messages: 1 },
    };
    const c0 = await saver.put(cfg, cp0, meta);
    await saver.putWrites(c0, [["messages", [2]]], "task0");
    const cp1: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000b1",
      channel_values: {},
      channel_versions: { messages: 2 },
    };
    const c1 = await saver.put(c0, cp1, meta);

    const specs = {
      messages: new DeltaChannel<number[], number[]>(listReducer),
    };
    const channels = await channelsFromCheckpoint(specs, cp1, {
      saver,
      config: c1,
    });
    expect(channels.messages.get()).toEqual([1, 2]);
  });
});

describe("DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT", () => {
  const ENV = "LANGGRAPH_DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT";
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[ENV];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  });

  it("forces a snapshot once the superstep bound is reached even with no writes", async () => {
    process.env[ENV] = "2";
    const State = Annotation.Root({
      counter: new DeltaChannel<number[], number[]>((s, w) =>
        listReducer(s, w)
      ),
      tick: Annotation<number>({ reducer: (a, b) => (b ?? a) ?? 0, default: () => 0 }),
    });
    // counter is written once, then idle; tick keeps the graph stepping.
    const graph = new StateGraph(State)
      .addNode("seed", () => ({ counter: [1] }))
      .addNode("idle", (s: { tick: number }) => ({ tick: (s.tick ?? 0) + 1 }))
      .addEdge(START, "seed")
      .addEdge("seed", "idle")
      .addEdge("idle", END)
      .compile({ checkpointer: new MemorySaver() });
    const saver = (graph as unknown as { checkpointer: MemorySaver })
      .checkpointer;
    const config = { configurable: { thread_id: "bound" } };
    for (let i = 0; i < 4; i += 1) await graph.invoke({}, config);

    let snapshots = 0;
    for await (const tup of saver.list(config)) {
      const cv = tup.checkpoint.channel_values as Record<string, unknown>;
      if (isDeltaSnapshot(cv.counter)) snapshots += 1;
    }
    expect(snapshots).toBeGreaterThan(0);
    const state = await graph.getState(config);
    // counter is written once per invoke (4 invokes), and reconstruction
    // remains correct despite forced snapshots from the superstep bound.
    expect((state.values as { counter: number[] }).counter).toEqual([1, 1, 1, 1]);
  });
});
