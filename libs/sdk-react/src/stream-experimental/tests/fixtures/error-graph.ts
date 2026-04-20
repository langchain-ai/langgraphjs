import {
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async () => {
    throw new Error("Intentional error for testing");
  })
  .addEdge(START, "agent")
  .compile();

export { graph };
