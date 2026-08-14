import { it, expect, describe } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import {
  NamedBarrierValue,
  NamedBarrierValueAfterFinish,
} from "./named_barrier_value.js";
import { Annotation, StateGraph } from "../graph/index.js";
import { START, END } from "../constants.js";

describe("barrier checkpoint restore across a defer change", () => {
  it("restores seen from the defer variant's [seen, finished] tuple", () => {
    const withDefer = new NamedBarrierValueAfterFinish<string>(
      new Set(["a", "b"])
    );
    withDefer.update(["a"]);

    const restored = new NamedBarrierValue<string>(
      new Set(["a", "b"])
    ).fromCheckpoint(withDefer.checkpoint());

    expect([...restored.seen]).toEqual(["a"]);
    restored.update(["b"]);
    expect(restored.isAvailable()).toBe(true);
  });

  it("restores seen from the non-defer bare list", () => {
    const withoutDefer = new NamedBarrierValue<string>(new Set(["a", "b"]));
    withoutDefer.update(["a"]);

    const restored = new NamedBarrierValueAfterFinish<string>(
      new Set(["a", "b"])
    ).fromCheckpoint(withoutDefer.checkpoint());

    expect([...restored.seen]).toEqual(["a"]);
    expect(restored.finished).toBe(false);
    restored.update(["b"]);
    expect(restored.finish()).toBe(true);
    expect(restored.isAvailable()).toBe(true);
  });

  const State = Annotation.Root({
    ran: Annotation<string[]>({
      reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
      default: () => [],
    }),
  });
  const mark = (name: string) => () => ({ ran: [name] });

  // w1 writes the barrier in superstep 1; holder fails in superstep 2 (first
  // run only), so the partially seen barrier is checkpointed.
  const build = (defer: boolean, saver: MemorySaver, boom: { on: boolean }) =>
    new StateGraph(State)
      .addNode("w0", mark("w0"))
      .addNode("w1", mark("w1"))
      .addNode("mid", mark("mid"))
      .addNode("holder", () => {
        if (boom.on) {
          boom.on = false;
          throw new Error("boom");
        }
        return { ran: ["holder"] };
      })
      .addNode("join", mark("join"), defer ? { defer: true } : undefined)
      .addConditionalEdges(START, () => ["w1", "mid"], ["w0", "w1", "mid"])
      .addEdge("mid", "holder")
      .addEdge(["w0", "w1"], "join")
      .addEdge("join", END)
      .addEdge("holder", END)
      .compile({ checkpointer: saver });

  it("releases the join after defer is removed from the target", async () => {
    const saver = new MemorySaver();
    const boom = { on: true };
    const config = { configurable: { thread_id: "defer-removed" } };

    await expect(build(true, saver, boom).invoke({}, config)).rejects.toThrow(
      "boom"
    );

    const graph = build(false, saver, boom);
    await graph.updateState(config, { ran: ["w0-manual"] }, "w0");
    const result = (await graph.invoke(null, config)) as { ran: string[] };

    expect(result.ran.filter((n) => n === "join")).toHaveLength(1);
  });

  it("releases the join after defer is added to the target", async () => {
    const saver = new MemorySaver();
    const boom = { on: true };
    const config = { configurable: { thread_id: "defer-added" } };

    await expect(build(false, saver, boom).invoke({}, config)).rejects.toThrow(
      "boom"
    );

    const graph = build(true, saver, boom);
    await graph.updateState(config, { ran: ["w0-manual"] }, "w0");
    const result = (await graph.invoke(null, config)) as { ran: string[] };

    expect(result.ran.filter((n) => n === "join")).toHaveLength(1);
  });
});
