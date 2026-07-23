import { describe, it, expect } from "vitest";
import {
  Annotation,
  END,
  LangGraphRunnableConfig,
  Send,
  START,
  StateGraph,
} from "../../web.js";

function trackAbortListeners(signal: AbortSignal) {
  const counts = { add: 0, remove: 0 };
  const origAdd = signal.addEventListener.bind(signal);
  const origRemove = signal.removeEventListener.bind(signal);

  signal.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    if (type === "abort") counts.add += 1;
    return origAdd(type, listener, options);
  };

  signal.removeEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ) {
    if (type === "abort") counts.remove += 1;
    return origRemove(type, listener, options);
  };

  return counts;
}

describe("parallel task AbortSignal fan-out", () => {
  const ParentState = Annotation.Root({
    workerCount: Annotation<number>,
    results: Annotation<number[]>({
      default: () => [],
      reducer: (left, right) => left.concat(right),
    }),
  });

  it("does not exceed MaxListeners when parallel Send workers attach abort listeners", async () => {
    const workerCount = 12;

    const graph = new StateGraph(ParentState)
      .addNode("orchestrator", () => ({ workerCount }))
      .addNode("worker", async (_state, config: LangGraphRunnableConfig) => {
        const { signal } = config;
        expect(signal).toBeDefined();
        signal!.addEventListener("abort", () => undefined, { once: true });
        return { results: [1] };
      })
      .addEdge(START, "orchestrator")
      .addConditionalEdges("orchestrator", (state) =>
        Array.from({ length: state.workerCount }, (_, id) =>
          new Send("worker", { id })
        )
      )
      .addEdge("worker", END)
      .compile();

    const warnings: string[] = [];
    const onWarning = (warning: Error) => {
      warnings.push(warning.message);
    };
    process.on("warning", onWarning);

    try {
      const result = await graph.invoke({ workerCount });
      expect(result.results).toHaveLength(workerCount);
      expect(
        warnings.some((warning) =>
          warning.includes("MaxListenersExceededWarning")
        )
      ).toBe(false);
    } finally {
      process.off("warning", onWarning);
    }
  });

  it("gives each parallel worker its own forked abort signal", async () => {
    const workerCount = 12;
    const seenSignals = new Set<AbortSignal>();

    const graph = new StateGraph(ParentState)
      .addNode("orchestrator", () => ({ workerCount }))
      .addNode("worker", async (_state, config: LangGraphRunnableConfig) => {
        expect(config.signal).toBeDefined();
        seenSignals.add(config.signal!);
        return { results: [1] };
      })
      .addEdge(START, "orchestrator")
      .addConditionalEdges("orchestrator", (state) =>
        Array.from({ length: state.workerCount }, (_, id) =>
          new Send("worker", { id })
        )
      )
      .addEdge("worker", END)
      .compile();

    await graph.invoke({ workerCount });

    expect(seenSignals.size).toBe(workerCount);
  });

  it("does not accumulate listeners on an external abort signal", async () => {
    const workerCount = 12;
    const controller = new AbortController();
    const counts = trackAbortListeners(controller.signal);

    const graph = new StateGraph(ParentState)
      .addNode("orchestrator", () => ({ workerCount }))
      .addNode("worker", async (_state, config: LangGraphRunnableConfig) => {
        config.signal?.addEventListener("abort", () => undefined, {
          once: true,
        });
        return { results: [1] };
      })
      .addEdge(START, "orchestrator")
      .addConditionalEdges("orchestrator", (state) =>
        Array.from({ length: state.workerCount }, (_, id) =>
          new Send("worker", { id })
        )
      )
      .addEdge("worker", END)
      .compile();

    await graph.invoke({ workerCount }, { signal: controller.signal });

    expect(counts.add - counts.remove).toBeLessThanOrEqual(2);
  });
});