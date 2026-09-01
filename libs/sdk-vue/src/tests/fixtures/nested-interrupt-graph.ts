import {
  Annotation,
  END,
  interrupt,
  START,
  StateGraph,
} from "@langchain/langgraph";

/**
 * Parent → child → grandchild StateGraph where the innermost node
 * calls `interrupt()`. Used to assert that nested
 * `input.requested` events surface on `useStream().interrupts` live
 * (not only after hydrate).
 */
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
    prompt: "Approve nested subgraph action?",
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

const grandchild = new StateGraph(GraphState)
  .addNode("review", reviewNode)
  .addEdge(START, "review")
  .addEdge("review", END)
  .compile();

const child = new StateGraph(GraphState)
  .addNode("inner", grandchild, { subgraphs: [grandchild] })
  .addEdge(START, "inner")
  .addEdge("inner", END)
  .compile();

const workflow = new StateGraph(GraphState)
  .addNode("child", child, { subgraphs: [child] })
  .addEdge(START, "child")
  .addEdge("child", END);

export const graph = workflow.compile();
