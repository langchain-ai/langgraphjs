import { Annotation, interrupt, StateGraph, START } from "@langchain/langgraph";

const StateSchema = Annotation.Root({
  log: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

export const graph = new StateGraph(StateSchema)
  .addNode("a", () => ({ log: [`a:${interrupt("a?")}`] }))
  .addNode("b", () => ({ log: [`b:${interrupt("b?")}`] }))
  .addEdge(START, "a")
  .addEdge(START, "b")
  .compile();
