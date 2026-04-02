import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  END,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";

const RESPONSE_DELAY_MS = 2500;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const agent = new StateGraph(MessagesAnnotation)
  .addNode("respond", async (state: { messages: BaseMessage[] }) => {
    const lastHuman = [...state.messages]
      .reverse()
      .find((message) => HumanMessage.isInstance(message));

    const humanText =
      typeof lastHuman?.content === "string"
        ? lastHuman.content
        : "(no text content)";

    await delay(RESPONSE_DELAY_MS);

    return {
      messages: [
        new AIMessage(
          `Thread stream reply (${new Date().toLocaleTimeString()}): ${humanText}`
        ),
      ],
    };
  })
  .addEdge(START, "respond")
  .addEdge("respond", END)
  .compile({ checkpointer: new MemorySaver() });
