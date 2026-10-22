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
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function errorSummary(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : error;
}

beforeAll(() => initializeAsyncLocalStorageSingleton());

describe("issue #3078: passive sibling returns successfully after cancellation", () => {
  for (const mode of ["plain", "recover", "rethrow"] as const) {
    for (const freshGraph of [false, true]) {
      it(`${mode}, resume using ${freshGraph ? "fresh" : "same"} compiled graph`, async () => {
        const State = Annotation.Root({
          a: Annotation<number>(),
          b: Annotation<number | string>(),
        });
        const checkpointer = new MemorySaver();
        const bStarted = gate();
        const returnGate = gate();
        const bBodyReturned = gate();
        let observedSignal: AbortSignal | undefined;
        const counts = { a: 0, b: 0, handler: 0, bBodyReturned: 0 };
        const handlerErrors: unknown[] = [];
        const compile = () => {
          const b = async (
            _state: typeof State.State,
            config: LangGraphRunnableConfig
          ) => {
            counts.b += 1;
            if (counts.b === 1) {
              observedSignal = config.signal;
              bStarted.resolve();
              await returnGate.promise;
            }
            counts.bBodyReturned += 1;
            bBodyReturned.resolve();
            return { b: 1 };
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
          configurable: { thread_id: `3078-passive-${mode}-${freshGraph}` },
        };
        const firstInvoke = graph.invoke({}, config).then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error })
        );
        await bStarted.promise;
        expect(observedSignal).toBeDefined();
        const signal = observedSignal!;
        // The driver, not B's body, observes cancellation before allowing B to return.
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        returnGate.resolve();
        await bBodyReturned.promise;
        const first = await firstInvoke;
        expect(first.error).toBeInstanceOf(Error);
        expect((first.error as Error).message).toBe("A failed");
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
        console.log("[issue3078-passive]", JSON.stringify({
          mode,
          freshGraph,
          firstError: errorSummary(first.error),
          signalAbortedBeforeBReturned: signal.aborted,
          tasks: state.tasks.map((task) => ({ name: task.name, error: task.error })),
          pendingWrites: checkpoint?.pendingWrites,
          countsBeforeResume,
          counts,
          handlerErrors,
          result,
          resumeError,
        }));
        expect.soft(countsBeforeResume.b).toBe(1);
        expect.soft(countsBeforeResume.bBodyReturned).toBe(1);
        expect.soft(resumeError).toBeUndefined();
        expect.soft(result).toEqual({ a: 1, b: 1 });
        expect.soft(counts.b).toBe(2);
        expect.soft(counts.handler).toBe(0);
      }, 5_000);
    }
  }
});
