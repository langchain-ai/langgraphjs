import { it, expect, describe } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation, StateGraph } from "../graph/index.js";
import { START, END, Send, Command } from "../constants.js";
import { interrupt } from "../interrupt.js";

const State = Annotation.Root({
  ran: Annotation<string[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  picked: Annotation<string[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),
});

const mark = (name: string) => () => ({ ran: [name] });
const count = (ran: string[], name: string) =>
  ran.filter((entry) => entry === name).length;

describe("inclusive waiting edges", () => {
  it("runs the target once with the arrived subset, where the default drops the writes", async () => {
    // The #2666 shape: a conditional selects one of two listed nodes. The
    // default waiting edge never releases and the run resolves with the
    // arrived write discarded; the inclusive edge runs the target once.
    const build = (inclusive: boolean) =>
      new StateGraph(State)
        .addNode("a", mark("a"))
        .addNode("b", mark("b"))
        .addNode("c", mark("c"))
        .addNode("d", mark("d"))
        .addConditionalEdges(START, () => "a", ["a", "b"])
        .addEdge(["a", "b"], "c", inclusive ? { inclusive: true } : undefined)
        .addEdge("c", "d")
        .addEdge("d", END)
        .compile();

    const kept = (await build(false).invoke({})) as { ran: string[] };
    const released = (await build(true).invoke({})) as { ran: string[] };

    expect(kept.ran).toEqual(["a"]);
    expect(released.ran).toEqual(["a", "c", "d"]);
  });

  it("three listed nodes, one selected — once, with the one that arrived", async () => {
    const graph = new StateGraph(State)
      .addNode("p1", mark("p1"))
      .addNode("p2", mark("p2"))
      .addNode("p3", mark("p3"))
      .addNode("join", mark("join"))
      .addConditionalEdges(START, () => "p2", ["p1", "p2", "p3"])
      .addEdge(["p1", "p2", "p3"], "join", { inclusive: true })
      .addEdge("join", END)
      .compile();

    const result = (await graph.invoke({})) as { ran: string[] };

    expect(result.ran).toEqual(["p2", "join"]);
  });

  it("does not fire early while a listed node is still on its way", async () => {
    // Both branches selected, one a superstep deeper: quiescence is not
    // reached while `mid -> p2` is pending, so the edge releases through
    // ordinary completeness, exactly once, after p2.
    const graph = new StateGraph(State)
      .addNode("p1", mark("p1"))
      .addNode("mid", mark("mid"))
      .addNode("p2", mark("p2"))
      .addNode("join", mark("join"))
      .addEdge(START, "p1")
      .addEdge(START, "mid")
      .addEdge("mid", "p2")
      .addEdge(["p1", "p2"], "join", { inclusive: true })
      .addEdge("join", END)
      .compile();

    const result = (await graph.invoke({})) as { ran: string[] };

    expect(count(result.ran, "join")).toBe(1);
    expect(result.ran.indexOf("p2")).toBeLessThan(result.ran.indexOf("join"));
  });

  it("a Send to a listed node holds the release — the target runs exactly once", async () => {
    // The case that killed the two earlier release designs: a conditional
    // skips p2, then a Send delivers it a superstep later. The Send is a
    // pending task, so there is no quiescence to release at; the barrier
    // completes normally and the target runs once.
    const graph = new StateGraph(State)
      .addNode("p1", mark("p1"))
      .addNode("late", mark("late"))
      .addNode("p2", mark("p2"))
      .addNode("join", mark("join"))
      .addEdge(START, "p1")
      .addEdge(START, "late")
      .addConditionalEdges("late", () => [new Send("p2", {})], ["p2"])
      .addEdge(["p1", "p2"], "join", { inclusive: true })
      .addEdge("join", END)
      .compile();

    const result = (await graph.invoke({})) as { ran: string[] };

    expect(count(result.ran, "join")).toBe(1);
    expect(result.ran.indexOf("p2")).toBeLessThan(result.ran.indexOf("join"));
  });

  it("branches at different depths: once at every selection mix", async () => {
    // The uneven-branch pipeline: transcribe is a step deeper than its
    // siblings. The inclusive waiting edge runs the fan-in once whatever the
    // router selected, at any mix of branch depths.
    const build = () =>
      new StateGraph(State)
        .addNode("ocr", mark("ocr"))
        .addNode("transcribe", mark("transcribe"))
        .addNode("diarize", mark("diarize"))
        .addNode("translate", mark("translate"))
        .addNode("index", mark("index"))
        .addConditionalEdges(START, (state) => state.picked, [
          "ocr",
          "transcribe",
          "translate",
        ])
        .addEdge("transcribe", "diarize")
        .addEdge(["ocr", "diarize", "translate"], "index", { inclusive: true })
        .addEdge("index", END)
        .compile();

    const all = (await build().invoke({
      picked: ["ocr", "transcribe", "translate"],
    })) as { ran: string[] };
    const one = (await build().invoke({ picked: ["ocr"] })) as {
      ran: string[];
    };
    const uneven = (await build().invoke({
      picked: ["ocr", "transcribe"],
    })) as { ran: string[] };

    expect(count(all.ran, "index")).toBe(1);
    expect(count(one.ran, "index")).toBe(1);
    expect(count(uneven.ran, "index")).toBe(1);
    // The deep branch is waited for, not raced.
    expect(uneven.ran.indexOf("diarize")).toBeLessThan(
      uneven.ran.indexOf("index")
    );
  });

  it("an edge nobody wrote to stays silent", async () => {
    const graph = new StateGraph(State)
      .addNode("x", mark("x"))
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("c", mark("c"))
      .addConditionalEdges(START, () => "x", ["x", "a", "b"])
      .addEdge(["a", "b"], "c", { inclusive: true })
      .addEdge("c", END)
      .addEdge("x", END)
      .compile();

    const result = (await graph.invoke({})) as { ran: string[] };

    expect(result.ran).toEqual(["x"]);
  });

  it("re-arms in a loop; a final incomplete pass still runs the target once", async () => {
    // Pass 1 selects both listed nodes, so the edge releases through
    // completeness and re-arms. Pass 2 selects only one; the run then
    // quiesces and the re-armed edge releases with that one arrival.
    const graph = new StateGraph(State)
      .addNode("fan", mark("fan"))
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
      .addEdge(["a", "b"], "merge", { inclusive: true })
      .addConditionalEdges(
        "merge",
        (state) =>
          state.ran.filter((entry) => entry === "merge").length < 2
            ? "fan"
            : END,
        ["fan", END]
      )
      .compile();

    const result = (await graph.invoke({})) as { ran: string[] };

    expect(count(result.ran, "merge")).toBe(2);
  });

  it("a cascade of inclusive edges resolves in dependency order", async () => {
    // Releasing j1 wakes the second edge, which then quiesces short of `c`
    // and releases in turn. Each target runs once.
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("c", mark("c"))
      .addNode("j1", mark("j1"))
      .addNode("j2", mark("j2"))
      .addConditionalEdges(START, () => "a", ["a", "b", "c"])
      .addEdge(["a", "b"], "j1", { inclusive: true })
      .addEdge(["j1", "c"], "j2", { inclusive: true })
      .addEdge("j2", END)
      .compile();

    const result = (await graph.invoke({})) as { ran: string[] };

    expect(result.ran).toEqual(["a", "j1", "j2"]);
  });

  it("waits through an interrupt and releases only after the resumed run quiesces", async () => {
    const ran: string[] = [];
    const graph = new StateGraph(State)
      .addNode("a", () => {
        ran.push("a");
        return { ran: ["a"] };
      })
      .addNode("b", () => {
        ran.push("b");
        return { ran: ["b"] };
      })
      .addNode("holder", () => {
        ran.push("holder");
        interrupt("hold");
        return { ran: ["holder"] };
      })
      .addNode("c", () => {
        ran.push("c");
        return { ran: ["c"] };
      })
      .addConditionalEdges(START, () => ["a", "holder"], ["a", "b", "holder"])
      .addEdge(["a", "b"], "c", { inclusive: true })
      .addEdge("c", END)
      .addEdge("holder", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "inclusive-interrupt" } };

    await graph.invoke({}, config);
    const during = count(ran, "c");
    // The paused run still answers a query honestly: the edge is armed.
    const paused = await graph.getState(config);
    expect(paused.waitingEdges).toEqual([
      { target: "c", completed: ["a"], missing: ["b"] },
    ]);

    await graph.invoke(new Command({ resume: "go" }), config);
    const after = count(ran, "c");
    const done = await graph.getState(config);

    expect({ during, after }).toEqual({ during: 0, after: 1 });
    expect(done.waitingEdges).toBeUndefined();
  });

  it("releases inside a subgraph, and the parent continues", async () => {
    const child = new StateGraph(State)
      .addNode("ia", mark("ia"))
      .addNode("ib", mark("ib"))
      .addNode("ijoin", mark("ijoin"))
      .addConditionalEdges(START, () => "ia", ["ia", "ib"])
      .addEdge(["ia", "ib"], "ijoin", { inclusive: true })
      .addEdge("ijoin", END)
      .compile();
    const graph = new StateGraph(State)
      .addNode("sub", child)
      .addNode("after", mark("after"))
      .addEdge(START, "sub")
      .addEdge("sub", "after")
      .addEdge("after", END)
      .compile();

    const result = (await graph.invoke({})) as { ran: string[] };

    expect(result.ran).toEqual(["ia", "ijoin", "after"]);
  });

  it("rejects inclusive together with defer on the target, at compile", () => {
    const builder = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("c", mark("c"), { defer: true })
      .addConditionalEdges(START, () => "a", ["a", "b"])
      .addEdge(["a", "b"], "c", { inclusive: true })
      .addEdge("c", END);

    expect(() => builder.compile()).toThrow(/defer/);
  });

  it("rejects inclusive on a single-start edge", () => {
    const builder = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"));

    expect(() =>
      builder.addEdge("a", "b", { inclusive: true })
    ).toThrow(/array of start nodes/);
  });
});
