import { Annotation, StateGraph, START, END } from "@langchain/langgraph";

const State = Annotation.Root({
  ran: Annotation<string[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
});
const mark = (n: string) => () => ({ ran: [n] });

const inner = new StateGraph(State)
  .addNode("ia", mark("ia")).addNode("ib", mark("ib")).addNode("imerge", mark("imerge"))
  .addConditionalEdges(START, () => ["ia"], ["ia", "ib"])
  .addEdge(["ia", "ib"], "imerge").addEdge("imerge", END).compile();

export const graph = new StateGraph(State)
  .addNode("sub", inner)
  .addNode("a", mark("a")).addNode("b", mark("b")).addNode("merge", mark("merge"))
  .addConditionalEdges(START, () => ["sub", "a"], ["sub", "a", "b"])
  .addEdge(["a", "b"], "merge").addEdge("merge", END).addEdge("sub", END)
  .compile();
