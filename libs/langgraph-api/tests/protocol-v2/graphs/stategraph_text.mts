import {
  type LangGraphRunnableConfig,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";

import { createStableTextModel } from "./shared.mjs";

const modelMap = new Map<string, ReturnType<typeof createStableTextModel>>();

const getModel = (threadId: string) => {
  if (!modelMap.has(threadId)) {
    modelMap.set(threadId, createStableTextModel(["Plan accepted."]));
  }
  return modelMap.get(threadId)!;
};

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state, config: LangGraphRunnableConfig) => {
    const threadId =
      typeof config.configurable?.thread_id === "string"
        ? config.configurable.thread_id
        : "protocol-v2-default-thread";
    const model = getModel(threadId);
    const response = await model.invoke(state.messages);
    return { messages: [response] };
  })
  .addEdge(START, "agent")
  .compile();

export { graph };
