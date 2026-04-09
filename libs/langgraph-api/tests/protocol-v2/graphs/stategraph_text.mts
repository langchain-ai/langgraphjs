import {
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";

import { createStableTextModel } from "./shared.mts";

const model = createStableTextModel(["Plan ", "accepted."]);

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state) => {
    const response = await model.invoke(state.messages);
    return { messages: [response] };
  })
  .addEdge(START, "agent")
  .compile();

export { graph };
