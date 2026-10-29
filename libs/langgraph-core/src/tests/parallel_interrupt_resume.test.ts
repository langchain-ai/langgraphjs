import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";

import { Annotation, StateGraph } from "../graph/index.js";
import { Command, INTERRUPT, START, isInterrupted } from "../constants.js";
import { interrupt } from "../interrupt.js";

const State = Annotation.Root({
  log: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

describe("resuming parallel interrupts one at a time", () => {
  it.each(["sync", "async", "exit"] as const)(
    "applies each finished task's output once (durability: %s)",
    async (durability) => {
      const graph = new StateGraph(State)
        .addNode("a", () => ({ log: [`a:${interrupt("A")}`] }))
        .addNode("b", () => ({ log: [`b:${interrupt("B")}`] }))
        .addNode("c", () => ({ log: [`c:${interrupt("C")}`] }))
        .addEdge(START, "a")
        .addEdge(START, "b")
        .addEdge(START, "c")
        .compile({ checkpointer: new MemorySaver() });
      const config = { configurable: { thread_id: "1" }, durability };

      let result = await graph.invoke({ log: [] }, config);
      while (isInterrupted(result) && result[INTERRUPT].length > 0) {
        result = await graph.invoke(
          new Command({ resume: { [result[INTERRUPT][0].id!]: "yes" } }),
          config
        );
      }

      expect([...result.log].sort()).toEqual(["a:yes", "b:yes", "c:yes"]);
      const state = await graph.getState(config);
      expect([...state.values.log].sort()).toEqual(["a:yes", "b:yes", "c:yes"]);
    }
  );
});
