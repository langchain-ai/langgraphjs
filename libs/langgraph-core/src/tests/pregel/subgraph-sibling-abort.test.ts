import { describe, expect, it } from "vitest";
import { Annotation, END, MemorySaver, START, StateGraph } from "../../web.js";

describe("parallel subgraph cancellation", () => {
  it("does not run the next child node after a sibling fails", async () => {
    const state = Annotation.Root({ value: Annotation<number>() });
    let runs = 0;
    let fail = true;
    const child = new StateGraph(state)
      .addNode("first", async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {};
      })
      .addNode("last", () => {
        runs += 1;
        return {};
      })
      .addEdge(START, "first")
      .addEdge("first", "last")
      .addEdge("last", END)
      .compile();
    const graph = new StateGraph(state)
      .addNode("flaky", () => {
        if (fail) {
          fail = false;
          throw new Error("transient failure");
        }
        return {};
      })
      .addNode("child", child)
      .addEdge(START, "flaky")
      .addEdge(START, "child")
      .addEdge("flaky", END)
      .addEdge("child", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "sibling-abort" } };

    await expect(graph.invoke({ value: 1 }, config)).rejects.toThrow(
      "transient failure"
    );
    // The interrupted child must not advance even if it ignores cancellation
    // until its current node returns. Check before the resume starts.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runs).toBe(0);
    await graph.invoke(null, config);
    expect(runs).toBe(1);
  });

  it("does not repeat a child that completed before its sibling failed", async () => {
    const state = Annotation.Root({ value: Annotation<number>() });
    let runs = 0;
    let fail = true;
    const child = new StateGraph(state)
      .addNode("last", () => {
        runs += 1;
        return {};
      })
      .addEdge(START, "last")
      .addEdge("last", END)
      .compile();
    const graph = new StateGraph(state)
      .addNode("flaky", async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (fail) {
          fail = false;
          throw new Error("transient failure");
        }
        return {};
      })
      .addNode("child", child)
      .addEdge(START, "flaky")
      .addEdge(START, "child")
      .addEdge("flaky", END)
      .addEdge("child", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "completed-child" } };

    await expect(graph.invoke({ value: 1 }, config)).rejects.toThrow(
      "transient failure"
    );
    expect(runs).toBe(1);
    await graph.invoke(null, config);
    expect(runs).toBe(1);
  });
});
