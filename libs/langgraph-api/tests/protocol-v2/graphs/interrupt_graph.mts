import {
  Annotation,
  END,
  interrupt,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

const GraphState = Annotation.Root({
  request: Annotation<string>(),
  decision: Annotation<Record<string, unknown> | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  completed: Annotation<boolean>({
    reducer: (_, next) => next,
    default: () => false,
  }),
});

const reviewNode = (state: typeof GraphState.State) => {
  const decision = interrupt({
    prompt: "Approve the outbound action?",
    request: state.request,
  });

  return {
    decision:
      decision != null && typeof decision === "object"
        ? (decision as Record<string, unknown>)
        : { value: decision },
    completed: true,
  };
};

const workflow = new StateGraph(GraphState)
  .addNode("review", reviewNode)
  .addEdge(START, "review")
  .addEdge("review", END);

export const graph = workflow.compile({
  checkpointer: new MemorySaver(),
});
