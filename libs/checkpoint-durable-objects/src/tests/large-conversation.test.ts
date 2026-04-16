import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { uuid6 } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { DurableObjectSqliteSaver } from "../index.js";
import { BetterSqliteBackend } from "../backends/better-sqlite3.js";

const CF_MAX_ROW = 2 * 1024 * 1024; // 2MB

function createSaver(): {
  saver: DurableObjectSqliteSaver;
  backend: BetterSqliteBackend;
} {
  const backend = BetterSqliteBackend.fromConnString(":memory:");
  const saver = new DurableObjectSqliteSaver(backend, {
    listChannels: new Set(["messages"]),
  });
  return { saver, backend };
}

function generateMessage(idx: number): Record<string, unknown> {
  return {
    role: idx % 2 === 0 ? "user" : "assistant",
    content: `Message ${idx}: ${"x".repeat(200 + (idx % 500))}`,
  };
}

describe("Large conversation simulation", () => {
  let saver: DurableObjectSqliteSaver;
  let backend: BetterSqliteBackend;

  beforeEach(() => {
    ({ saver, backend } = createSaver());
  });

  afterEach(() => {
    backend.close();
  });

  it("32k messages: rows under 2MB, total under 100MB, O(delta) writes", async () => {
    const TOTAL_MESSAGES = 32000;
    const CHECKPOINT_EVERY = 100;
    const threadId = uuid6(-3);

    const allMessages: Record<string, unknown>[] = [];
    let parentCheckpointId: string | undefined;
    let step = 0;

    const writeTimes: { msgCount: number; ms: number }[] = [];
    let firstCheckpointId: string | undefined;

    for (let i = 0; i < TOTAL_MESSAGES; i++) {
      allMessages.push(generateMessage(i));

      if ((i + 1) % CHECKPOINT_EVERY !== 0 && i !== TOTAL_MESSAGES - 1)
        continue;

      const checkpointId = uuid6(step);
      const t0 = performance.now();

      const config = await saver.put(
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
          channel_values: { messages: [...allMessages] },
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

      const elapsed = performance.now() - t0;
      writeTimes.push({ msgCount: allMessages.length, ms: elapsed });

      parentCheckpointId = config.configurable!.checkpoint_id as string;
      if (!firstCheckpointId) firstCheckpointId = parentCheckpointId;
      step++;
    }

    // Check row sizes
    const maxCheckpointRow = backend.queryOne<{ mx: number }>(
      "SELECT MAX(LENGTH(checkpoint) + LENGTH(metadata)) as mx FROM checkpoints"
    )!.mx;

    const maxChannelItemRow = backend.queryOne<{ mx: number }>(
      "SELECT MAX(LENGTH(blob)) as mx FROM channel_items"
    )!.mx;

    const maxWriteRow = backend.queryOne<{ mx: number | null }>(
      "SELECT MAX(LENGTH(value)) as mx FROM writes"
    );

    expect(maxCheckpointRow).toBeLessThan(CF_MAX_ROW);
    expect(maxChannelItemRow).toBeLessThan(CF_MAX_ROW);
    if (maxWriteRow?.mx) {
      expect(maxWriteRow.mx).toBeLessThan(CF_MAX_ROW);
    }

    // Check total DB size
    const pageCount = backend.queryOne<{ page_count: number }>(
      "PRAGMA page_count"
    )!.page_count;
    const pageSize = backend.queryOne<{ page_size: number }>(
      "PRAGMA page_size"
    )!.page_size;
    const dbSize = pageCount * pageSize;

    // Should be much less than 10GB — expect under 100MB for 32k messages
    expect(dbSize).toBeLessThan(100 * 1024 * 1024);

    // Verify latest checkpoint has all messages
    const latestTuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: "" },
    });
    const latestMessages = latestTuple?.checkpoint.channel_values
      .messages as unknown[];
    expect(latestMessages.length).toBe(TOTAL_MESSAGES);
    expect(latestMessages[0]).toEqual(generateMessage(0));
    expect(latestMessages[TOTAL_MESSAGES - 1]).toEqual(
      generateMessage(TOTAL_MESSAGES - 1)
    );

    // Verify the first checkpoint has correct prefix
    const earlyConfig: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: firstCheckpointId,
      },
    };
    const earlyTuple = await saver.getTuple(earlyConfig);
    const earlyMessages = earlyTuple?.checkpoint.channel_values
      .messages as unknown[];
    expect(earlyMessages.length).toBe(CHECKPOINT_EVERY);

    // Verify write times are O(delta), not O(total)
    // The first write includes all 100 messages, later writes should be similar
    // (not growing proportionally to total message count)
    const firstWriteMs = writeTimes[0].ms;
    const lastWriteMs = writeTimes[writeTimes.length - 1].ms;
    // Last write should be at most 10x the first (generous margin)
    // If it were O(total), it would be 320x (32000/100)
    expect(lastWriteMs).toBeLessThan(firstWriteMs * 10);

    // Print summary for manual inspection
    console.log("\n=== Large Conversation Summary ===");
    console.log(`Messages: ${TOTAL_MESSAGES}`);
    console.log(`Checkpoints: ${step}`);
    console.log(
      `Max checkpoint row: ${(maxCheckpointRow / 1024).toFixed(1)} KB`
    );
    console.log(
      `Max channel_item row: ${(maxChannelItemRow / 1024).toFixed(1)} KB`
    );
    console.log(`DB size: ${(dbSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(
      `First write (${writeTimes[0].msgCount} msgs): ${writeTimes[0].ms.toFixed(1)} ms`
    );
    console.log(
      `Last write (${writeTimes[writeTimes.length - 1].msgCount} msgs): ${lastWriteMs.toFixed(1)} ms`
    );
  }, 120_000);

  it("fork at scale: both branches reconstruct correctly", async () => {
    const threadId = uuid6(-3);
    const allMessages: Record<string, unknown>[] = [];
    let parentCheckpointId: string | undefined;
    let step = 0;
    let forkPointConfig: RunnableConfig | undefined;

    // Build 1000 messages linearly
    for (let i = 0; i < 1000; i++) {
      allMessages.push(generateMessage(i));

      if ((i + 1) % 100 !== 0) continue;

      const config = await saver.put(
        {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: "",
            checkpoint_id: parentCheckpointId,
          },
        },
        {
          v: 4,
          id: uuid6(step),
          ts: new Date().toISOString(),
          channel_values: { messages: [...allMessages] },
          channel_versions: { messages: step + 1 },
          versions_seen: {},
        },
        { source: "loop", step, parents: {} },
        { messages: step + 1 }
      );

      parentCheckpointId = config.configurable!.checkpoint_id as string;

      // Save fork point at 500 messages
      if (allMessages.length === 500) {
        forkPointConfig = config;
      }
      step++;
    }

    // Continue branch A to 2000 messages
    for (let i = 1000; i < 2000; i++) {
      allMessages.push(generateMessage(i));

      if ((i + 1) % 100 !== 0) continue;

      const config = await saver.put(
        {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: "",
            checkpoint_id: parentCheckpointId,
          },
        },
        {
          v: 4,
          id: uuid6(step),
          ts: new Date().toISOString(),
          channel_values: { messages: [...allMessages] },
          channel_versions: { messages: step + 1 },
          versions_seen: {},
        },
        { source: "loop", step, parents: {} },
        { messages: step + 1 }
      );

      parentCheckpointId = config.configurable!.checkpoint_id as string;
      step++;
    }

    const branchAConfig: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: parentCheckpointId,
      },
    };

    // Fork from 500 messages, build branch B to 1500 messages
    const forkId = forkPointConfig!.configurable!.checkpoint_id as string;
    const branchBMessages = allMessages.slice(0, 500);
    let branchBParent = forkId;

    for (let i = 0; i < 1000; i++) {
      branchBMessages.push({ role: "user", content: `Branch B message ${i}` });

      if ((i + 1) % 100 !== 0) continue;

      const config = await saver.put(
        {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: "",
            checkpoint_id: branchBParent,
          },
        },
        {
          v: 4,
          id: uuid6(step),
          ts: new Date().toISOString(),
          channel_values: { messages: [...branchBMessages] },
          channel_versions: { messages: step + 1 },
          versions_seen: {},
        },
        { source: "loop", step, parents: {} },
        { messages: step + 1 }
      );

      branchBParent = config.configurable!.checkpoint_id as string;
      step++;
    }

    const branchBConfig: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: branchBParent,
      },
    };

    // Verify branch A
    const branchATuple = await saver.getTuple(branchAConfig);
    const branchAMessages = branchATuple?.checkpoint.channel_values
      .messages as Record<string, unknown>[];
    expect(branchAMessages.length).toBe(2000);
    expect(branchAMessages[0]).toEqual(generateMessage(0));
    expect(branchAMessages[1999]).toEqual(generateMessage(1999));

    // Verify branch B
    const branchBTuple = await saver.getTuple(branchBConfig);
    const branchBResult = branchBTuple?.checkpoint.channel_values
      .messages as Record<string, unknown>[];
    expect(branchBResult.length).toBe(1500);
    // First 500 should match branch A
    expect(branchBResult[0]).toEqual(generateMessage(0));
    expect(branchBResult[499]).toEqual(generateMessage(499));
    // After 500 should be branch B specific
    expect(branchBResult[500]).toEqual({
      role: "user",
      content: "Branch B message 0",
    });
  }, 120_000);
});
