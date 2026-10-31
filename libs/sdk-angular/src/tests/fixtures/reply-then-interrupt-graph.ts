import {
  interrupt,
  type LangGraphRunnableConfig,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";

import { DRAFT_REPLY } from "./streaming-constants.js";
import { SlowTextModel } from "./streaming-models.js";

const model = new SlowTextModel(DRAFT_REPLY, 5);

/**
 * One node that streams a full reply and then pauses for approval before
 * returning it, so the reply finished streaming but no checkpoint holds it
 * while the run is paused. Resuming reruns the node, which streams the
 * reply again under a new message id.
 */
const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state, config: LangGraphRunnableConfig) => {
    const reply = await model.invoke(state.messages, config);
    interrupt({ question: "Approve this reply?" });
    return { messages: [reply] };
  })
  .addEdge(START, "agent")
  .compile();

export { graph };
