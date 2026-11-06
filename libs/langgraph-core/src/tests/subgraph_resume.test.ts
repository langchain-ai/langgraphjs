import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";

import { Annotation, StateGraph } from "../graph/index.js";
import { Command, END, INTERRUPT, START, isInterrupted } from "../constants.js";
import { task } from "../func/index.js";
import { interrupt } from "../interrupt.js";
import type { StateSnapshot } from "../pregel/types.js";

const State = Annotation.Root({
  log: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

describe("resuming a subgraph", () => {
  it.each(["sync", "async", "exit"] as const)(
    "doesn't rerun a node that already finished (durability: %s)",
    async (durability) => {
      const answered = { a: 0, b: 0 };
      const child = new StateGraph(State)
        .addNode("a", () => {
          const answer = interrupt("A");
          answered.a += 1;
          return { log: [`a:${answer}`] };
        })
        .addNode("b", () => {
          const answer = interrupt("B");
          answered.b += 1;
          return { log: [`b:${answer}`] };
        })
        .addEdge(START, "a")
        .addEdge(START, "b")
        .compile();
      const graph = new StateGraph(State)
        .addNode("child", child)
        .addEdge(START, "child")
        .compile({ checkpointer: new MemorySaver() });
      const config = { configurable: { thread_id: "1" }, durability };

      let result = await graph.invoke({ log: [] }, config);
      while (isInterrupted(result) && result[INTERRUPT].length > 0) {
        result = await graph.invoke(
          new Command({ resume: { [result[INTERRUPT][0].id!]: "yes" } }),
          config
        );
      }

      expect(answered).toEqual({ a: 1, b: 1 });
      expect([...result.log].sort()).toEqual(["a:yes", "b:yes"]);
    }
  );

  it("doesn't rerun a task() that finished before the interrupt", async () => {
    let lookups = 0;
    const lookup = task("lookup", async () => {
      lookups += 1;
      return "value";
    });
    const child = new StateGraph(State)
      .addNode("node", async () => {
        const value = await lookup();
        return { log: [`${value}:${interrupt("ok?")}`] };
      })
      .addEdge(START, "node")
      .compile();
    const graph = new StateGraph(State)
      .addNode("child", child)
      .addEdge(START, "child")
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "1" } };

    await graph.invoke({ log: [] }, config);
    const result = await graph.invoke(new Command({ resume: "yes" }), config);

    expect(result.log).toEqual(["value:yes"]);
    expect(lookups).toBe(1);
  });

  it("reruns every node of a step it replays in place, finished ones included", async () => {
    const entered = { a: 0, b: 0 };
    const child = new StateGraph(State)
      .addNode("a", () => {
        entered.a += 1;
        return { log: [`a:${interrupt("A")}`] };
      })
      .addNode("b", () => {
        entered.b += 1;
        return { log: [`b:${interrupt("B")}`] };
      })
      .addEdge(START, "a")
      .addEdge(START, "b")
      .compile({ checkpointer: true });
    const graph = new StateGraph(State)
      .addNode("child", child)
      .addEdge(START, "child")
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "1" } };
    const subgraphHead = async () =>
      ((await graph.getState(config, { subgraphs: true })).tasks[0]
        .state as StateSnapshot).config;

    await graph.invoke({ log: [] }, config);
    await graph.updateState(await subgraphHead(), { log: ["u"] }, "__start__");
    const paused = await graph.invoke(null, config);
    if (!isInterrupted(paused)) throw new Error("expected an interrupt");
    await graph.invoke(
      new Command({ resume: { [paused[INTERRUPT][0].id!]: "yes" } }),
      config
    );
    const before = { ...entered };

    await graph.invoke(null, await subgraphHead());

    expect({ a: entered.a - before.a, b: entered.b - before.b }).toEqual({
      a: 1,
      b: 1,
    });
  });
});

describe("calling a checkpointer: true subgraph again", () => {
  const Counter = Annotation.Root({ x: Annotation<number>() });
  const Loop = Annotation.Root({
    x: Annotation<number>(),
    rounds: Annotation<number>(),
  });

  it.each<{ interruptBefore?: "child"[]; interruptAfter?: "tick"[] }>([
    { interruptBefore: ["child"] },
    { interruptAfter: ["tick"] },
  ])(
    "runs it on its new input after the parent pauses (%o)",
    async (breakpoint) => {
      const inputs: number[] = [];
      const child = new StateGraph(Counter)
        .addNode("increment", ({ x }) => {
          inputs.push(x);
          return { x: x + 1 };
        })
        .addEdge(START, "increment")
        .addEdge("increment", END)
        .compile({ checkpointer: true });
      const graph = new StateGraph(Loop)
        .addNode("child", child)
        .addNode("tick", ({ rounds }) => ({ rounds: rounds + 1 }))
        .addEdge(START, "child")
        .addEdge("child", "tick")
        .addConditionalEdges(
          "tick",
          ({ rounds }) => (rounds < 2 ? "child" : END),
          ["child", END]
        )
        .compile({ checkpointer: new MemorySaver(), ...breakpoint });
      const config = { configurable: { thread_id: "1" } };

      await graph.invoke({ x: 0, rounds: 0 }, config);
      for (let pauses = 0; pauses < 5; pauses += 1) {
        if ((await graph.getState(config)).next.length === 0) break;
        await graph.invoke(null, config);
      }

      expect(inputs).toEqual([0, 1]);
      expect((await graph.getState(config)).values).toEqual({
        x: 2,
        rounds: 2,
      });
    }
  );

  it.each(["interrupt", "interruptBefore", "interruptAfter"] as const)(
    "resumes a call that paused inside it (%s)",
    async (pause) => {
      const inputs: number[] = [];
      const child = new StateGraph(Counter)
        .addNode("increment", ({ x }) => {
          inputs.push(x);
          return { x: x + 1 };
        })
        .addNode("confirm", () => {
          if (pause === "interrupt") interrupt("ok?");
          return {};
        })
        .addEdge(START, "increment")
        .addEdge("increment", "confirm")
        .addEdge("confirm", END)
        .compile({
          checkpointer: true,
          interruptBefore: pause === "interruptBefore" ? ["confirm"] : [],
          interruptAfter: pause === "interruptAfter" ? ["confirm"] : [],
        });
      const graph = new StateGraph(Loop)
        .addNode("child", child)
        .addNode("tick", ({ rounds }) => ({ rounds: rounds + 1 }))
        .addEdge(START, "child")
        .addEdge("child", "tick")
        .addConditionalEdges(
          "tick",
          ({ rounds }) => (rounds < 2 ? "child" : END),
          ["child", END]
        )
        .compile({ checkpointer: new MemorySaver() });
      const config = { configurable: { thread_id: "1" } };

      await graph.invoke({ x: 0, rounds: 0 }, config);
      for (let pauses = 0; pauses < 5; pauses += 1) {
        if ((await graph.getState(config)).next.length === 0) break;
        await graph.invoke(
          pause === "interrupt" ? new Command({ resume: "yes" }) : null,
          config
        );
      }

      expect(inputs).toEqual([0, 1]);
      expect((await graph.getState(config)).values).toEqual({
        x: 2,
        rounds: 2,
      });
    }
  );
});
