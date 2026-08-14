import { it, expect, describe } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation, StateGraph } from "../graph/index.js";
import { START, END, Send, Command } from "../constants.js";
import { interrupt } from "../interrupt.js";
import { waitingEdgeRelease } from "../waiting_edge_release.js";
import { RunControl } from "../pregel/runtime.js";

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

  it("an interrupt at the release point does not read as a finished run", async () => {
    // Found by fuzzing: interruptAfter can land on the quiescent superstep,
    // where nothing is scheduled and the edge is armed. Empty `next` is the
    // documented end-of-run signal, so the armed edge must put its target
    // there — it will run, at latest when the resumed run settles.
    const graph = new StateGraph(State)
      .addNode("w0", mark("w0"))
      .addNode("w1", mark("w1"))
      .addNode("w2", mark("w2"))
      .addNode("join", mark("join"))
      .addConditionalEdges(START, () => ["w1", "w2"], ["w0", "w1", "w2"])
      .addEdge(["w1", "w0", "w2"], "join", { inclusive: true })
      .addEdge("join", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = {
      configurable: { thread_id: "parked-at-release" },
      interruptAfter: ["w1" as const],
    };

    await graph.invoke({}, config);
    const paused = await graph.getState(config);
    expect(paused.next).toEqual(["join"]);
    expect(paused.waitingEdges).toEqual([
      { target: "join", completed: ["w1", "w2"], missing: ["w0"] },
    ]);

    const result = (await graph.invoke(null, config)) as { ran: string[] };
    expect(result.ran).toEqual(["w1", "w2", "join"]);
    const done = await graph.getState(config);
    expect(done.next).toEqual([]);
    expect(done.waitingEdges).toBeUndefined();
  });

  it("a listed node that completes twice re-arms the edge — once per arming", async () => {
    // Found by fuzzing: w1 is triggered by the entry AND by a chain from w0,
    // so it completes in two supersteps. The first completeness releases the
    // edge; the second w1 re-arms it; quiescence releases it again. Two runs
    // for two armings — the default barrier's accumulation rule, without the
    // final drop.
    const graph = new StateGraph(State)
      .addNode("w0", mark("w0"))
      .addNode("w1", mark("w1"))
      .addNode("join", mark("join"))
      .addConditionalEdges(START, () => ["w0", "w1"], ["w0", "w1"])
      .addEdge("w0", "w1")
      .addEdge(["w0", "w1"], "join", { inclusive: true })
      .addEdge("join", END)
      .compile();

    const result = (await graph.invoke({})) as { ran: string[] };

    expect(count(result.ran, "w1")).toBe(2);
    expect(count(result.ran, "join")).toBe(2);
  });

  it("a fork from the pre-release checkpoint releases once in the fork", async () => {
    // Time travel: the armed checkpoint is in history (with `next` naming the
    // target); re-running from it releases again, once, in the fork only.
    const graph = new StateGraph(State)
      .addNode("w0", mark("w0"))
      .addNode("w1", mark("w1"))
      .addNode("w2", mark("w2"))
      .addNode("join", mark("join"))
      .addConditionalEdges(START, () => ["w1", "w2"], ["w0", "w1", "w2"])
      .addEdge(["w1", "w0", "w2"], "join", { inclusive: true })
      .addEdge("join", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "fork-armed" } };

    await graph.invoke({}, config);
    let armedId: string | undefined;
    for await (const snapshot of graph.getStateHistory(config)) {
      if (snapshot.waitingEdges?.length) {
        expect(snapshot.next).toEqual(["join"]);
        armedId = snapshot.config.configurable?.checkpoint_id as string;
        break;
      }
    }
    expect(armedId).toBeDefined();

    const fork = (await graph.invoke(null, {
      configurable: { thread_id: "fork-armed", checkpoint_id: armedId },
    })) as { ran: string[] };
    expect(count(fork.ran, "join")).toBe(1);
  });

  it("updateState as the missing node completes the barrier — join runs once, not twice", async () => {
    // The manual write and the quiescence release must not stack: once the
    // barrier is complete, the edge fires through completeness alone.
    const graph = new StateGraph(State)
      .addNode("w0", mark("w0"))
      .addNode("w1", mark("w1"))
      .addNode("w2", mark("w2"))
      .addNode("join", mark("join"))
      .addConditionalEdges(START, () => ["w1", "w2"], ["w0", "w1", "w2"])
      .addEdge(["w1", "w0", "w2"], "join", { inclusive: true })
      .addEdge("join", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = {
      configurable: { thread_id: "update-missing" },
      interruptAfter: ["w1" as const],
    };

    await graph.invoke({}, config);
    await graph.updateState(
      { configurable: { thread_id: "update-missing" } },
      { ran: ["w0-manual"] },
      "w0"
    );
    const afterUpdate = await graph.getState({
      configurable: { thread_id: "update-missing" },
    });
    expect(afterUpdate.waitingEdges).toBeUndefined();
    expect(afterUpdate.next).toEqual(["join"]);

    const result = (await graph.invoke(null, {
      configurable: { thread_id: "update-missing" },
    })) as { ran: string[] };
    expect(count(result.ran, "join")).toBe(1);
  });

  it("an unrelated updateState keeps the edge armed and `next` naming the target", async () => {
    const graph = new StateGraph(State)
      .addNode("w0", mark("w0"))
      .addNode("w1", mark("w1"))
      .addNode("w2", mark("w2"))
      .addNode("join", mark("join"))
      .addConditionalEdges(START, () => ["w1", "w2"], ["w0", "w1", "w2"])
      .addEdge(["w1", "w0", "w2"], "join", { inclusive: true })
      .addEdge("join", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = {
      configurable: { thread_id: "update-unrelated" },
      interruptAfter: ["w1" as const],
    };

    await graph.invoke({}, config);
    await graph.updateState(
      { configurable: { thread_id: "update-unrelated" } },
      { ran: ["annotation"] },
      "join"
    );
    const afterUpdate = await graph.getState({
      configurable: { thread_id: "update-unrelated" },
    });
    expect(afterUpdate.waitingEdges).toEqual([
      { target: "join", completed: ["w1", "w2"], missing: ["w0"] },
    ]);
    expect(afterUpdate.next).toEqual(["join"]);

    const result = (await graph.invoke(null, {
      configurable: { thread_id: "update-unrelated" },
    })) as { ran: string[] };
    expect(count(result.ran, "join")).toBe(1);
  });

  it("the released target can tell a partial release from a full one", async () => {
    // AC4.4: `waitingEdgeRelease()` names the arrived and missing nodes on a
    // quiescence release, and returns undefined when the edge released
    // through ordinary completeness.
    const observed: Array<unknown> = [];
    const build = (selection: string[]) =>
      new StateGraph(State)
        .addNode("w0", mark("w0"))
        .addNode("w1", mark("w1"))
        .addNode("join", () => {
          observed.push(waitingEdgeRelease());
          return { ran: ["join"] };
        })
        .addConditionalEdges(START, () => selection, ["w0", "w1"])
        .addEdge(["w0", "w1"], "join", { inclusive: true })
        .addEdge("join", END)
        .compile();

    await build(["w1"]).invoke({});
    await build(["w0", "w1"]).invoke({});

    expect(observed).toEqual([
      { target: "join", arrived: ["w1"], missing: ["w0"] },
      undefined,
    ]);
  });

  it("the release record survives an interruptBefore on the released target", async () => {
    // The record is derived from the barrier, not captured in memory, so a
    // pause between the release and the target's superstep cannot lose it.
    const observed: Array<unknown> = [];
    const graph = new StateGraph(State)
      .addNode("w0", mark("w0"))
      .addNode("w1", mark("w1"))
      .addNode("join", () => {
        observed.push(waitingEdgeRelease());
        return { ran: ["join"] };
      })
      .addConditionalEdges(START, () => "w1", ["w0", "w1"])
      .addEdge(["w0", "w1"], "join", { inclusive: true })
      .addEdge("join", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = {
      configurable: { thread_id: "release-record-interrupt" },
      interruptBefore: ["join" as const],
    };

    await graph.invoke({}, config);
    expect(observed).toEqual([]);
    const paused = await graph.getState({
      configurable: { thread_id: "release-record-interrupt" },
    });
    expect(paused.next).toEqual(["join"]);

    await graph.invoke(null, {
      configurable: { thread_id: "release-record-interrupt" },
    });
    expect(observed).toEqual([
      { target: "join", arrived: ["w1"], missing: ["w0"] },
    ]);
  });

  it("a drain at the release point reports a resumable stop, not a finished run", async () => {
    // Found by probing the drain exit: without the guard, a drain landing on
    // the quiescent superstep resolved the run with the join silently dropped
    // — the original disease through a different door. An armed inclusive
    // edge is remaining work, so the drain must surface as one.
    const control = new RunControl();
    const graph = new StateGraph(State)
      .addNode("w0", mark("w0"))
      .addNode("w1", mark("w1"))
      .addNode("drainer", () => {
        control.requestDrain();
        return { ran: ["drainer"] };
      })
      .addNode("join", mark("join"))
      .addConditionalEdges(START, () => ["w1", "drainer"], [
        "w0",
        "w1",
        "drainer",
      ])
      .addEdge(["w0", "w1"], "join", { inclusive: true })
      .addEdge("join", END)
      .addEdge("drainer", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "drain-at-release" } };

    await expect(graph.invoke({}, { ...config, control })).rejects.toThrow(
      /Graph drained/
    );
    const paused = await graph.getState(config);
    expect(paused.next).toEqual(["join"]);
    expect(paused.waitingEdges).toEqual([
      { target: "join", completed: ["w1"], missing: ["w0"] },
    ]);

    const result = (await graph.invoke(null, config)) as { ran: string[] };
    expect(result.ran).toEqual(["drainer", "w1", "join"]);
  });

  it("two inclusive edges into one target: one run, and the record is their union", async () => {
    // Found by the four-hats red team: both barriers release at the same
    // quiescence and trigger ONE task; the first version of the record kept
    // only the first edge's arrivals.
    const observed: Array<unknown> = [];
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("c", mark("c"))
      .addNode("d", mark("d"))
      .addNode("join", () => {
        observed.push(waitingEdgeRelease());
        return { ran: ["join"] };
      })
      .addConditionalEdges(START, () => ["a", "c"], ["a", "b", "c", "d"])
      .addEdge(["a", "b"], "join", { inclusive: true })
      .addEdge(["c", "d"], "join", { inclusive: true })
      .addEdge("join", END)
      .compile();

    const result = (await graph.invoke({})) as { ran: string[] };

    expect(count(result.ran, "join")).toBe(1);
    expect(observed).toEqual([
      { target: "join", arrived: ["a", "c"], missing: ["b", "d"] },
    ]);
  });

  it("a Send straight at the armed target runs it separately — edges, not sends", async () => {
    const graph = new StateGraph(State)
      .addNode("w0", mark("w0"))
      .addNode("w1", mark("w1"))
      .addNode("sender", mark("sender"))
      .addNode("join", mark("join"))
      .addConditionalEdges(START, () => ["w1", "sender"], [
        "w0",
        "w1",
        "sender",
      ])
      .addConditionalEdges("sender", () => [new Send("join", {})], ["join"])
      .addEdge(["w0", "w1"], "join", { inclusive: true })
      .addEdge("join", END)
      .compile();

    const result = (await graph.invoke({})) as { ran: string[] };

    expect(count(result.ran, "join")).toBe(2);
  });

  it("removing the option later leaves an armed thread honest, not corrupt", async () => {
    // Found by the four-hats red team: the inclusive barrier checkpoints
    // [seen, released]; before the restore tolerance, resuming without the
    // flag fed the tuple to the default barrier, whose seen became a set of
    // garbage — unreleasable AND invisible to waitingEdges.
    const saver = new MemorySaver();
    let boom = true;
    const build = (inclusive: boolean) =>
      new StateGraph(State)
        .addNode("w0", mark("w0"))
        .addNode("w1", mark("w1"))
        .addNode("mid", mark("mid"))
        .addNode("holder", () => {
          if (boom) {
            boom = false;
            throw new Error("boom");
          }
          return { ran: ["holder"] };
        })
        .addNode("join", mark("join"))
        .addConditionalEdges(START, () => ["w1", "mid"], ["w0", "w1", "mid"])
        .addEdge("mid", "holder")
        .addEdge(
          ["w0", "w1"],
          "join",
          inclusive ? { inclusive: true } : undefined
        )
        .addEdge("join", END)
        .addEdge("holder", END)
        .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: "downgrade-honest" } };

    await expect(build(true).invoke({}, config)).rejects.toThrow("boom");

    // resumed WITHOUT the flag: default semantics from here — the edge waits
    // for all, the run resolves, and the snapshot reports the drop honestly
    const downgraded = build(false);
    const result = (await downgraded.invoke(null, config)) as {
      ran: string[];
    };
    expect(count(result.ran, "join")).toBe(0);
    const final = await downgraded.getState(config);
    expect(final.waitingEdges).toEqual([
      { target: "join", completed: ["w1"], missing: ["w0"] },
    ]);
  });

  it("adding the option to an existing armed thread releases on resume", async () => {
    const saver = new MemorySaver();
    let boom = true;
    const build = (inclusive: boolean) =>
      new StateGraph(State)
        .addNode("w0", mark("w0"))
        .addNode("w1", mark("w1"))
        .addNode("mid", mark("mid"))
        .addNode("holder", () => {
          if (boom) {
            boom = false;
            throw new Error("boom");
          }
          return { ran: ["holder"] };
        })
        .addNode("join", mark("join"))
        .addConditionalEdges(START, () => ["w1", "mid"], ["w0", "w1", "mid"])
        .addEdge("mid", "holder")
        .addEdge(
          ["w0", "w1"],
          "join",
          inclusive ? { inclusive: true } : undefined
        )
        .addEdge("join", END)
        .addEdge("holder", END)
        .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: "upgrade-releases" } };

    await expect(build(false).invoke({}, config)).rejects.toThrow("boom");

    const upgraded = build(true);
    const result = (await upgraded.invoke(null, config)) as { ran: string[] };
    expect(count(result.ran, "join")).toBe(1);
    const final = await upgraded.getState(config);
    expect(final.waitingEdges).toBeUndefined();
  });

  it("two inclusive edges listing each other's targets never settle", async () => {
    // The OR-join vicious circle: each release re-arms the other edge, so the
    // graph livelocks and ends at the recursion limit — where the same shape
    // with default edges stalls silently. An error beats a silent stall, but
    // the shape itself is a modelling error; pinned so a change to this
    // outcome is a decision.
    const graph = new StateGraph(State)
      .addNode("a", mark("a"))
      .addNode("b", mark("b"))
      .addNode("j1", mark("j1"))
      .addNode("j2", mark("j2"))
      .addConditionalEdges(START, () => "a", ["a", "b"])
      .addEdge(["a", "j2"], "j1", { inclusive: true })
      .addEdge(["b", "j1"], "j2", { inclusive: true })
      .addEdge("j1", END)
      .addEdge("j2", END)
      .compile();

    await expect(
      graph.invoke({}, { recursionLimit: 25 })
    ).rejects.toThrow(/Recursion limit/);
  });
});
