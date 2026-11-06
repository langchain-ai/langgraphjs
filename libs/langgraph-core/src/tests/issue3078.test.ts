import { beforeAll, describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation } from "../graph/annotation.js";
import { StateGraph } from "../graph/index.js";
import { Command, END, START } from "../constants.js";
import { initializeAsyncLocalStorageSingleton } from "../node.js";
import type { NodeError } from "../errors.js";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function errorSummary(error: unknown): unknown {
  if (error instanceof AggregateError) {
    return {
      name: error.name,
      message: error.message,
      errors: error.errors.map(errorSummary),
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return error;
}

beforeAll(() => initializeAsyncLocalStorageSingleton());

describe("issue #3078: sibling cancellation must not become a node failure", () => {
  for (const mode of ["plain", "recover", "rethrow"] as const) {
    for (const freshGraph of [false, true]) {
      it(`${mode}, resume using ${freshGraph ? "fresh" : "same"} compiled graph`, async () => {
        const State = Annotation.Root({
          a: Annotation<number>(),
          b: Annotation<number | string>(),
        });
        const checkpointer = new MemorySaver();
        const bStarted = gate();
        const counts = { a: 0, b: 0, handler: 0, bAborted: 0 };
        const handlerErrors: unknown[] = [];
        const compile = () => {
          const b = async (
            _state: typeof State.State,
            config: LangGraphRunnableConfig
          ) => {
            counts.b += 1;
            if (counts.b > 1) return { b: 1 };
            const signal = config.signal;
            expect(signal).toBeDefined();
            return new Promise<{ b: number }>((_resolve, reject) => {
              const cancelled = () => {
                counts.bAborted += 1;
                reject(signal!.reason);
              };
              if (signal!.aborted) cancelled();
              else signal!.addEventListener("abort", cancelled, { once: true });
              // A is allowed to fail only after B is running and observing cancellation.
              bStarted.resolve();
            });
          };
          const options = mode === "plain" ? {} : {
            retryPolicy: { maxAttempts: 1 },
            ends: ["join"],
            errorHandler: (_state: typeof State.State, error: NodeError) => {
              counts.handler += 1;
              handlerErrors.push(errorSummary(error.error));
              if (mode === "rethrow") throw error.error;
              return new Command({ update: { b: "recovered" }, goto: "join" });
            },
          };
          return new StateGraph(State)
            .addNode("A", async () => {
              counts.a += 1;
              if (counts.a === 1) {
                await bStarted.promise;
                throw new Error("A failed");
              }
              return { a: 1 };
            })
            .addNode("B", b, options)
            .addNode("join", () => ({}))
            .addEdge(START, "A")
            .addEdge(START, "B")
            .addEdge(["A", "B"], "join")
            .addEdge("join", END)
            .compile({ checkpointer });
        };
        const graph = compile();
        const config = {
          configurable: { thread_id: `3078-${mode}-${freshGraph}` },
        };
        await expect(graph.invoke({}, config)).rejects.toThrow("A failed");
        const state = await graph.getState(config);
        const checkpoint = await checkpointer.getTuple(config);
        const countsBeforeResume = { ...counts };
        let result: unknown;
        let resumeError: unknown;
        try {
          result = await (freshGraph ? compile() : graph).invoke(null, config);
        } catch (error) {
          resumeError = errorSummary(error);
        }
        console.log("[issue3078]", JSON.stringify({
          mode,
          freshGraph,
          tasks: state.tasks.map((task) => ({ name: task.name, error: task.error })),
          pendingWrites: checkpoint?.pendingWrites,
          countsBeforeResume,
          counts,
          handlerErrors,
          result,
          resumeError,
        }));
        expect.soft(countsBeforeResume.b).toBe(1);
        expect.soft(countsBeforeResume.bAborted).toBe(1);
        expect.soft(resumeError).toBeUndefined();
        expect.soft(result).toEqual({ a: 1, b: 1 });
        expect.soft(counts.b).toBe(2);
        expect.soft(counts.handler).toBe(0);
      }, 5_000);
    }
  }

  it("preserves both true concurrent node failures", async () => {
    const State = Annotation.Root({ a: Annotation<number>() });
    const readyA = gate();
    const readyB = gate();
    const fail = gate();
    const checkpointer = new MemorySaver();
    const graph = new StateGraph(State)
      .addNode("A", async () => {
        readyA.resolve();
        await fail.promise;
        throw new Error("A domain failure");
      })
      .addNode("B", async () => {
        readyB.resolve();
        await fail.promise;
        throw new Error("B domain failure");
      })
      .addEdge(START, "A")
      .addEdge(START, "B")
      .compile({ checkpointer });
    const config = { configurable: { thread_id: "3078-real-concurrent" } };
    const settled = graph.invoke({}, config).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error })
    );
    await Promise.all([readyA.promise, readyB.promise]);
    fail.resolve();
    const { error } = await settled;
    const checkpoint = await checkpointer.getTuple(config);
    console.log("[issue3078-concurrent]", JSON.stringify({
      error: errorSummary(error),
      pendingWrites: checkpoint?.pendingWrites,
    }));
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((item) => item.message).sort())
      .toEqual(["A domain failure", "B domain failure"]);
  }, 5_000);
});
