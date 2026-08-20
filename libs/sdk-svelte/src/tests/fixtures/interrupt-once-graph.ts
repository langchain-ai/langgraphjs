import {
  END,
  interrupt,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { z } from "zod/v4";

const GraphState = new StateSchema({
  request: z.string(),
  decision: z.record(z.string(), z.unknown()).nullable().default(null),
  completedTurns: z.number().default(0),
});

const reviewNode = (state: typeof GraphState.State) => {
  if (state.decision != null) {
    return { completedTurns: state.completedTurns + 1 };
  }

  const decision = interrupt({
    prompt: "Approve the outbound action?",
    request: state.request,
  });

  return {
    decision:
      decision != null && typeof decision === "object"
        ? (decision as Record<string, unknown>)
        : { value: decision },
    completedTurns: state.completedTurns + 1,
  };
};

export const graph = new StateGraph(GraphState)
  .addNode("review", reviewNode)
  .addEdge(START, "review")
  .addEdge("review", END)
  .compile({ checkpointer: new MemorySaver() });
