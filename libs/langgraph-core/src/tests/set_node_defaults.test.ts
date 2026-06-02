/* eslint-disable no-promise-executor-return */
import { it, expect, describe, vi } from "vitest";
import { InMemoryCache } from "@langchain/langgraph-checkpoint";
import { Annotation, StateGraph } from "../graph/index.js";
import { START } from "../constants.js";
import type { RetryPolicy } from "../pregel/utils/index.js";

// ---------------------------------------------------------------------------
// setNodeDefaults()
//
// Ports the parity behavior from langchain-ai/langgraph#7747
// (`feat(langgraph): add set_node_defaults() to StateGraph`).
//
// Note: JS only supports the `retryPolicy` and `cachePolicy` node policies
// today; the Python PR's `error_handler`/`timeout` defaults are intentionally
// out of scope here because those node features do not yet exist in JS.
// ---------------------------------------------------------------------------

const State = Annotation.Root({
  foo: Annotation<string>(),
});

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
    const graph = new StateGraph(State)
      .setNodeDefaults({ cachePolicy: true })
      .addNode("cached", cachedSpy)
      .addNode("uncached", uncachedSpy, { cachePolicy: false })
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

  it("is chainable and order-independent (called after addNode)", () => {
    const graph = new StateGraph(State)
      .addNode("a", () => ({ foo: "a" }))
      .addEdge(START, "a")
      .setNodeDefaults({ retryPolicy: fastRetry, cachePolicy: { ttl: 60 } })
      .compile({ cache: new InMemoryCache() });

    expect(graph.nodes.a.retryPolicy).toEqual(fastRetry);
    expect(graph.nodes.a.cachePolicy).toEqual({ ttl: 60 });
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
