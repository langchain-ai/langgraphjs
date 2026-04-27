import {
  type LangGraphRunnableConfig,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";

/**
 * Graph used by the re-attach harness automation (`R2.7`). The single
 * node sleeps for `SLOW_GRAPH_DELAY_MS` before emitting the final
 * message, giving the test enough runway to remount a second
 * `useStream` hook on the same `threadId` while the run
 * is still in flight on the server.
 */
export const SLOW_GRAPH_DELAY_MS = 400;

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (_state, _config: LangGraphRunnableConfig) => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_GRAPH_DELAY_MS));
    return {
      messages: [new AIMessage({ content: "Done." })],
    };
  })
  .addEdge(START, "agent")
  .compile();

export { graph };
