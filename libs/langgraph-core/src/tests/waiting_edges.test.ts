import { it, expect, describe } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation, StateGraph } from "../graph/index.js";
import { START, END, Command, Send } from "../constants.js";
import type { WaitingEdgeDescription } from "../web.js";

const State = Annotation.Root({
  ran: Annotation<string[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  targets: Annotation<string[]>({
    reducer: (_, b) => b,
    default: () => ["a", "b"],
  }),
});

const mark = (name: string) => () => ({ ran: [name] });

describe("waitingEdges", () => {
  it("reports the unreleased edge when a listed node is not selected", async () => {
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("merge", mark("merge"))
      .addNode("after", mark("after"))
      .addConditionalEdges(START, (state) => state.targets, ["a", "b"])
      .addEdge(["a", "b"], "merge")
      .addEdge("merge", "after")
      .addEdge("after", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "unreleased" } };

    const result = await graph.invoke({ targets: ["a"] }, config);
    const snapshot = await graph.getState(config);

    expect(result.ran).toEqual(["a"]);
    expect(snapshot.next).toEqual([]);
    expect(snapshot.waitingEdges).toEqual([
      { target: "merge", completed: ["a"], missing: ["b"] },
    ] satisfies WaitingEdgeDescription[]);
  });

  it("omits the key when every edge released", async () => {
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("merge", mark("merge"))
      .addEdge(START, "a")
      .addEdge(START, "b")
      .addEdge(["a", "b"], "merge")
      .addEdge("merge", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "healthy" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config);

    expect(snapshot.waitingEdges).toBeUndefined();
    expect("waitingEdges" in snapshot).toBe(false);
  });

  it("reports an armed edge while interrupted, and clears it on resume", async () => {
    // `b` is a superstep deeper, so `a` has already written to the edge by the
    // time the run pauses before `b`.
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("gate", mark("gate"))
      .addNode("b", mark("b"))
      .addNode("merge", mark("merge"))
      .addEdge(START, "a")
      .addEdge(START, "gate")
      .addEdge("gate", "b")
      .addEdge(["a", "b"], "merge")
      .addEdge("merge", END)
      .compile({
        checkpointer: new MemorySaver(),
        interruptBefore: ["b"],
      });
    const config = { configurable: { thread_id: "interrupted" } };

    await graph.invoke({}, config);
    const paused = await graph.getState(config);

    expect(paused.next).toEqual(["b"]);
    expect(paused.waitingEdges).toEqual([
      { target: "merge", completed: ["a"], missing: ["b"] },
    ]);

    const resumed = await graph.invoke(null, config);
    const done = await graph.getState(config);

    expect(resumed.ran).toContain("merge");
    expect(done.waitingEdges).toBeUndefined();
  });

  it("does not surface an unreleased edge inside a subgraph on the parent snapshot", async () => {
    const inner = new StateGraph(State)
      .addNode("ia", mark("ia"))
      .addNode("ib", mark("ib"))
      .addNode("imerge", mark("imerge"))
      .addConditionalEdges(START, () => ["ia"], ["ia", "ib"])
      .addEdge(["ia", "ib"], "imerge")
      .addEdge("imerge", END)
      .compile();

    const graph = new StateGraph(State)
      .addNode("sub", inner)
      .addNode("tail", mark("tail"))
      .addEdge(START, "sub")
      .addEdge("sub", "tail")
      .addEdge("tail", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "nested" } };

    const result = await graph.invoke({}, config);
    const outer = await graph.getState(config, { subgraphs: true });

    // `imerge` never ran, but the parent has no waiting edge of its own and no
    // pending task to descend into, so the snapshot reports a finished run.
    // A snapshot describes one namespace; the subgraph's own checkpoint holds
    // the unreleased edge.
    expect(result.ran).toEqual(["ia", "tail"]);
    expect(outer.next).toEqual([]);
    expect(outer.tasks).toEqual([]);
    expect(outer.waitingEdges).toBeUndefined();
  });

  it("reports a final incomplete pass even though earlier passes released", async () => {
    // `merge` runs on the complete passes; the last pass selects only `a`, so
    // the edge re-arms and never releases. The entry means "these writes were
    // dropped", not "merge never ran".
    const graph = new StateGraph(State)
      .addNode("fan", (state) => ({ ran: ["fan"], targets: state.targets }))
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("merge", mark("merge"))
      .addEdge(START, "fan")
      .addConditionalEdges(
        "fan",
        (state) =>
          state.ran.filter((entry) => entry === "merge").length < 1
            ? ["a", "b"]
            : ["a"],
        ["a", "b"]
      )
      .addEdge(["a", "b"], "merge")
      .addConditionalEdges(
        "merge",
        (state) =>
          state.ran.filter((entry) => entry === "merge").length < 2
            ? "fan"
            : END,
        ["fan", END]
      )
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "looped" } };

    const result = await graph.invoke({}, config);
    const snapshot = await graph.getState(config);

    expect(result.ran).toContain("merge");
    expect(snapshot.waitingEdges).toEqual([
      { target: "merge", completed: ["a"], missing: ["b"] },
    ]);
  });

  it("reports the edge even when a Send reached the target directly", async () => {
    const graph = new StateGraph(State)
      .addNode(
        "route",
        () => new Command({ goto: ["a", new Send("merge", {})] }),
        { ends: ["a", "b", "merge"] }
      )
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("merge", mark("merge"))
      .addEdge(START, "route")
      .addEdge(["a", "b"], "merge")
      .addEdge("merge", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "sent" } };

    const result = await graph.invoke({}, config);
    const snapshot = await graph.getState(config);

    expect(result.ran).toEqual(["a", "merge"]);
    expect(snapshot.waitingEdges).toEqual([
      { target: "merge", completed: ["a"], missing: ["b"] },
    ]);
  });

  it("reports two edges into the same target separately", async () => {
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("c", mark("c"))
      .addNode("d", mark("d"))
      .addNode("merge", mark("merge"))
      .addConditionalEdges(START, () => ["a", "c"], ["a", "b", "c", "d"])
      .addEdge(["a", "b"], "merge")
      .addEdge(["c", "d"], "merge")
      .addEdge("merge", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "two-edges" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config);

    expect(snapshot.waitingEdges).toEqual([
      { target: "merge", completed: ["a"], missing: ["b"] },
      { target: "merge", completed: ["c"], missing: ["d"] },
    ]);
  });

  it("leaves next non-empty when a listed node failed and is retryable", async () => {
    // A failed node keeps its place in `next`, so the armed edge does not read
    // as a run that ended: the retry can still release it.
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode(
        "b",
        () => {
          throw new Error("b is flaky");
        },
        { retryPolicy: { maxAttempts: 2, initialInterval: 1 } }
      )
      .addNode("merge", mark("merge"))
      .addEdge(START, "a")
      .addEdge(START, "b")
      .addEdge(["a", "b"], "merge")
      .addEdge("merge", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "retried" } };

    await expect(graph.invoke({}, config)).rejects.toThrow("b is flaky");
    const snapshot = await graph.getState(config);

    expect(snapshot.next).toEqual(["b"]);
    expect(snapshot.waitingEdges).toEqual([
      { target: "merge", completed: ["a"], missing: ["b"] },
    ]);
  });

  it("is present on historical snapshots too", async () => {
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("merge", mark("merge"))
      .addConditionalEdges(START, (state) => state.targets, ["a", "b"])
      .addEdge(["a", "b"], "merge")
      .addEdge("merge", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "history" } };

    await graph.invoke({ targets: ["a"] }, config);

    const history = [];
    for await (const snapshot of graph.getStateHistory(config)) {
      history.push(snapshot);
    }
    expect(history[0].waitingEdges).toEqual([
      { target: "merge", completed: ["a"], missing: ["b"] },
    ]);
  });
});
