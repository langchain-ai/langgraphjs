/* eslint-disable no-promise-executor-return */
import { it, expect, describe, vi, beforeAll } from "vitest";
import { z } from "zod/v4";
import { InMemoryCache, MemorySaver } from "@langchain/langgraph-checkpoint";
import { StateGraph } from "../graph/index.js";
import { StateSchema } from "../state/schema.js";
import { ReducedValue } from "../state/values/reduced.js";
import { START, Command } from "../constants.js";
import { NodeError } from "../errors.js";
import { initializeAsyncLocalStorageSingleton } from "../node.js";
import type { RetryPolicy } from "../pregel/utils/index.js";

const State = new StateSchema({ foo: z.string() });

const fastRetry: RetryPolicy = {
  maxAttempts: 3,
  initialInterval: 1,
  jitter: false,
  logWarning: false,
};

describe("StateGraph.setNodeDefaults", () => {
  it("applies the default retryPolicy to nodes without their own", async () => {
    let attempts = 0;
    const graph = new StateGraph(State)
      .setNodeDefaults({ retryPolicy: fastRetry })
      .addNode("flaky", () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("not yet");
        }
        return { foo: "ok" };
      })
      .addEdge(START, "flaky")
      .compile();

    const result = await graph.invoke({ foo: "" });
    expect(result.foo).toBe("ok");
    expect(attempts).toBe(3);
    expect(graph.nodes.flaky.retryPolicy).toEqual(fastRetry);
  });

  it("lets a per-node retryPolicy override the default", async () => {
    let attempts = 0;
    const perNode: RetryPolicy = {
      maxAttempts: 5,
      initialInterval: 1,
      jitter: false,
      logWarning: false,
    };
    const graph = new StateGraph(State)
      .setNodeDefaults({ retryPolicy: { maxAttempts: 1, logWarning: false } })
      .addNode(
        "flaky",
        () => {
          attempts += 1;
          if (attempts < 4) {
            throw new Error("not yet");
          }
          return { foo: "ok" };
        },
        { retryPolicy: perNode }
      )
      .addEdge(START, "flaky")
      .compile();

    const result = await graph.invoke({ foo: "" });
    expect(result.foo).toBe("ok");
    expect(attempts).toBe(4);
    expect(graph.nodes.flaky.retryPolicy).toEqual(perNode);
  });

  it("applies the default cachePolicy to nodes without their own", async () => {
    const cache = new InMemoryCache();
    const spy = vi.fn(() => ({ foo: "ok" }));
    const graph = new StateGraph(State)
      .setNodeDefaults({ cachePolicy: { ttl: 60 } })
      .addNode("cached", spy)
      .addEdge(START, "cached")
      .compile({ cache });

    expect(graph.nodes.cached.cachePolicy).toEqual({ ttl: 60 });

    await graph.invoke({ foo: "" });
    await graph.invoke({ foo: "" });
    // Second invocation should be served from cache.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("accepts a boolean cachePolicy default", () => {
    const enabled = new StateGraph(State)
      .setNodeDefaults({ cachePolicy: true })
      .addNode("a", () => ({ foo: "a" }))
      .addEdge(START, "a")
      .compile({ cache: new InMemoryCache() });
    expect(enabled.nodes.a.cachePolicy).toEqual({});

    const disabled = new StateGraph(State)
      .setNodeDefaults({ cachePolicy: false })
      .addNode("a", () => ({ foo: "a" }))
      .addEdge(START, "a")
      .compile();
    expect(disabled.nodes.a.cachePolicy).toBeUndefined();
  });

  it("lets a per-node cachePolicy override the default", () => {
    const graph = new StateGraph(State)
      .setNodeDefaults({ cachePolicy: { ttl: 60 } })
      .addNode("a", () => ({ foo: "a" }), { cachePolicy: { ttl: 5 } })
      .addNode("b", () => ({ foo: "b" }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .compile({ cache: new InMemoryCache() });

    expect(graph.nodes.a.cachePolicy).toEqual({ ttl: 5 });
    expect(graph.nodes.b.cachePolicy).toEqual({ ttl: 60 });
  });

  it("lets a per-node cachePolicy: false opt out of the default", async () => {
    const cache = new InMemoryCache();
    const cachedSpy = vi.fn(() => ({ foo: "cached" }));
    const uncachedSpy = vi.fn(() => ({ foo: "uncached" }));
    const builder = new StateGraph(State)
      .setNodeDefaults({ cachePolicy: true })
      .addNode("cached", cachedSpy)
      .addNode("uncached", uncachedSpy, { cachePolicy: false });

    expect(builder.nodes.uncached.cachePolicy).toBe(false);

    const graph = builder
      .addEdge(START, "cached")
      .addEdge("cached", "uncached")
      .compile({ cache });

    expect(graph.nodes.cached.cachePolicy).toEqual({});
    expect(graph.nodes.uncached.cachePolicy).toBeUndefined();

    await graph.invoke({ foo: "" });
    await graph.invoke({ foo: "" });
    expect(cachedSpy).toHaveBeenCalledTimes(1);
    expect(uncachedSpy).toHaveBeenCalledTimes(2);
  });

  it("applies defaults when setNodeDefaults is called after all addNode calls", () => {
    const perNode: RetryPolicy = { maxAttempts: 7, logWarning: false };
    const graph = new StateGraph(State)
      .addNode("a", () => ({ foo: "a" }))
      .addNode("b", () => ({ foo: "b" }), { retryPolicy: perNode })
      .addNode("c", () => ({ foo: "c" }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("b", "c")
      .setNodeDefaults({ retryPolicy: fastRetry, cachePolicy: { ttl: 60 } })
      .compile({ cache: new InMemoryCache() });

    expect(graph.nodes.a.retryPolicy).toEqual(fastRetry);
    expect(graph.nodes.a.cachePolicy).toEqual({ ttl: 60 });
    expect(graph.nodes.b.retryPolicy).toEqual(perNode);
    expect(graph.nodes.b.cachePolicy).toEqual({ ttl: 60 });
    expect(graph.nodes.c.retryPolicy).toEqual(fastRetry);
    expect(graph.nodes.c.cachePolicy).toEqual({ ttl: 60 });
  });

  it("merges fields across multiple calls, later wins per-field", () => {
    const graph = new StateGraph(State)
      .setNodeDefaults({ retryPolicy: { maxAttempts: 2, logWarning: false } })
      .setNodeDefaults({ cachePolicy: { ttl: 60 } })
      .setNodeDefaults({ retryPolicy: fastRetry })
      .addNode("a", () => ({ foo: "a" }))
      .addEdge(START, "a")
      .compile({ cache: new InMemoryCache() });

    expect(graph.nodes.a.retryPolicy).toEqual(fastRetry);
    expect(graph.nodes.a.cachePolicy).toEqual({ ttl: 60 });
  });

  it("applies defaults to all nodes that lack their own value", () => {
    const perNode: RetryPolicy = { maxAttempts: 7, logWarning: false };
    const graph = new StateGraph(State)
      .setNodeDefaults({ retryPolicy: fastRetry })
      .addNode("a", () => ({ foo: "a" }))
      .addNode("b", () => ({ foo: "b" }), { retryPolicy: perNode })
      .addNode("c", () => ({ foo: "c" }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("b", "c")
      .compile();

    expect(graph.nodes.a.retryPolicy).toEqual(fastRetry);
    expect(graph.nodes.b.retryPolicy).toEqual(perNode);
    expect(graph.nodes.c.retryPolicy).toEqual(fastRetry);
  });

  it("does not mutate builder state across repeated compiles", () => {
    const builder = new StateGraph(State)
      .setNodeDefaults({ retryPolicy: fastRetry })
      .addNode("a", () => ({ foo: "a" }))
      .addEdge(START, "a");

    builder.compile();
    builder.compile();

    // The original spec stored on the builder must remain untouched.
    expect(builder.nodes.a.retryPolicy).toBeUndefined();
  });

  it("does not inherit defaults into subgraphs", () => {
    const inner = new StateGraph(State)
      .addNode("innerNode", () => ({ foo: "inner" }))
      .addEdge(START, "innerNode")
      .compile();

    // Inner graph was compiled without defaults.
    expect(inner.nodes.innerNode.retryPolicy).toBeUndefined();

    const outer = new StateGraph(State)
      .setNodeDefaults({ retryPolicy: fastRetry })
      .addNode("sub", inner)
      .addEdge(START, "sub")
      .compile();

    // The subgraph node in the outer graph picks up the outer default...
    expect(outer.nodes.sub.retryPolicy).toEqual(fastRetry);
    // ...but the inner graph's own node is unaffected.
    expect(inner.nodes.innerNode.retryPolicy).toBeUndefined();
  });

  it("returns the same builder instance for chaining", () => {
    const builder = new StateGraph(State);
    expect(builder.setNodeDefaults({ retryPolicy: fastRetry })).toBe(builder);
  });
});

const RECOVERY_NODE = "__default_error_handler__";

const RoutedState = new StateSchema({
  route: z.string(),
  foo: new ReducedValue(z.array(z.string()).default(() => []), {
    reducer: (a: string[], b: string[]) => a.concat(b),
  }),
});

describe("StateGraph.setNodeDefaults — errorHandler", () => {
  beforeAll(() => {
    initializeAsyncLocalStorageSingleton();
  });

  it("applies the default error handler to every regular node lacking its own", async () => {
    const captured: string[] = [];
    const graph = new StateGraph(RoutedState)
      .setNodeDefaults({
        errorHandler: (_state, error: NodeError) => {
          captured.push(error.node);
          return { foo: [`handled_${error.node}`] };
        },
      })
      .addNode(
        "routeNode",
        (state: typeof RoutedState.State) => new Command({ goto: state.route }),
        { ends: ["failA", "failB"] }
      )
      .addNode("failA", () => {
        throw new Error("a failed");
      })
      .addNode("failB", () => {
        throw new Error("b failed");
      })
      .addEdge(START, "routeNode")
      .compile();

    const resultA = await graph.invoke({ route: "failA", foo: [] });
    const resultB = await graph.invoke({ route: "failB", foo: [] });

    expect(resultA.foo).toEqual(["handled_failA"]);
    expect(resultB.foo).toEqual(["handled_failB"]);
    expect(captured).toContain("failA");
    expect(captured).toContain("failB");
  });

  it("lets a per-node errorHandler override the default", async () => {
    const captured: string[] = [];
    const graph = new StateGraph(RoutedState)
      .setNodeDefaults({
        errorHandler: (_state, error: NodeError) => {
          captured.push(`default:${error.node}`);
          return { foo: [`default_handled_${error.node}`] };
        },
      })
      .addNode(
        "routeNode",
        (state: typeof RoutedState.State) => new Command({ goto: state.route }),
        { ends: ["failA", "failB"] }
      )
      .addNode(
        "failA",
        () => {
          throw new Error("a failed");
        },
        {
          errorHandler: (_state, error: NodeError) => {
            captured.push(`node:${error.node}`);
            return { foo: [`node_handled_${error.node}`] };
          },
        }
      )
      .addNode("failB", () => {
        throw new Error("b failed");
      })
      .addEdge(START, "routeNode")
      .compile();

    const resultA = await graph.invoke({ route: "failA", foo: [] });
    expect(resultA.foo).toEqual(["node_handled_failA"]);
    expect(captured).toContain("node:failA");
    expect(captured).not.toContain("default:failA");

    const resultB = await graph.invoke({ route: "failB", foo: [] });
    expect(resultB.foo).toEqual(["default_handled_failB"]);
    expect(captured).toContain("default:failB");
  });

  it("does not catch a failure raised by a per-node error handler", async () => {
    const graph = new StateGraph(State)
      .setNodeDefaults({
        errorHandler: () => ({ foo: "default recovered" }),
      })
      .addNode(
        "alwaysFailing",
        () => {
          throw new Error("node boom");
        },
        {
          errorHandler: () => {
            throw new Error("handler boom");
          },
        }
      )
      .addEdge(START, "alwaysFailing")
      .compile();

    await expect(graph.invoke({ foo: "" })).rejects.toThrow("handler boom");
  });

  it("fails the run when the default error handler itself throws", async () => {
    const graph = new StateGraph(State)
      .setNodeDefaults({
        errorHandler: () => {
          throw new Error("default handler boom");
        },
      })
      .addNode("alwaysFailing", () => {
        throw new Error("node boom");
      })
      .addEdge(START, "alwaysFailing")
      .compile();

    await expect(graph.invoke({ foo: "" })).rejects.toThrow(
      "default handler boom"
    );
  });

  it("passes the runnable config to the default error handler", async () => {
    const captured: { threadId?: string } = {};
    const graph = new StateGraph(State)
      .setNodeDefaults({
        errorHandler: (_state, _error, config) => {
          captured.threadId = config?.configurable?.thread_id as string;
          return { foo: "handled" };
        },
      })
      .addNode("alwaysFailing", () => {
        throw new Error("boom");
      })
      .addEdge(START, "alwaysFailing")
      .compile({ checkpointer: new MemorySaver() });

    const result = await graph.invoke(
      { foo: "" },
      { configurable: { thread_id: "thread-xyz" } }
    );

    expect(result.foo).toBe("handled");
    expect(captured.threadId).toBe("thread-xyz");
  });

  it("throws at compile when a node uses the reserved default-handler name", () => {
    const builder = new StateGraph(State)
      .setNodeDefaults({ errorHandler: () => ({ foo: "handled" }) })
      .addNode(RECOVERY_NODE, (state) => state)
      .addEdge(START, RECOVERY_NODE);

    expect(() => builder.compile()).toThrow(RECOVERY_NODE);
  });

  it("runs the default handler only after the default retryPolicy is exhausted", async () => {
    let attempts = 0;
    const captured: { error?: string } = {};
    const graph = new StateGraph(State)
      .setNodeDefaults({
        retryPolicy: fastRetry,
        errorHandler: (_state, error: NodeError) => {
          captured.error = error.error.message;
          return { foo: "handled" };
        },
      })
      .addNode("fail", () => {
        attempts += 1;
        throw new Error("Always fails");
      })
      .addEdge(START, "fail")
      .compile();

    const result = await graph.invoke({ foo: "" });
    expect(result.foo).toBe("handled");
    expect(attempts).toBe(fastRetry.maxAttempts);
    expect(captured.error).toBe("Always fails");
  });

  it("applies retry/timeout to the shared handler node but never cachePolicy", () => {
    const graph = new StateGraph(State)
      .setNodeDefaults({
        retryPolicy: fastRetry,
        cachePolicy: { ttl: 60 },
        timeout: 1_000,
        errorHandler: () => ({ foo: "handled" }),
      })
      .addNode("a", () => ({ foo: "a" }))
      .addEdge(START, "a")
      .compile({ cache: new InMemoryCache() });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes = graph.nodes as Record<string, any>;
    const handler = nodes[RECOVERY_NODE];
    expect(handler).toBeDefined();
    // retry + timeout defaults apply to the handler node too...
    expect(handler.retryPolicy).toEqual(fastRetry);
    expect(handler.timeout).toBeDefined();
    // ...but cachePolicy must never be applied to a handler.
    expect(handler.cachePolicy).toBeUndefined();
    // regular node gets the cache default and routes to the shared handler.
    expect(nodes.a.cachePolicy).toEqual({ ttl: 60 });
    expect(nodes.a.errorHandlerNode).toBe(RECOVERY_NODE);
  });

  it("does not inherit the default error handler into subgraphs", () => {
    const inner = new StateGraph(State)
      .addNode("innerNode", () => ({ foo: "inner" }))
      .addEdge(START, "innerNode")
      .compile();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerNodes = inner.nodes as Record<string, any>;
    expect(innerNodes[RECOVERY_NODE]).toBeUndefined();
    expect(innerNodes.innerNode.errorHandlerNode).toBeUndefined();

    const outer = new StateGraph(State)
      .setNodeDefaults({ errorHandler: () => ({ foo: "handled" }) })
      .addNode("sub", inner)
      .addEdge(START, "sub")
      .compile();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outerNodes = outer.nodes as Record<string, any>;
    // The outer graph materializes its own shared handler and routes `sub` to it...
    expect(outerNodes[RECOVERY_NODE]).toBeDefined();
    expect(outerNodes.sub.errorHandlerNode).toBe(RECOVERY_NODE);
    // ...but the inner compiled graph is unaffected.
    expect(innerNodes[RECOVERY_NODE]).toBeUndefined();
  });

  it("is order-independent (errorHandler set after addNode)", async () => {
    const graph = new StateGraph(State)
      .addNode("fail", () => {
        throw new Error("boom");
      })
      .addEdge(START, "fail")
      .setNodeDefaults({ errorHandler: () => ({ foo: "handled" }) })
      .compile();

    const result = await graph.invoke({ foo: "" });
    expect(result.foo).toBe("handled");
  });

  it("receives the failing node's input, not the full graph state", async () => {
    // A single shared default handler serves nodes with differing input
    // schemas, so at runtime it sees the failing node's input (here a subset
    // that omits `b`). This is why its `state` parameter is typed `unknown`
    // rather than the full graph state.
    const FullState = new StateSchema({
      a: z.string(),
      b: z.string(),
      handled: z.boolean(),
    });
    const NodeInput = new StateSchema({
      a: z.string(),
    });

    let received: Record<string, unknown> | undefined;
    const graph = new StateGraph(FullState)
      .setNodeDefaults({
        errorHandler: (state) => {
          received = state as Record<string, unknown>;
          return { handled: true };
        },
      })
      .addNode(
        "fail",
        () => {
          throw new Error("boom");
        },
        { input: NodeInput }
      )
      .addEdge(START, "fail")
      .compile();

    const result = await graph.invoke({ a: "x", b: "y", handled: false });

    expect(result.handled).toBe(true);
    // The handler saw the node's input subset: `a` is present, the graph-only
    // field `b` is absent — matching the `unknown` typing.
    expect(received?.a).toBe("x");
    expect(received?.b).toBeUndefined();
  });
});
