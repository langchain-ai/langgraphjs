import { AIMessage } from "@langchain/core/messages";
import {
  MessagesAnnotation,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";

/**
 * Writes two anonymous payloads and a named one. The `useChannel` and
 * `useChannelEffect` tests count all three on the raw `custom` channel.
 */
const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (_state, runtime: Runtime) => {
    runtime.writer?.({ stage: "thinking" });
    runtime.writer?.({ name: "status", payload: { label: "answering" } });
    runtime.writer?.({ stage: "done" });
    return { messages: [new AIMessage("Custom channel reply")] };
  })
  .addEdge(START, "agent")
  .compile();

export { graph };
