import { AIMessage } from "@langchain/core/messages";
import {
  MessagesAnnotation,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";

/**
 * Emits both anonymous writer payloads and named writer events. Both paths
 * are exercised by the
 * `useChannel` and `useExtension` selector hook tests.
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
