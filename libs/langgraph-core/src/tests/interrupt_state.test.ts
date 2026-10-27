import { describe, expect, it, vi } from "vitest";
import {
  MemorySaver,
  type BaseCheckpointSaver,
} from "@langchain/langgraph-checkpoint";
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  Send,
  entrypoint,
  task,
  interrupt,
} from "../web.js";
import { NO_WRITES, RESUME } from "../constants.js";
import type { StateSnapshot } from "../web.js";
import { gatherIterator } from "../utils.js";

const State = Annotation.Root({
  a: Annotation<number>(),
  b: Annotation<number>(),
});
const pending = (state: StateSnapshot) =>
  state.tasks
    .flatMap((task) => task.interrupts)
    .map(({ value }) => value)
    .sort();
const interruptId = (state: StateSnapshot, value: string) =>
  state.tasks
    .flatMap((task) => task.interrupts)
    .find((item) => item.value === value)!.id!;

function parallelGraph(
  options: {
    questions?: number;
    output?: "empty" | "null" | "zero";
    saver?: BaseCheckpointSaver;
  } = {}
) {
  const saver = options.saver ?? new MemorySaver();
  const askA = vi.fn(() => {
    let answer = 0;
    for (let i = 1; i <= (options.questions ?? 1); i += 1) {
      answer += interrupt<string, number>(`A${i}`);
    }
    if (options.output === "empty") return {};
    // JavaScript nodes can return null, which the runtime treats as no update.
    if (options.output === "null")
      return null as unknown as typeof State.Update;
    return { a: options.output === "zero" ? 0 : answer };
  });
  const askB = vi.fn(() => ({ b: interrupt<string, number>("B") }));
  const graph = new StateGraph(State)
    .addNode("askA", askA)
    .addNode("askB", askB)
    .addEdge(START, "askA")
    .addEdge(START, "askB")
    .addEdge("askA", END)
    .addEdge("askB", END)
    .compile({ checkpointer: saver });
  const config = { configurable: { thread_id: "interrupt-state" } };
  return { graph, saver, config, askA, askB };
}

describe("state reads after partial interrupt resumes", () => {
  it("reports only unfinished interrupts in latest state without changing checkpoint history", async () => {
    const { graph, config, askA } = parallelGraph();
    await graph.invoke({}, config);
    const paused = await graph.getState(config);
    const result = await graph.invoke(
      new Command({ resume: { [interruptId(paused, "A1")]: 1 } }),
      config
    );
    expect(result).toMatchObject({ a: 1, __interrupt__: [{ value: "B" }] });

    const latest = await graph.getState(config);
    expect(pending(latest)).toEqual(["B"]);
    expect(latest.next).toEqual(["askB"]);
    expect(latest.values).toEqual({ a: 1 });
    expect(latest.tasks.find((task) => task.name === "askA")).toMatchObject({
      interrupts: [],
      result: { a: 1 },
    });

    const pinned = await graph.getState(paused.config);
    expect(pending(pinned)).toEqual(["A1", "B"]);
    expect(pinned.next).toEqual(["askA", "askB"]);
    expect(pinned.values).toEqual({});
    const history = await gatherIterator(graph.getStateHistory(config));
    expect(
      pending(
        history.find(
          (state) =>
            state.config.configurable?.checkpoint_id ===
            paused.config.configurable?.checkpoint_id
        )!
      )
    ).toEqual(["A1", "B"]);
    // Reading history must not change the latest-state interpretation.
    expect(pending(await graph.getState(config))).toEqual(["B"]);

    expect(
      await graph.invoke(
        new Command({ resume: { [interruptId(latest, "B")]: 2 } }),
        config
      )
    ).toEqual({ a: 1, b: 2 });
    expect(askA).toHaveBeenCalledTimes(2);
    expect((await graph.getState(config)).next).toEqual([]);
    expect(pending(await graph.getState(config))).toEqual([]);
  });

  it("keeps a task pending at its next question across successive partial resumes", async () => {
    const { graph, config } = parallelGraph({ questions: 2 });
    await graph.invoke({}, config);
    const first = await graph.getState(config);
    await graph.invoke(
      new Command({ resume: { [interruptId(first, "A1")]: 1 } }),
      config
    );
    const second = await graph.getState(config);
    expect(pending(second)).toEqual(["A2", "B"]);
    expect(second.next).toEqual(["askA", "askB"]);
    expect(
      second.tasks.find((task) => task.name === "askA")?.result
    ).toBeUndefined();

    await graph.invoke(
      new Command({ resume: { [interruptId(second, "B")]: 4 } }),
      config
    );
    const third = await graph.getState(config);
    expect(pending(third)).toEqual(["A2"]);
    expect(third.next).toEqual(["askA"]);
    expect(third.tasks.find((task) => task.name === "askB")?.result).toEqual({
      b: 4,
    });
    expect(
      await graph.invoke(
        new Command({ resume: { [interruptId(third, "A2")]: 2 } }),
        config
      )
    ).toEqual({ a: 3, b: 4 });
    expect(pending(await graph.getState(config))).toEqual([]);
  });

  it.each(["empty", "null", "zero"] as const)(
    "recognizes completed tasks with %s output",
    async (output) => {
      const { graph, saver, config, askA } = parallelGraph({ output });
      await graph.invoke({}, config);
      const first = await graph.getState(config);
      await graph.invoke(
        new Command({ resume: { [interruptId(first, "A1")]: 1 } }),
        config
      );
      const saved = await saver.getTuple(config);
      const taskA = first.tasks.find((task) => task.name === "askA")!;
      if (output !== "zero") {
        expect(saved?.pendingWrites).toContainEqual([
          taskA.id,
          NO_WRITES,
          null,
        ]);
      }
      expect(
        saved?.pendingWrites?.some(
          ([id, channel]) => id === taskA.id && channel === RESUME
        )
      ).toBe(true);
      const latest = await graph.getState(config);
      expect(pending(latest)).toEqual(["B"]);
      expect(latest.next).toEqual(["askB"]);
      expect(latest.tasks.find((task) => task.name === "askA")?.result).toEqual(
        output === "zero" ? { a: 0 } : undefined
      );
      await graph.invoke(
        new Command({ resume: { [interruptId(latest, "B")]: 2 } }),
        config
      );
      expect(askA).toHaveBeenCalledTimes(2);
      expect((await graph.getState(config)).next).toEqual([]);
    }
  );

  it("does not rerun an already completed empty-output task when another task resumes", async () => {
    const { graph, config, askA } = parallelGraph({ output: "empty" });
    await graph.invoke({}, config);
    const first = await graph.getState(config);
    await graph.invoke(
      new Command({ resume: { [interruptId(first, "A1")]: 1 } }),
      config
    );
    await graph.invoke(
      new Command({ resume: { [interruptId(first, "B")]: 2 } }),
      config
    );
    expect(askA).toHaveBeenCalledTimes(2);
    expect(pending(await graph.getState(config))).toEqual([]);
  });

  it("distinguishes parallel subgraph tasks with the same name", async () => {
    const ChildState = Annotation.Root({
      prompt: Annotation<string>(),
      a: Annotation<number>(),
      b: Annotation<number>(),
    });
    const child = new StateGraph(ChildState)
      .addNode("ask", (state) => ({
        [state.prompt]: interrupt<string, number>(state.prompt),
      }))
      .addEdge(START, "ask")
      .compile();
    const graph = new StateGraph(State)
      .addNode("child", child)
      .addConditionalEdges(
        START,
        () => [
          new Send("child", { prompt: "a" }),
          new Send("child", { prompt: "b" }),
        ],
        ["child"]
      )
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "parallel-subgraphs" } };
    await graph.invoke({}, config);
    const first = await graph.getState(config);
    await graph.invoke(
      new Command({ resume: { [interruptId(first, "a")]: 1 } }),
      config
    );
    const latest = await graph.getState(config, { subgraphs: true });
    expect(pending(latest)).toEqual(["b"]);
    expect(latest.next).toEqual(["child"]);
    expect(
      latest.tasks.filter((item) => item.interrupts.length === 0)
    ).toHaveLength(1);
    expect(
      await graph.invoke(
        new Command({ resume: { [interruptId(latest, "b")]: 2 } }),
        config
      )
    ).toEqual({ a: 1, b: 2 });
  });

  it("recognizes a functional task returning null as finished", async () => {
    const askA = vi.fn(() => {
      interrupt("A");
      return null;
    });
    const a = task("a", askA);
    const b = task("b", () => interrupt<string, number>("B"));
    const graph = entrypoint(
      { name: "workflow", checkpointer: new MemorySaver() },
      async () => Promise.all([a(), b()])
    );
    const config = { configurable: { thread_id: "functional-interrupts" } };
    await graph.invoke({}, config);
    const first = await graph.getState(config);
    await graph.invoke(
      new Command({ resume: { [interruptId(first, "A")]: 1 } }),
      config
    );
    const latest = await graph.getState(config);
    expect(pending(latest)).toEqual(["B"]);
    expect(
      await graph.invoke(
        new Command({ resume: { [interruptId(latest, "B")]: 2 } }),
        config
      )
    ).toEqual([null, 2]);
    expect(askA).toHaveBeenCalledTimes(2);
  });

  it.skipIf(typeof window !== "undefined")(
    "does not rerun an empty-output task when SQLite retains an older resume value",
    async () => {
      const { SqliteSaver } =
        await import("@langchain/langgraph-checkpoint-sqlite");
      const saver = SqliteSaver.fromConnString(":memory:");
      try {
        const { graph, config, askA } = parallelGraph({
          questions: 2,
          output: "empty",
          saver,
        });
        await graph.invoke({}, config);
        const first = await graph.getState(config);
        await graph.invoke(
          new Command({ resume: { [interruptId(first, "A1")]: 1 } }),
          config
        );
        const second = await graph.getState(config);
        await graph.invoke(
          new Command({ resume: { [interruptId(second, "A2")]: 2 } }),
          config
        );
        const completed = await graph.getState(config);
        const taskA = first.tasks.find((item) => item.name === "askA")!;
        const writes = (await saver.getTuple(config))?.pendingWrites;
        // Mixed output/control writes are insert-ignore: the old resume can
        // survive, but the completion marker must still prevent replay.
        expect(writes).toContainEqual([taskA.id, RESUME, [1]]);
        expect(writes).toContainEqual([taskA.id, NO_WRITES, null]);
        expect(pending(completed)).toEqual(["B"]);
        expect(completed.next).toEqual(["askB"]);
        await graph.invoke(
          new Command({ resume: { [interruptId(completed, "B")]: 3 } }),
          config
        );
        expect(askA).toHaveBeenCalledTimes(3);
        expect((await graph.getState(config)).next).toEqual([]);
      } finally {
        saver.db.close();
      }
    }
  );
});
