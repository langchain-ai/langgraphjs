import {
  type LangGraphRunnableConfig,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";

import { QUICK_REPLY, SLOW_MARKER, SLOW_REPLY } from "./streaming-constants.js";
import { SlowTextModel } from "./streaming-models.js";

/** About 2.8s for the slow reply, a few ms per character for the quick one. */
const slowModel = new SlowTextModel(SLOW_REPLY, 40);
const quickModel = new SlowTextModel(QUICK_REPLY, 2);

/**
 * Chat graph whose reply speed depends on the last message: one containing
 * {@link SLOW_MARKER} streams {@link SLOW_REPLY} slowly, anything else
 * streams {@link QUICK_REPLY} at once.
 */
const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state, config: LangGraphRunnableConfig) => {
    const last = state.messages.at(-1);
    const slow =
      typeof last?.content === "string" && last.content.includes(SLOW_MARKER);
    const model = slow ? slowModel : quickModel;
    const response = await model.invoke(state.messages, config);
    return { messages: [response] };
  })
  .addEdge(START, "agent")
  .compile();

export { graph };
