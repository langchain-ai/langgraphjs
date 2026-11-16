import { MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";

/** Answers "Done." after 400 ms, or after N ms when the message says "wait N". */
const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state) => {
    const asked = /wait (\d+)/.exec(String(state.messages.at(-1)?.content));
    const delay = asked == null ? 400 : Number(asked[1]);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return { messages: [new AIMessage({ content: "Done." })] };
  })
  .addEdge(START, "agent")
  .compile();

export { graph };
