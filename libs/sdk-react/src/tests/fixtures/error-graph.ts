import { AIMessage } from "@langchain/core/messages";
import {
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state) => {
    if (state.messages.at(-1)?.content !== "recover") {
      throw new Error("Intentional error for testing");
    }
    return { messages: [new AIMessage("Recovered.")] };
  })
  .addEdge(START, "agent")
  .compile();

export { graph };
