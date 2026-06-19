/**
 * Memory tests for the checkpointerPromises tracked-Set change.
 *
 * These are normal vitest tests (not bench) that measure heap deltas
 * around graph execution. The memory numbers appear directly in the
 * test name / output so you can diff across branches.
 *
 * Run:
 *   pnpm bench:memory
 */
import { describe, test, expect } from "vitest";
import { randomUUID } from "crypto";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { createSequential } from "./sequential.js";
import {
  gatherIterator,
  takeMemorySnapshot,
  formatBytes,
  type MemorySnapshot,
} from "./utils.js";

class SlowMemorySaver extends MemorySaver {
  delayMs: number;
  constructor(delayMs: number) {
    super();
    this.delayMs = delayMs;
  }
  async put(...args: Parameters<MemorySaver["put"]>) {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return super.put(...args);
  }
  async putWrites(...args: Parameters<MemorySaver["putWrites"]>) {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return super.putWrites(...args);
  }
}

async function runGraphStream(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: any,
  input: Record<string, unknown>,
  threadId: string
) {
  await gatherIterator(
    graph.stream(input, {
      configurable: { thread_id: threadId },
      recursionLimit: 1000000000,
    })
  );
}

/** Run fn, return heap delta in bytes. */
async function heapDelta(fn: () => Promise<void>): Promise<number> {
  const before = takeMemorySnapshot();
  await fn();
  const after = takeMemorySnapshot();
  return after.heapUsed - before.heapUsed;
}

describe("Promise tracking: sequential steps", () => {
  for (const steps of [50, 200, 500]) {
    test(`${steps} steps with checkpointer`, async () => {
      // warmup
      const warmup = new MemorySaver();
      const warmupGraph = createSequential(steps).compile({
        checkpointer: warmup,
      });
      await runGraphStream(warmupGraph, { messages: [] }, randomUUID());

      // measure
      const delta = await heapDelta(async () => {
        const saver = new MemorySaver();
        const graph = createSequential(steps).compile({
          checkpointer: saver,
        });
        await runGraphStream(graph, { messages: [] }, randomUUID());
      });

      const perStep = delta / steps;
      console.log(
        `${steps} steps: total=${formatBytes(delta)} per-step=${formatBytes(
          perStep
        )}`
      );
      // Not asserting a hard threshold -- just reporting. The per-step
      // cost is the number to compare across branches.
      expect(true).toBe(true);
    });
  }
});

describe("Promise tracking: slow checkpointer", () => {
  for (const delayMs of [1, 5, 10]) {
    test(`${delayMs}ms delay, 100 steps`, async () => {
      const delta = await heapDelta(async () => {
        const saver = new SlowMemorySaver(delayMs);
        const graph = createSequential(100).compile({ checkpointer: saver });
        await runGraphStream(graph, { messages: [] }, randomUUID());
      });

      console.log(`slow(${delayMs}ms) 100 steps: total=${formatBytes(delta)}`);
      expect(true).toBe(true);
    });
  }
});

describe("Promise tracking: multi-turn same thread", () => {
  for (const turns of [10, 30]) {
    test(`${turns} turns on same thread`, async () => {
      const saver = new MemorySaver();
      const graph = createSequential(20).compile({ checkpointer: saver });
      const threadId = randomUUID();
      const snapshots: MemorySnapshot[] = [];

      snapshots.push(takeMemorySnapshot());
      for (let t = 0; t < turns; t++) {
        await runGraphStream(graph, { messages: [] }, threadId);
        snapshots.push(takeMemorySnapshot());
      }

      const totalGrowth =
        snapshots[snapshots.length - 1].heapUsed - snapshots[0].heapUsed;
      const avgPerTurn = totalGrowth / turns;
      console.log(
        `${turns} turns: total=${formatBytes(
          totalGrowth
        )} avg/turn=${formatBytes(avgPerTurn)}`
      );
      expect(true).toBe(true);
    });
  }
});

// NOTE: react agent benchmarks skipped -- FakeToolCallingChatModel.bindTools
// has a pre-existing `this.bind is not a function` issue when run outside
// the bench harness. Add back once that's fixed.

describe("Promise tracking: scaling", () => {
  const results: { steps: number; total: number; perStep: number }[] = [];

  for (const steps of [10, 50, 100, 200, 500]) {
    test(`${steps} steps`, async () => {
      const delta = await heapDelta(async () => {
        const saver = new MemorySaver();
        const graph = createSequential(steps).compile({
          checkpointer: saver,
        });
        await runGraphStream(graph, { messages: [] }, randomUUID());
      });

      const perStep = delta / steps;
      results.push({ steps, total: delta, perStep });
      console.log(
        `${steps} steps: total=${formatBytes(delta)} per-step=${formatBytes(
          perStep
        )}`
      );
      expect(true).toBe(true);
    });
  }

  test("summary", () => {
    console.log("\n--- Scaling summary ---");
    for (const r of results) {
      console.log(
        `  ${String(r.steps).padStart(4)} steps: total=${formatBytes(
          r.total
        ).padStart(10)}  per-step=${formatBytes(r.perStep).padStart(10)}`
      );
    }
    expect(results.length).toBeGreaterThan(0);
  });
});
