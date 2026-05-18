import { AIMessage } from "@langchain/core/messages";
import {
  MessagesAnnotation,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";

import { createStableTextModel } from "./shared.js";

const subgraphModel = createStableTextModel(["Reply from child"]);

const child = new StateGraph(MessagesAnnotation)
  .addNode(
    "inner",
    async (state: { messages: AIMessage[] }, runtime: Runtime) => {
      runtime.writer?.({ type: "progress", label: "child-started" });
      const response = await subgraphModel.invoke(state.messages);
      runtime.writer?.({ type: "progress", label: "child-finished" });
      return { messages: [response] };
    },
  )
  .addEdge(START, "inner")
  .compile();

const graph = new StateGraph(MessagesAnnotation)
  .addNode("child", child, { subgraphs: [child] })
  .addEdge(START, "child")
  .compile();

export { graph };
