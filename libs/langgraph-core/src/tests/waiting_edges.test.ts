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
  const nestedGraph = () => {
    const inner = new StateGraph(State)
      .addNode("ia", mark("ia"))
      .addNode("ib", mark("ib"))
      .addNode("imerge", mark("imerge"))
      .addConditionalEdges(START, () => ["ia"], ["ia", "ib"])
      .addEdge(["ia", "ib"], "imerge")
      .addEdge("imerge", END)
      .compile();

    return new StateGraph(State)
      .addNode("sub", inner)
      .addNode("tail", mark("tail"))
      .addEdge(START, "sub")
      .addEdge("sub", "tail")
      .addEdge("tail", END)
      .compile({ checkpointer: new MemorySaver() });
  };

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

  it("reports the edge while interrupted, and clears it on resume", async () => {
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

  it("surfaces an unreleased edge inside a subgraph when subgraphs is requested", async () => {
    const graph = nestedGraph();
    const config = { configurable: { thread_id: "nested" } };

    const result = await graph.invoke({}, config);
    const snapshot = await graph.getState(config, { subgraphs: true });

    // `imerge` never ran inside the subgraph, while the parent itself finished.
    expect(result.ran).toEqual(["ia", "tail"]);
    expect(snapshot.next).toEqual([]);
    expect(snapshot.waitingEdges).toHaveLength(1);

    const [edge] = snapshot.waitingEdges ?? [];
    expect(edge.target).toBe("imerge");
    expect(edge.completed).toEqual(["ia"]);
    expect(edge.path).toEqual(["sub"]);
    expect(edge.namespace).toMatch(/^sub:/);
    // Read out of the channel name, which encodes the listed nodes — the parent
    // holds none of the subgraph's channel definitions.
    expect(edge.missing).toEqual(["ib"]);
  });

  it("leaves a nested edge alone unless subgraphs is requested", async () => {
    const graph = nestedGraph();
    const config = { configurable: { thread_id: "nested-optout" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config);

    expect(snapshot.waitingEdges).toBeUndefined();
    expect("waitingEdges" in snapshot).toBe(false);
  });

  it("reports both levels in one snapshot, each with its missing", async () => {
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
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("merge", mark("merge"))
      .addConditionalEdges(START, () => ["sub", "a"], ["sub", "a", "b"])
      .addEdge(["a", "b"], "merge")
      .addEdge("merge", END)
      .addEdge("sub", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "both-levels" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config, { subgraphs: true });

    const own = snapshot.waitingEdges?.find((e) => e.namespace === undefined);
    const nested = snapshot.waitingEdges?.find((e) => e.namespace !== undefined);

    expect(own).toEqual({
      target: "merge",
      completed: ["a"],
      missing: ["b"],
    });
    expect(nested?.target).toBe("imerge");
    expect(nested?.missing).toEqual(["ib"]);
  });

  it("reports a looped subgraph's edge once, not once per invocation", async () => {
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
      .addNode("loop", (state) => ({ ran: ["loop"], targets: state.targets }))
      .addEdge(START, "sub")
      .addEdge("sub", "loop")
      .addConditionalEdges(
        "loop",
        (state) =>
          state.ran.filter((entry) => entry === "loop").length < 4
            ? "sub"
            : END,
        ["sub", END]
      )
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "looped-subgraph" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config, { subgraphs: true });

    // A fresh task-scoped namespace per invocation would otherwise make the
    // entry count track run length instead of graph size.
    expect(snapshot.waitingEdges).toHaveLength(1);
    expect(snapshot.waitingEdges?.[0].target).toBe("imerge");
  });

  it("names the node path two levels down, without the per-run task ids", async () => {
    const deepest = new StateGraph(State)
      .addNode("da", mark("da"))
      .addNode("db", mark("db"))
      .addNode("dmerge", mark("dmerge"))
      .addConditionalEdges(START, () => ["da"], ["da", "db"])
      .addEdge(["da", "db"], "dmerge")
      .addEdge("dmerge", END)
      .compile();

    const middle = new StateGraph(State)
      .addNode("deep", deepest)
      .addNode("mtail", mark("mtail"))
      .addEdge(START, "deep")
      .addEdge("deep", "mtail")
      .addEdge("mtail", END)
      .compile();

    const graph = new StateGraph(State)
      .addNode("mid", middle)
      .addNode("tail", mark("tail"))
      .addEdge(START, "mid")
      .addEdge("mid", "tail")
      .addEdge("tail", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "two-levels" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config, { subgraphs: true });

    expect(snapshot.waitingEdges).toHaveLength(1);
    const [edge] = snapshot.waitingEdges ?? [];
    expect(edge.target).toBe("dmerge");
    expect(edge.path).toEqual(["mid", "deep"]);
    // The namespace carries task ids, so only its shape can be asserted.
    expect(edge.namespace).toMatch(/^mid:[^|]+\|deep:/);
  });

  it("reports an unreleased edge into a deferred target", async () => {
    // `defer: true` swaps the barrier for its after-finish variant, which stores
    // the seen set beside a finished flag rather than on its own.
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("merge", mark("merge"), { defer: true })
      .addConditionalEdges(START, (state) => state.targets, ["a", "b"])
      .addEdge(["a", "b"], "merge")
      .addEdge("merge", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "deferred" } };

    const result = await graph.invoke({ targets: ["a"] }, config);
    const snapshot = await graph.getState(config);

    expect(result.ran).toEqual(["a"]);
    expect(snapshot.waitingEdges).toEqual([
      { target: "merge", completed: ["a"], missing: ["b"] },
    ]);
  });

  it("reports a deferred target inside a subgraph", async () => {
    const inner = new StateGraph(State)
      .addNode("ia", mark("ia"))
      .addNode("ib", mark("ib"))
      .addNode("imerge", mark("imerge"), { defer: true })
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
    const config = { configurable: { thread_id: "deferred-nested" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config, { subgraphs: true });

    expect(snapshot.waitingEdges).toEqual([
      {
        target: "imerge",
        completed: ["ia"],
        missing: ["ib"],
        namespace: expect.stringMatching(/^sub:/),
        path: ["sub"],
      },
    ]);
  });

  it("does not report a nested edge that has every write and is waiting for its target", async () => {
    // The subgraph is paused before its join target, so the barrier holds both
    // writes: ready, not stalled. Reporting it would make every pause inside a
    // subgraph look like a drop — the nested half of the same guard the parent's
    // own edges get.
    const inner = new StateGraph(State)
      .addNode("ia", mark("ia"))
      .addNode("ib", mark("ib"))
      .addNode("imerge", mark("imerge"))
      .addEdge(START, "ia")
      .addEdge(START, "ib")
      .addEdge(["ia", "ib"], "imerge")
      .addEdge("imerge", END)
      .compile({ interruptBefore: ["imerge"] });

    const graph = new StateGraph(State)
      .addNode("sub", inner)
      .addNode("tail", mark("tail"))
      .addEdge(START, "sub")
      .addEdge("sub", "tail")
      .addEdge("tail", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "nested-ready" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config, { subgraphs: true });

    expect(snapshot.waitingEdges).toBeUndefined();
  });

  it("omits missing when a listed node's name makes the channel name ambiguous", async () => {
    // The channel name joins the listed nodes with `+`, which is not reserved in
    // node names: `["a+b", "c"]` and `["a", "b+c"]` both spell `join:a+b+c:…`.
    // The parse is checked against what the barrier holds, and `a+b` is not in
    // it, so no set is reported rather than the wrong one.
    const inner = new StateGraph(State)
      .addNode("a+b", mark("a+b"))
      .addNode("c", mark("c"))
      .addNode("imerge", mark("imerge"))
      .addConditionalEdges(START, () => ["a+b"], ["a+b", "c"])
      .addEdge(["a+b", "c"], "imerge")
      .addEdge("imerge", END)
      .compile();

    const graph = new StateGraph(State)
      .addNode("sub", inner)
      .addNode("tail", mark("tail"))
      .addEdge(START, "sub")
      .addEdge("sub", "tail")
      .addEdge("tail", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "ambiguous" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config, { subgraphs: true });

    expect(snapshot.waitingEdges).toHaveLength(1);
    const [edge] = snapshot.waitingEdges ?? [];
    expect(edge.target).toBe("imerge");
    expect(edge.completed).toEqual(["a+b"]);
    expect(edge.missing).toBeUndefined();
  });

  it("does not list the thread for a graph that has no subgraph node", async () => {
    // The nested walk costs a `list()` over the thread, which is O(checkpoints).
    // A graph with no subgraph node has no child namespaces to find, so asking
    // for `subgraphs: true` should not pay for the search.
    const saver = new MemorySaver();
    let listCalls = 0;
    const list = saver.list.bind(saver);
    saver.list = ((...args: Parameters<typeof list>) => {
      listCalls += 1;
      return list(...args);
    }) as typeof saver.list;

    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("merge", mark("merge"))
      .addConditionalEdges(START, (state) => state.targets, ["a", "b"])
      .addEdge(["a", "b"], "merge")
      .addEdge("merge", END)
      .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: "no-subgraphs" } };

    await graph.invoke({ targets: ["a"] }, config);
    const snapshot = await graph.getState(config, { subgraphs: true });

    expect(listCalls).toBe(0);
    // And the graph's own edge is still reported.
    expect(snapshot.waitingEdges).toEqual([
      { target: "merge", completed: ["a"], missing: ["b"] },
    ]);
  });

  it("collects a nested edge through a saver other than the in-memory one", async () => {
    // The nested walk leans on `list()` returning a namespace's newest checkpoint
    // first, which is a saver contract rather than a MemorySaver detail.
    const { SqliteSaver } = await import(
      "@langchain/langgraph-checkpoint-sqlite"
    );
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
      .compile({ checkpointer: SqliteSaver.fromConnString(":memory:") });
    const config = { configurable: { thread_id: "sqlite" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config, { subgraphs: true });

    expect(snapshot.waitingEdges).toEqual([
      {
        target: "imerge",
        completed: ["ia"],
        missing: ["ib"],
        namespace: expect.stringMatching(/^sub:/),
        path: ["sub"],
      },
    ]);
  });

  it("reports sibling subgraphs separately", async () => {
    const stalled = (prefix: string) =>
      new StateGraph(State)
        .addNode(`${prefix}a`, mark(`${prefix}a`))
        .addNode(`${prefix}b`, mark(`${prefix}b`))
        .addNode(`${prefix}merge`, mark(`${prefix}merge`))
        .addConditionalEdges(START, () => [`${prefix}a`], [
          `${prefix}a`,
          `${prefix}b`,
        ])
        .addEdge([`${prefix}a`, `${prefix}b`], `${prefix}merge`)
        .addEdge(`${prefix}merge`, END)
        .compile();

    const graph = new StateGraph(State)
      .addNode("first", stalled("x"))
      .addNode("second", stalled("y"))
      .addNode("tail", mark("tail"))
      .addEdge(START, "first")
      .addEdge(START, "second")
      .addEdge(["first", "second"], "tail")
      .addEdge("tail", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "siblings" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config, { subgraphs: true });

    expect(snapshot.waitingEdges?.map((edge) => edge.target).sort()).toEqual([
      "xmerge",
      "ymerge",
    ]);
  });

  it("does not report an edge that has every write and is waiting for its target", async () => {
    // Paused before `merge`, so the edge holds both writes and is ready rather
    // than stalled. Reporting it here would make every pause look like a drop.
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("merge", mark("merge"))
      .addEdge(START, "a")
      .addEdge(START, "b")
      .addEdge(["a", "b"], "merge")
      .addEdge("merge", END)
      .compile({
        checkpointer: new MemorySaver(),
        interruptBefore: ["merge"],
      });
    const config = { configurable: { thread_id: "ready" } };

    await graph.invoke({}, config);
    const snapshot = await graph.getState(config);

    expect(snapshot.next).toEqual(["merge"]);
    expect(snapshot.waitingEdges).toBeUndefined();
  });

  it("agrees with the subgraph's own definitions about what is missing", async () => {
    const graph = nestedGraph();
    const config = { configurable: { thread_id: "ask-the-child" } };

    await graph.invoke({}, config);
    const fromParent = await graph.getState(config, { subgraphs: true });
    const childNamespace = fromParent.waitingEdges?.[0].namespace;

    // Two independent derivations of the same set: the parent parses the channel
    // name, the subgraph reads its own channel definitions. They must agree, or
    // the parse is wrong.
    const fromChild = await graph.getState(
      { configurable: { ...config.configurable, checkpoint_ns: childNamespace } },
      { subgraphs: true }
    );

    expect(fromParent.waitingEdges?.[0].missing).toEqual(["ib"]);
    expect(fromChild.waitingEdges).toEqual([
      { target: "imerge", completed: ["ia"], missing: ["ib"] },
    ]);
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

  it("reports a subgraph's earlier stall even though a later invocation released", async () => {
    // The subgraph waits for both on the second pass and only for `ia` on the
    // first, so one invocation drops a write and the next does not. A released
    // barrier stores an empty seen set, so only the stalled invocation is a
    // candidate and the entry survives the per-path dedupe.
    const inner = new StateGraph(State)
      .addNode("ia", mark("ia"))
      .addNode("ib", mark("ib"))
      .addNode("imerge", mark("imerge"))
      .addConditionalEdges(
        START,
        (state) => (state.ran.includes("loop") ? ["ia", "ib"] : ["ia"]),
        ["ia", "ib"]
      )
      .addEdge(["ia", "ib"], "imerge")
      .addEdge("imerge", END)
      .compile();

    const graph = new StateGraph(State)
      .addNode("sub", inner)
      .addNode("loop", mark("loop"))
      .addEdge(START, "sub")
      .addEdge("sub", "loop")
      .addConditionalEdges(
        "loop",
        (state) =>
          state.ran.filter((entry) => entry === "loop").length < 2
            ? "sub"
            : END,
        ["sub", END]
      )
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "stalled-then-released" } };

    const result = await graph.invoke({}, config);
    const snapshot = await graph.getState(config, { subgraphs: true });

    expect(result.ran).toContain("imerge");
    expect(snapshot.waitingEdges).toHaveLength(1);
    expect(snapshot.waitingEdges?.[0].target).toBe("imerge");
    expect(snapshot.waitingEdges?.[0].completed).toEqual(["ia"]);
    expect(snapshot.waitingEdges?.[0].path).toEqual(["sub"]);
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

  it("reports the edge when a listed node failed after its sibling's write landed", async () => {
    // A failed node keeps its place in `next`, so the unreleased edge does not read as
    // a run that ended: the retry can still release it. What makes the edge
    // visible is that `a`'s write to it was persisted before the run unwound —
    // see the next test for the case where it was not.
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

  it("reports nothing when the sibling's write did not survive the failure", async () => {
    // Same graph without a retry policy, and the outcome differs: `a`'s write to
    // the edge is not among the checkpoint's pending writes, so the barrier never
    // saw it. Nothing was dropped — `a` runs again on resume — and reporting an
    // edge here would be reporting a write that does not exist.
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", () => {
        throw new Error("b is broken");
      })
      .addNode("merge", mark("merge"))
      .addEdge(START, "a")
      .addEdge(START, "b")
      .addEdge(["a", "b"], "merge")
      .addEdge("merge", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "unretried" } };

    await expect(graph.invoke({}, config)).rejects.toThrow("b is broken");
    const snapshot = await graph.getState(config);

    expect(snapshot.next).toEqual(["b"]);
    expect(snapshot.waitingEdges).toBeUndefined();
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
