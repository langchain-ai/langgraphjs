import { Annotation, StateGraph, END, START } from "@langchain/langgraph";

const child = new StateGraph(
  Annotation.Root({
    messages: Annotation<string[]>({
      reducer: (a, b) => a.concat(b),
    }),
    child: Annotation<"child_one" | "child_two">,
  }),
)
  .addNode("c_one", () => ({ messages: ["Entered c_one node"] }))
  .addNode("c_two", () => ({ messages: ["Entered c_two node"] }))
  .addEdge(START, "c_one")
  .addEdge("c_one", "c_two")
  .addEdge("c_two", END);

const parent = new StateGraph(
  Annotation.Root({
    messages: Annotation<string[]>({
      reducer: (a, b) => a.concat(b),
    }),
    parent: Annotation<"parent_one" | "parent_two">,
  }),
)
  .addNode("p_one", () => ({ messages: ["Entered p_one node"] }))
  .addNode("p_two", child.compile())
  .addEdge(START, "p_one")
  .addEdge("p_one", "p_two")
  .addEdge("p_two", END);

const grandParent = new StateGraph(
  Annotation.Root({
    messages: Annotation<string[]>({
      reducer: (a, b) => a.concat(b),
    }),
  }),
)
  .addNode("gp_one", () => ({ messages: ["Entered gp_one node"] }))
  .addNode("gp_two", parent.compile())
  .addEdge(START, "gp_one")
  .addEdge("gp_one", "gp_two")
  .addEdge("gp_two", END);

export const graph = grandParent.compile();
