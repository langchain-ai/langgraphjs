import { StateGraph, START } from "@langchain/langgraph";
import { MessagesAnnotation } from "@langchain/langgraph";

class CustomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomError";
  }
}

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("error_node", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    throw new CustomError("Boo!");
  })
  .addEdge(START, "error_node")
  .compile();
