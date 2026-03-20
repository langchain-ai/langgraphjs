import { describe, it, expect, beforeAll } from "vitest";
import { v4 as uuidv4 } from "uuid";
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "../../web.js";
import { initializeAsyncLocalStorageSingleton } from "../../setup/async_local_storage.js";

beforeAll(() => {
  initializeAsyncLocalStorageSingleton();
});

/**
 * Helper: count event listeners on an AbortSignal.
 *
 * EventTarget doesn't expose listener counts natively, so we
 * monkey-patch addEventListener/removeEventListener on the specific
 * signal instance to track adds/removes.
 */
function trackSignalListeners(signal: AbortSignal) {
  const counts = { add: 0, remove: 0 };

  const origAdd = signal.addEventListener.bind(signal);
  const origRemove = signal.removeEventListener.bind(signal);

  signal.addEventListener = function (
    type: string,
    listener: any,
    options?: any,
  ) {
    if (type === "abort") counts.add++;
    return origAdd(type, listener, options);
  };

  signal.removeEventListener = function (
    type: string,
    listener: any,
    options?: any,
  ) {
    if (type === "abort") counts.remove++;
    return origRemove(type, listener, options);
  };

  return counts;
}

describe("AbortSignal listener leak", () => {
  const StateAnnotation = Annotation.Root({
    value: Annotation<number>({
      value: (_a, b) => b,
      default: () => 0,
    }),
  });

  it("should not accumulate abort listeners across graph steps", async () => {
    const STEPS = 20;

    // A simple graph that loops N times: node_a increments, routes back
    // to node_a until value >= STEPS, then ends.
    const graph = new StateGraph(StateAnnotation)
      .addNode("node_a", async (state) => {
        return { value: state.value + 1 };
      })
      .addEdge(START, "node_a")
      .addConditionalEdges("node_a", (state) => {
        return state.value >= STEPS ? END : "node_a";
      })
      .compile({ checkpointer: new MemorySaver() });

    const controller = new AbortController();
    const counts = trackSignalListeners(controller.signal);

    await graph.invoke(
      { value: 0 },
      {
        signal: controller.signal,
        configurable: { thread_id: uuidv4() },
      },
    );

    // After the graph completes, all abort listeners added to the
    // external signal should have been removed.
    const leaked = counts.add - counts.remove;

    console.log(
      `  Signal listeners: ${counts.add} added, ${counts.remove} removed, ${leaked} leaked`,
    );

    // Allow a small tolerance (1-2 for the top-level combine), but
    // it should NOT scale with the number of steps.
    expect(leaked).toBeLessThanOrEqual(2);
    // And certainly not O(steps):
    expect(leaked).toBeLessThan(STEPS / 2);
  });

  it("should not accumulate abort listeners across parallel subgraph invocations", async () => {
    const NUM_SUBGRAPHS = 3;
    const STEPS_PER_SUBGRAPH = 10;

    const subgraph = new StateGraph(StateAnnotation)
      .addNode("sub_node", async (state) => {
        return { value: state.value + 1 };
      })
      .addEdge(START, "sub_node")
      .addConditionalEdges("sub_node", (state) => {
        return state.value >= STEPS_PER_SUBGRAPH ? END : "sub_node";
      })
      .compile();

    // Parent graph fans out to 3 subgraph invocations
    const ParentAnnotation = Annotation.Root({
      results: Annotation<number[]>({
        value: (_a, b) => b,
        default: () => [],
      }),
    });

    const parentGraph = new StateGraph(ParentAnnotation)
      .addNode("fan_out", async () => {
        const results = await Promise.all(
          Array.from({ length: NUM_SUBGRAPHS }, async () => {
            const result = await subgraph.invoke({ value: 0 });
            return result.value;
          }),
        );
        return { results };
      })
      .addEdge(START, "fan_out")
      .addEdge("fan_out", END)
      .compile({ checkpointer: new MemorySaver() });

    const controller = new AbortController();
    const counts = trackSignalListeners(controller.signal);

    await parentGraph.invoke(
      { results: [] },
      {
        signal: controller.signal,
        configurable: { thread_id: uuidv4() },
      },
    );

    const leaked = counts.add - counts.remove;

    console.log(
      `  Signal listeners: ${counts.add} added, ${counts.remove} removed, ${leaked} leaked`,
    );

    // Should not scale with NUM_SUBGRAPHS * STEPS_PER_SUBGRAPH
    expect(leaked).toBeLessThanOrEqual(2);
  });

  it("should clean up abort listeners from stream() calls", async () => {
    const graph = new StateGraph(StateAnnotation)
      .addNode("node_a", async (state) => {
        return { value: state.value + 1 };
      })
      .addEdge(START, "node_a")
      .addConditionalEdges("node_a", (state) => {
        return state.value >= 5 ? END : "node_a";
      })
      .compile({ checkpointer: new MemorySaver() });

    const controller = new AbortController();
    const counts = trackSignalListeners(controller.signal);

    // stream() calls combineAbortSignals but discards dispose
    const stream = await graph.stream(
      { value: 0 },
      {
        signal: controller.signal,
        configurable: { thread_id: uuidv4() },
      },
    );

    // Consume the stream fully
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of stream) {
      // drain
    }

    const leaked = counts.add - counts.remove;

    console.log(
      `  Signal listeners after stream: ${counts.add} added, ${counts.remove} removed, ${leaked} leaked`,
    );

    expect(leaked).toBeLessThanOrEqual(2);
  });

  it("should not leak when running multiple sequential invocations on the same signal", async () => {
    const graph = new StateGraph(StateAnnotation)
      .addNode("node_a", async (state) => {
        return { value: state.value + 1 };
      })
      .addEdge(START, "node_a")
      .addConditionalEdges("node_a", (state) => {
        return state.value >= 3 ? END : "node_a";
      })
      .compile({ checkpointer: new MemorySaver() });

    const controller = new AbortController();
    const counts = trackSignalListeners(controller.signal);

    // Run 10 sequential invocations, simulating multiple requests
    // reusing the same AbortController (like a server with a request-scoped signal)
    for (let i = 0; i < 10; i++) {
      await graph.invoke(
        { value: 0 },
        {
          signal: controller.signal,
          configurable: { thread_id: uuidv4() },
        },
      );
    }

    const leaked = counts.add - counts.remove;

    console.log(
      `  After 10 invocations: ${counts.add} added, ${counts.remove} removed, ${leaked} leaked`,
    );

    // Critical: leaked listeners should NOT scale with number of invocations
    // If they do, this is a memory leak that compounds across requests
    expect(leaked).toBeLessThanOrEqual(2);
  });

  it("should fully reclaim memory after each invocation (memory profiling)", async () => {
    const gc = globalThis.gc;
    if (!gc) {
      console.log(
        `  ⚠ Skipping heap assertion — run with NODE_OPTIONS="--expose-gc" for precise measurement`,
      );
    }

    const STEPS_PER_INVOCATION = 5;

    const graph = new StateGraph(StateAnnotation)
      .addNode("node_a", async (state) => {
        return { value: state.value + 1 };
      })
      .addEdge(START, "node_a")
      .addConditionalEdges("node_a", (state) => {
        return state.value >= STEPS_PER_INVOCATION ? END : "node_a";
      })
      .compile();

    const controller = new AbortController();

    // Warm up — let V8 JIT compile and stabilize heap
    for (let i = 0; i < 5; i++) {
      await graph.invoke(
        { value: 0 },
        {
          signal: controller.signal,
          configurable: { thread_id: uuidv4() },
        },
      );
    }

    // Measure the heap delta for individual invocations.
    // After GC, the heap should return to roughly the same level
    // each time — no cumulative growth.
    const deltas: number[] = [];

    for (let i = 0; i < 10; i++) {
      if (gc) gc();
      const before = process.memoryUsage().heapUsed;

      await graph.invoke(
        { value: 0 },
        {
          signal: controller.signal,
          configurable: { thread_id: uuidv4() },
        },
      );

      if (gc) gc();
      const after = process.memoryUsage().heapUsed;
      deltas.push(after - before);
    }

    const avgDeltaKB =
      deltas.reduce((a, b) => a + b, 0) / deltas.length / 1024;
    const maxDeltaKB = Math.max(...deltas) / 1024;

    console.log(
      `  Per-invocation heap delta (10 runs): ` +
        `avg ${avgDeltaKB > 0 ? "+" : ""}${avgDeltaKB.toFixed(1)} KB, ` +
        `max ${maxDeltaKB > 0 ? "+" : ""}${maxDeltaKB.toFixed(1)} KB`,
    );

    // With --expose-gc, each invocation should leave the heap at roughly
    // the same level. A positive average delta means memory is accumulating
    // across invocations (i.e., not being reclaimed).
    if (gc) {
      // Average retained memory per invocation should be minimal.
      // V8 has non-deterministic allocation patterns (JIT, IC caches,
      // AbortSignal.any() internals), so allow headroom for noise.
      // The key signal is the listener count tests above — this is
      // a secondary check that no large objects are being retained.
      expect(avgDeltaKB).toBeLessThan(50);
    }
  });
});
