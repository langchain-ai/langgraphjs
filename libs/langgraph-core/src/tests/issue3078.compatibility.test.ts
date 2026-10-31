import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation } from "../graph/annotation.js";
import { StateGraph } from "../graph/index.js";
import { Command, END, ERROR_SOURCE_NODE, NO_WRITES, START } from "../constants.js";
import { initializeAsyncLocalStorageSingleton } from "../node.js";
import type { NodeError } from "../errors.js";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import { _runWithRetry } from "../pregel/retry.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForAbort(signal: AbortSignal) {
  if (!signal.aborted) {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

async function settle<T>(running: Promise<T>) {
  try {
    return { result: await running, error: undefined };
  } catch (error: unknown) {
    return { result: undefined, error };
  }
}

function errorSummary(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : error;
}

beforeAll(() => initializeAsyncLocalStorageSingleton());
afterEach(() => vi.useRealTimers());

describe("issue #3078: cancellation compatibility", () => {
  it("returns the external cancellation reason when the first attempt never starts", async () => {
    const controller = new AbortController();
    const cancellation = new Error("external cancellation before execution");
    controller.abort(cancellation);
    const invoke = vi.fn(async () => ({ b: 1 }));
    const task = {
      id: "3078-external-prestart", name: "B", input: {},
      config: { configurable: {} }, writes: [], proc: { invoke },
    } as unknown as Parameters<typeof _runWithRetry>[0];
    const settled = await _runWithRetry(task, undefined, undefined, controller.signal);
    console.log("[issue3078-prestart-external-reason]", JSON.stringify({
      error: errorSummary(settled.error), signalAborted: settled.signalAborted,
      writes: task.writes, calls: invoke.mock.calls.length,
    }));
    expect(settled.error).toBe(cancellation);
    expect(settled.signalAborted).toBe(true);
    expect(task.writes).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still handles a user-thrown error named AbortError", async () => {
    const State = Annotation.Root({ b: Annotation<string>() });
    const userError = new Error("B deliberately threw an AbortError");
    userError.name = "AbortError";
    let received: Error | undefined;
    let calls = 0;
    const graph = new StateGraph(State)
      .addNode("B", () => { calls += 1; throw userError; }, {
        errorHandler: (_state, error: NodeError) => {
          received = error.error;
          return { b: "recovered" };
        },
      })
      .addEdge(START, "B")
      .addEdge("B", END)
      .compile();
    const result = await graph.invoke({});
    console.log("[issue3078-user-abort-error]", JSON.stringify({
      result, calls, error: errorSummary(received), sameError: received === userError,
    }));
    expect(result).toEqual({ b: "recovered" });
    expect(received).toBe(userError);
    expect(calls).toBe(1);
  }, 5_000);

  it("keeps a real error for its handler when sibling cancellation interrupts retry backoff", async () => {
    vi.useFakeTimers();
    const State = Annotation.Root({ a: Annotation<number>(), b: Annotation<string>() });
    const checkpointer = new MemorySaver();
    const retryEntered = gate();
    const domainError = new Error("B domain failure before sibling cancellation");
    let observedSignal: AbortSignal | undefined;
    const counts = { a: 0, b: 0, handler: 0 };
    const received: unknown[] = [];
    const compile = () => new StateGraph(State)
      .addNode("A", async () => {
        counts.a += 1;
        if (counts.a === 1) {
          await retryEntered.promise;
          throw new Error("A failed");
        }
        return { a: 1 };
      })
      .addNode("B", (_state, config: LangGraphRunnableConfig) => {
        counts.b += 1;
        observedSignal = config.signal;
        throw domainError;
      }, {
        retryPolicy: {
          maxAttempts: 2,
          initialInterval: 1,
          jitter: false,
          logWarning: false,
          retryOn: () => { retryEntered.resolve(); return true; },
        },
        ends: ["join"],
        errorHandler: (_state, error: NodeError) => {
          counts.handler += 1;
          received.push(errorSummary(error.error));
          return new Command({ update: { b: "recovered" }, goto: "join" });
        },
      })
      .addNode("join", () => ({}))
      .addEdge(START, "A")
      .addEdge(START, "B")
      .addEdge(["A", "B"], "join")
      .addEdge("join", END)
      .compile({ checkpointer });
    const graph = compile();
    const config = { configurable: { thread_id: "3078-retry-real-error" } };
    const firstInvoke = settle(graph.invoke({}, config));
    await retryEntered.promise;
    expect(observedSignal).toBeDefined();
    await waitForAbort(observedSignal!);
    await vi.runAllTimersAsync();
    const first = await firstInvoke;
    expect((first.error as Error).message).toBe("A failed");
    const checkpoint = await checkpointer.getTuple(config);
    const beforeResume = { ...counts };
    const result = await compile().invoke(null, config);
    console.log("[issue3078-retained-retry-error]", JSON.stringify({
      firstError: errorSummary(first.error), beforeResume, counts, received,
      pendingWrites: checkpoint?.pendingWrites, result,
    }));
    expect(checkpoint?.pendingWrites?.some(([, channel, value]) =>
      channel === ERROR_SOURCE_NODE && value === "B")).toBe(true);
    expect(beforeResume.b).toBe(1);
    expect(counts.b).toBe(1);
    expect(counts.handler).toBe(1);
    expect(received).toEqual([{ name: "Error", message: domainError.message }]);
    expect(result).toEqual({ a: 1, b: "recovered" });
  }, 5_000);

  it("reruns a queued sibling whose first attempt was prevented by cancellation", async () => {
    const State = Annotation.Root({
      a: Annotation<number>(), b: Annotation<number>(), c: Annotation<number>(),
    });
    const checkpointer = new MemorySaver();
    const cStarted = gate();
    const returnC = gate();
    let observedSignal: AbortSignal | undefined;
    const counts = { a: 0, b: 0, c: 0, handler: 0 };
    const compile = () => new StateGraph(State)
      .addNode("A", async () => {
        counts.a += 1;
        if (counts.a === 1) {
          await cStarted.promise;
          throw new Error("A failed");
        }
        return { a: 1 };
      })
      .addNode("C", async (_state, config: LangGraphRunnableConfig) => {
        counts.c += 1;
        if (counts.c === 1) {
          observedSignal = config.signal;
          cStarted.resolve();
          await returnC.promise;
        }
        return { c: 1 };
      })
      .addNode("Z", () => { counts.b += 1; return { b: 1 }; }, {
        errorHandler: () => {
          counts.handler += 1;
          return { b: -1 };
        },
      })
      .addEdge(START, "A")
      .addEdge(START, "C")
      .addEdge(START, "Z")
      .addEdge("A", END)
      .addEdge("C", END)
      .addEdge("Z", END)
      .compile({ checkpointer });
    const graph = compile();
    const config = { configurable: { thread_id: "3078-prestart" }, maxConcurrency: 2 };
    const firstInvoke = settle(graph.invoke({}, config));
    await cStarted.promise;
    expect(observedSignal).toBeDefined();
    await waitForAbort(observedSignal!);
    returnC.resolve();
    const first = await firstInvoke;
    expect((first.error as Error).message).toBe("A failed");
    const beforeResume = { ...counts };
    const state = await graph.getState(config);
    const bTaskId = state.tasks.find((task) => task.name === "Z")?.id;
    const checkpoint = await checkpointer.getTuple(config);
    const bWrites = checkpoint?.pendingWrites?.filter(([id]) => id === bTaskId);
    const result = await compile().invoke(null, config);
    console.log("[issue3078-prestart-sibling]", JSON.stringify({
      beforeResume, counts, bWrites, result,
    }));
    expect(beforeResume.b).toBe(0);
    expect(bWrites?.some(([, channel]) => channel === NO_WRITES)).not.toBe(true);
    expect(counts.b).toBe(1);
    expect(counts.c).toBe(2);
    expect(counts.handler).toBe(0);
    expect(result).toEqual({ a: 1, b: 1, c: 1 });
  }, 5_000);

  it("retains a sibling already committed successfully before the other node fails", async () => {
    const State = Annotation.Root({ a: Annotation<number>(), b: Annotation<number>() });
    const checkpointer = new MemorySaver();
    const allowAFailure = gate();
    const counts = { a: 0, b: 0, handler: 0 };
    const graph = new StateGraph(State)
      .addNode("A", async () => {
        counts.a += 1;
        if (counts.a === 1) {
          await allowAFailure.promise;
          throw new Error("A failed");
        }
        return { a: 1 };
      })
      .addNode("B", () => { counts.b += 1; return { b: 1 }; }, {
        errorHandler: () => { counts.handler += 1; return { b: -1 }; },
      })
      .addNode("join", () => ({}))
      .addEdge(START, "A")
      .addEdge(START, "B")
      .addEdge(["A", "B"], "join")
      .addEdge("join", END)
      .compile({ checkpointer });
    const config = { configurable: { thread_id: "3078-completed-sibling" } };
    const first = await settle((async () => {
      const stream = await graph.stream({}, { ...config, streamMode: "updates" });
      for await (const update of stream) {
        if ("B" in update) allowAFailure.resolve();
      }
    })());
    expect((first.error as Error).message).toBe("A failed");
    const checkpoint = await checkpointer.getTuple(config);
    const result = await graph.invoke(null, config);
    console.log("[issue3078-completed-sibling]", JSON.stringify({
      counts, pendingWrites: checkpoint?.pendingWrites, result,
    }));
    expect(counts.b).toBe(1);
    expect(counts.handler).toBe(0);
    expect(result).toEqual({ a: 1, b: 1 });
  }, 5_000);

  it("resumes a cancelled parent node without rerunning its completed child or handler", async () => {
    const State = Annotation.Root({ a: Annotation<number>(), b: Annotation<number>() });
    const SubState = Annotation.Root({ b: Annotation<number>() });
    const checkpointer = new MemorySaver();
    const bStarted = gate();
    const returnGate = gate();
    const bBodyReturned = gate();
    const counts = { a: 0, parent: 0, work: 0, bodyReturned: 0, handler: 0 };
    const received: unknown[] = [];
    let observedParentSignal: AbortSignal | undefined;
    let observedChildSignal: AbortSignal | undefined;
    const compile = () => {
      const subgraph = new StateGraph(SubState)
        .addNode("work", async (_state, config: LangGraphRunnableConfig) => {
          counts.work += 1;
          if (counts.work === 1) {
            observedChildSignal = config.signal;
            bStarted.resolve();
            await returnGate.promise;
          }
          counts.bodyReturned += 1;
          bBodyReturned.resolve();
          return { b: 1 };
        })
        .addEdge(START, "work")
        .addEdge("work", END)
        .compile();
      return new StateGraph(State)
        .addNode("A", async () => {
          counts.a += 1;
          if (counts.a === 1) {
            await bStarted.promise;
            throw new Error("A failed");
          }
          return { a: 1 };
        })
        .addNode("B", async (state, config: LangGraphRunnableConfig) => {
          counts.parent += 1;
          observedParentSignal = config.signal;
          return subgraph.invoke(state, config);
        }, {
          ends: ["join"],
          errorHandler: (_state, error: NodeError) => {
            counts.handler += 1;
            received.push(errorSummary(error.error));
            return new Command({ update: { b: -1 }, goto: "join" });
          },
        })
        .addNode("join", () => ({}))
        .addEdge(START, "A")
        .addEdge(START, "B")
        .addEdge(["A", "B"], "join")
        .addEdge("join", END)
        .compile({ checkpointer });
    };
    const graph = compile();
    const config = { configurable: { thread_id: "3078-nested-passive" } };
    const firstInvoke = settle(graph.invoke({}, config));
    await bStarted.promise;
    expect(observedParentSignal).toBeDefined();
    await waitForAbort(observedParentSignal!);
    returnGate.resolve();
    await bBodyReturned.promise;
    const first = await firstInvoke;
    expect((first.error as Error).message).toBe("A failed");
    const checkpoint = await checkpointer.getTuple(config);
    const beforeResume = { ...counts };
    const signalsBeforeResume = {
      parentAborted: observedParentSignal?.aborted,
      childAborted: observedChildSignal?.aborted,
    };
    const result = await compile().invoke(null, config);
    console.log("[issue3078-nested-passive]", JSON.stringify({
      beforeResume, counts, received, pendingWrites: checkpoint?.pendingWrites, result,
      signalsBeforeResume,
    }));
    expect(beforeResume.bodyReturned).toBe(1);
    expect(beforeResume.parent).toBe(1);
    expect(counts.parent).toBe(2);
    expect(counts.work).toBe(1);
    expect(counts.handler).toBe(0);
    expect(result).toEqual({ a: 1, b: 1 });
  }, 5_000);

  it("preserves the existing state write when cancellation interrupts a conditional router", async () => {
    const State = Annotation.Root({
      a: Annotation<number>(), b: Annotation<number>(), routed: Annotation<number>(),
    });
    const checkpointer = new MemorySaver();
    const routerStarted = gate();
    const returnRoute = gate();
    const counts = { a: 0, b: 0, router: 0, routed: 0, handler: 0 };
    let observedSignal: AbortSignal | undefined;
    const graph = new StateGraph(State)
      .addNode("A", async () => {
        counts.a += 1;
        if (counts.a === 1) {
          await routerStarted.promise;
          throw new Error("A failed");
        }
        return { a: 1 };
      })
      .addNode("B", () => { counts.b += 1; return { b: 1 }; }, {
        ends: ["afterB"],
        errorHandler: () => {
          counts.handler += 1;
          return new Command({ update: { b: -1 }, goto: "afterB" });
        },
      })
      .addNode("afterB", () => { counts.routed += 1; return { routed: 1 }; })
      .addConditionalEdges("B", async (_state, config: LangGraphRunnableConfig) => {
        counts.router += 1;
        if (counts.router === 1) {
          observedSignal = config.signal;
          routerStarted.resolve();
          await returnRoute.promise;
        }
        return "afterB";
      }, ["afterB"])
      .addEdge(START, "A")
      .addEdge(START, "B")
      .addEdge("A", END)
      .addEdge("afterB", END)
      .compile({ checkpointer });
    const config = { configurable: { thread_id: "3078-partial-router" } };
    const firstInvoke = settle(graph.invoke({}, config));
    await routerStarted.promise;
    expect(observedSignal).toBeDefined();
    await waitForAbort(observedSignal!);
    returnRoute.resolve();
    const first = await firstInvoke;
    expect((first.error as Error).message).toBe("A failed");
    const checkpoint = await checkpointer.getTuple(config);
    const beforeResume = { ...counts };
    const result = await graph.invoke(null, config);
    console.log("[issue3078-partial-router-write]", JSON.stringify({
      beforeResume, counts, pendingWrites: checkpoint?.pendingWrites, result,
    }));
    expect(checkpoint?.pendingWrites?.some(([, channel, value]) =>
      channel === "b" && value === 1)).toBe(true);
    expect(checkpoint?.pendingWrites?.some(([, channel, value]) =>
      channel === ERROR_SOURCE_NODE && value === "B")).not.toBe(true);
    expect(counts.handler).toBe(0);
    expect(result.a).toBe(1);
    expect(result.b).toBe(1);
    // Route completion is characterized in the log; issue #3069 is a separate bug.
  }, 5_000);
});
