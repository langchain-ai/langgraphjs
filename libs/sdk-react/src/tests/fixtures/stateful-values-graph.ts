import { AIMessage } from "@langchain/core/messages";
import {
  Annotation,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";

/**
 * State with a non-message channel (`status`) alongside `messages`.
 * Used to exercise optimistic handling of non-message input keys:
 * they merge into `values` immediately and converge to server truth.
 */
const StatefulState = Annotation.Root({
  ...MessagesAnnotation.spec,
  status: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "idle",
  }),
});

/**
 * Sleeps before emitting so a test can observe the optimistic
 * `status` value while the run is in flight, then overwrites it with
 * the server-authoritative `"final"`.
 */
const statefulValuesGraph = new StateGraph(StatefulState)
  .addNode("agent", async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { messages: [new AIMessage("Done.")], status: "final" };
  })
  .addEdge(START, "agent")
  .compile();

export { statefulValuesGraph };
