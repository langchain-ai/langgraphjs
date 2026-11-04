import {
  Annotation,
  END,
  interrupt,
  START,
  StateGraph,
} from "@langchain/langgraph";

const State = Annotation.Root({
  answers: Annotation<string[]>({
    reducer: (current, next) => current.concat(next),
    default: () => [],
  }),
});

export const graph = new StateGraph(State)
  .addNode("a", () => ({ answers: [`a:${interrupt("question_a")}`] }))
  .addNode("b", () => ({ answers: [`b:${interrupt("question_b")}`] }))
  .addEdge(START, "a")
  .addEdge(START, "b")
  .addEdge("a", END)
  .addEdge("b", END)
  .compile();

export const singleInterruptGraph = new StateGraph(State)
  .addNode("a", () => ({ answers: [`a:${interrupt("question_a")}`] }))
  .addEdge(START, "a")
  .addEdge("a", END)
  .compile();
