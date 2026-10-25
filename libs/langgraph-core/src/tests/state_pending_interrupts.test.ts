import { describe, expect, it } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  type StateSnapshot,
  interrupt,
} from "../web.js";

const State = Annotation.Root({
  a: Annotation<number>(),
  b: Annotation<number>(),
});

const buildParallel = () =>
  new StateGraph(State)
    .addNode("askA", () => ({ a: interrupt("A?") as number }))
    .addNode("askB", () => ({ b: interrupt("B?") as number }))
    .addEdge(START, "askA")
    .addEdge(START, "askB")
    .addEdge("askA", END)
    .addEdge("askB", END)
    .compile({ checkpointer: new MemorySaver() });

type Interrupted = { __interrupt__?: Array<{ value: unknown }> };

const pendingValues = async (
  graph: { getState: (config: RunnableConfig) => Promise<StateSnapshot> },
  config: RunnableConfig
) =>
  (await graph.getState(config)).tasks
    .flatMap((task) => task.interrupts)
    .map((item) => item.value);

describe("getState with interrupts answered by id", () => {
  it("stops reporting an answered interrupt after a partial resume", async () => {
    const graph = buildParallel();
    const config = { configurable: { thread_id: "partial" } };

    await graph.invoke({}, config);
    const [askedA] = (await graph.getState(config)).tasks
      .flatMap((task) => task.interrupts)
      .filter((item) => item.value === "A?");

    const result = (await graph.invoke(
      new Command({ resume: { [askedA.id!]: 1 } }),
      config
    )) as Interrupted;

    // The invoke result and the state agree on what is still pending.
    expect(result.__interrupt__?.map((item) => item.value)).toEqual(["B?"]);
    expect(await pendingValues(graph, config)).toEqual(["B?"]);

    const state = await graph.getState(config);
    expect(state.next).toEqual(["askB"]);
    const taskA = state.tasks.find((task) => task.name === "askA")!;
    expect(taskA.interrupts).toEqual([]);
    expect(taskA.result).toEqual({ a: 1 });
  });

  it("reports nothing pending once every interrupt is answered", async () => {
    const graph = buildParallel();
    const config = { configurable: { thread_id: "all" } };

    await graph.invoke({}, config);
    const asked = (await graph.getState(config)).tasks.flatMap(
      (task) => task.interrupts
    );
    const idOf = (value: string) => asked.find((i) => i.value === value)!.id!;

    await graph.invoke(new Command({ resume: { [idOf("A?")]: 1 } }), config);
    const result = await graph.invoke(
      new Command({ resume: { [idOf("B?")]: 2 } }),
      config
    );

    expect(result).toEqual({ a: 1, b: 2 });
    expect(await pendingValues(graph, config)).toEqual([]);
    expect((await graph.getState(config)).next).toEqual([]);
  });

  it("keeps the recorded interrupts when reading an explicit checkpoint", async () => {
    const graph = buildParallel();
    const config = { configurable: { thread_id: "history" } };

    await graph.invoke({}, config);
    const paused = await graph.getState(config);
    const [askedA] = paused.tasks
      .flatMap((task) => task.interrupts)
      .filter((item) => item.value === "A?");
    await graph.invoke(new Command({ resume: { [askedA.id!]: 1 } }), config);

    // The latest state hides the answered interrupt; a read pinned to the
    // checkpoint that was paused still shows what was recorded for it.
    expect(await pendingValues(graph, config)).toEqual(["B?"]);
    const pinned = await pendingValues(graph, paused.config);
    expect(pinned.sort()).toEqual(["A?", "B?"]);
  });

  it("keeps a task that was resumed but paused again at its next interrupt", async () => {
    const graph = new StateGraph(State)
      .addNode("ask", () => {
        const first = interrupt("first?") as number;
        const second = interrupt("second?") as number;
        return { a: first + second };
      })
      .addEdge(START, "ask")
      .addEdge("ask", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "twice" } };

    await graph.invoke({}, config);
    const result = (await graph.invoke(
      new Command({ resume: 1 }),
      config
    )) as Interrupted;

    expect(result.__interrupt__?.map((item) => item.value)).toEqual([
      "second?",
    ]);
    expect(await pendingValues(graph, config)).toContain("second?");
  });
});
