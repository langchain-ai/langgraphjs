/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  it,
  expect,
  describe,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { z } from "zod/v4";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { StateGraph } from "../graph/index.js";
import { StateSchema } from "../state/schema.js";
import { ReducedValue } from "../state/values/reduced.js";
import { START } from "../constants.js";
import { Command } from "../constants.js";
import { NodeError } from "../errors.js";
import { interrupt } from "../interrupt.js";
import { initializeAsyncLocalStorageSingleton } from "../node.js";

beforeAll(() => {
  // Need to initialize the AsyncLocalStorage singleton for interrupt() to work.
  initializeAsyncLocalStorageSingleton();
});

describe("Node-level error handlers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the error handler only after the retry policy is exhausted", async () => {
    const State = new StateSchema({ foo: z.string() });

    let attempts = 0;
    const captured: { node?: string; error?: Error } = {};

    const graph = new StateGraph(State)
      .addNode(
        "alwaysFailing",
        () => {
          attempts += 1;
          throw new Error("Always fails");
        },
        {
          retryPolicy: {
            maxAttempts: 2,
            initialInterval: 1,
            jitter: false,
            retryOn: () => true,
          },
          errorHandler: (_state, error: NodeError) => {
            captured.node = error.node;
            captured.error = error.error;
            return new Command({
              update: { foo: "handled" },
              goto: "afterHandler",
            });
          },
        }
      )
      .addNode("afterHandler", (state: typeof State.State) => ({
        foo: `${state.foo}_after`,
      }))
      .addEdge(START, "alwaysFailing")
      .compile();

    const resultPromise = graph.invoke({ foo: "" });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(attempts).toBe(2);
    expect(result.foo).toBe("handled_after");
    expect(captured.node).toBe("alwaysFailing");
    expect(captured.error).toBeInstanceOf(Error);
    expect(captured.error?.message).toBe("Always fails");
  });

  it("lets the handler route to a recovery branch via Command(goto)", async () => {
    const State = new StateSchema({ foo: z.string() });

    let attempts = 0;
    const graph = new StateGraph(State)
      .addNode(
        "alwaysFailing",
        () => {
          attempts += 1;
          throw new Error("Always fails");
        },
        {
          retryPolicy: { maxAttempts: 1, initialInterval: 1, jitter: false },
          errorHandler: () =>
            new Command({ update: { foo: "handled" }, goto: "nextNode" }),
        }
      )
      .addNode("nextNode", (state: typeof State.State) => ({
        foo: `${state.foo}_next`,
      }))
      .addEdge(START, "alwaysFailing")
      .compile();

    const result = await graph.invoke({ foo: "" });
    expect(attempts).toBe(1);
    expect(result.foo).toBe("handled_next");
  });

  it("fails the run when the error handler itself throws", async () => {
    const State = new StateSchema({ foo: z.string() });

    const graph = new StateGraph(State)
      .addNode(
        "alwaysFailing",
        () => {
          throw new Error("Always fails");
        },
        {
          errorHandler: () => {
            throw new Error("handler failed");
          },
        }
      )
      .addEdge(START, "alwaysFailing")
      .compile();

    await expect(graph.invoke({ foo: "" })).rejects.toThrow("handler failed");
  });

  it("handles a failure that occurs inside a subgraph node", async () => {
    const SubState = new StateSchema({ foo: z.string() });
    const ParentState = new StateSchema({ foo: z.string() });

    const captured: { node?: string; error?: Error } = {};

    const subgraph = new StateGraph(SubState)
      .addNode("subFail", () => {
        throw new Error("subgraph boom");
      })
      .addEdge(START, "subFail")
      .compile();

    const parent = new StateGraph(ParentState)
      .addNode("subgraphNode", subgraph, {
        errorHandler: (_state, error: NodeError) => {
          captured.node = error.node;
          captured.error = error.error;
          return { foo: "handled_by_parent" };
        },
      })
      .addEdge(START, "subgraphNode")
      .compile();

    const result = await parent.invoke({ foo: "" });
    expect(result.foo).toBe("handled_by_parent");
    expect(captured.node).toBe("subgraphNode");
    expect(captured.error).toBeInstanceOf(Error);
  });

  it("preserves the failure context across a checkpoint resume", async () => {
    const State = new StateSchema({ foo: z.string() });
    const captured: { node?: string; error?: Error } = {};

    const checkpointer = new MemorySaver();
    const graph = new StateGraph(State)
      .addNode(
        "alwaysFailing",
        () => {
          throw new Error("failed before handler");
        },
        {
          errorHandler: (_state, error: NodeError) => {
            captured.node = error.node;
            captured.error = error.error;
            return { foo: "handled_after_resume" };
          },
        }
      )
      .addEdge(START, "alwaysFailing")
      .compile({
        checkpointer,
        interruptBefore: ["__error_handler__alwaysFailing" as any],
      });

    const config = { configurable: { thread_id: "graph-error-resume" } };

    await graph.invoke({ foo: "" }, config);
    const result = await graph.invoke(null, config);

    expect(result.foo).toBe("handled_after_resume");
    expect(captured.node).toBe("alwaysFailing");
    expect(captured.error).toBeInstanceOf(Error);
  });

  it("does not swallow a concurrent interrupt()", async () => {
    const State = new StateSchema({ foo: z.string() });

    const checkpointer = new MemorySaver();
    const graph = new StateGraph(State)
      .addNode(
        "nodeA",
        (_state: typeof State.State) => {
          const val = interrupt("need human input");
          return { foo: `a_${val}` };
        },
        { errorHandler: () => ({ foo: "handled" }) }
      )
      .addNode("nodeB", () => ({}))
      .addEdge(START, "nodeA")
      .addEdge(START, "nodeB")
      .compile({ checkpointer });

    const config = { configurable: { thread_id: "test-interrupt-concurrent" } };

    await graph.invoke({ foo: "" }, config);

    const state = await graph.getState(config);
    expect(state.tasks.length).toBeGreaterThan(0);
    const interrupts = state.tasks.filter(
      (t) => t.interrupts && t.interrupts.length > 0
    );
    expect(interrupts.length).toBeGreaterThan(0);
  });

  it("routes a failure to the matching node's handler", async () => {
    const State = new StateSchema({
      route: z.string(),
      foo: new ReducedValue(z.array(z.string()).default(() => []), {
        reducer: (a: string[], b: string[]) => a.concat(b),
      }),
    });

    const graph = new StateGraph(State)
      .addNode("routeNode", () => ({ foo: [] }))
      .addNode(
        "failA",
        () => {
          throw new Error("a failed");
        },
        {
          errorHandler: (_state, error: NodeError) => {
            expect(error.node).toBe("failA");
            return { foo: ["handled_a"] };
          },
        }
      )
      .addNode(
        "failB",
        () => {
          throw new Error("b failed");
        },
        {
          errorHandler: (_state, error: NodeError) => {
            expect(error.node).toBe("failB");
            return { foo: ["handled_b"] };
          },
        }
      )
      .addEdge(START, "routeNode")
      .addConditionalEdges("routeNode", (state: typeof State.State) => state.route, [
        "failA",
        "failB",
      ])
      .compile();

    const resultA = await graph.invoke({ route: "failA", foo: [] });
    const resultB = await graph.invoke({ route: "failB", foo: [] });
    expect(resultA.foo).toEqual(["handled_a"]);
    expect(resultB.foo).toEqual(["handled_b"]);
  });

  it("still fails the run for a node without an error handler", async () => {
    const State = new StateSchema({ foo: z.string() });

    const graph = new StateGraph(State)
      .addNode("failWithoutHandler", () => {
        throw new Error("no handler");
      })
      .addEdge(START, "failWithoutHandler")
      .compile();

    await expect(graph.invoke({ foo: "" })).rejects.toThrow("no handler");
  });

  it("exposes the NodeError to handlers registered as plain functions", async () => {
    const State = new StateSchema({ foo: z.string() });

    let attempts = 0;
    const captured: { node?: string; error?: Error } = {};

    const graph = new StateGraph(State)
      .addNode(
        "alwaysFailing",
        () => {
          attempts += 1;
          throw new Error("Always fails async");
        },
        {
          retryPolicy: {
            maxAttempts: 2,
            initialInterval: 1,
            jitter: false,
            retryOn: () => true,
          },
          errorHandler: async (_state, error: NodeError) => {
            captured.node = error.node;
            captured.error = error.error;
            return { foo: "handled_async" };
          },
        }
      )
      .addEdge(START, "alwaysFailing")
      .compile();

    const resultPromise = graph.invoke({ foo: "" });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(attempts).toBe(2);
    expect(result.foo).toBe("handled_async");
    expect(captured.node).toBe("alwaysFailing");
    expect(captured.error).toBeInstanceOf(Error);
  });
});
