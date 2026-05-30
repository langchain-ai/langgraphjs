import {
  Annotation,
  END,
  interrupt,
  Send,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

const GraphState = Annotation.Root({
  prompts: Annotation<string[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  decisions: Annotation<Record<string, unknown>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  completed: Annotation<boolean>({
    reducer: (_, next) => next,
    default: () => false,
  }),
});

type ReviewState = { prompt: string };

const reviewNode = (state: ReviewState) => {
  const decision = interrupt({
    prompt: `Approve action ${state.prompt}?`,
    action: state.prompt,
  });
  return {
    decisions: { [state.prompt]: decision },
  };
};

const fanOut = (state: typeof GraphState.State) =>
  state.prompts.map((prompt) => new Send("review", { prompt }));

const aggregate = (state: typeof GraphState.State) => ({
  completed: state.prompts.every((prompt) => prompt in state.decisions),
});

const workflow = new StateGraph(GraphState)
  .addNode("review", reviewNode)
  .addNode("aggregate", aggregate)
  .addConditionalEdges(START, fanOut, ["review"])
  .addEdge("review", "aggregate")
  .addEdge("aggregate", END);

export const graph = workflow.compile({
  checkpointer: new MemorySaver(),
});
