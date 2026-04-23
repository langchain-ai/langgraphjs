import { AIMessage } from "@langchain/core/messages";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import {
  MessagesAnnotation,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";

/**
 * Emits both anonymous writer payloads (landing on the raw `custom`
 * channel) and named events via `dispatchCustomEvent("status", …)`
 * (landing on `custom:status`). Both paths are exercised by the
 * `useChannel` and `useExtension` selector hook tests.
 */
const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (_state, runtime: Runtime) => {
    runtime.writer?.({ stage: "thinking" });
    await dispatchCustomEvent("status", { label: "answering" });
    runtime.writer?.({ stage: "done" });
    return { messages: [new AIMessage("Custom channel reply")] };
  })
  .addEdge(START, "agent")
  .compile();

export { graph };
