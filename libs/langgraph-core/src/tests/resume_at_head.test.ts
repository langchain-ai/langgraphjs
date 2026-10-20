import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";

import { Annotation, StateGraph } from "../graph/index.js";
import { Command, START } from "../constants.js";
import { interrupt } from "../interrupt.js";

const State = Annotation.Root({
  log: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

describe("resuming at the latest checkpoint", () => {
  it.each(["head", "undefined"] as const)(
    "doesn't rerun a node that already finished (checkpoint_id: %s)",
    async (checkpointId) => {
      const answered = { a: 0, b: 0 };
      const graph = new StateGraph(State)
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
        .compile({ checkpointer: new MemorySaver() });
      const config = { configurable: { thread_id: "1" } };
      await graph.invoke({ log: [] }, config);

      let log: string[] = [];
      for (const question of ["A", "B"]) {
        const snapshot = await graph.getState(config);
        const pending = snapshot.tasks
          .flatMap((task) => task.interrupts)
          .find((i) => i.value === question);
        const target =
          checkpointId === "head"
            ? snapshot.config
            : { configurable: { thread_id: "1", checkpoint_id: undefined } };
        const result = await graph.invoke(
          new Command({ resume: { [pending!.id!]: "yes" } }),
          target
        );
        log = result.log;
      }

      expect(answered).toEqual({ a: 1, b: 1 });
      expect([...log].sort()).toEqual(["a:yes", "b:yes"]);
    }
  );
});
