/**
 * Simple tool-calling graph: model → tools → model (loop).
 *
 * A single ReAct-style loop with search and calculator tools.
 */

import { AIMessage, SystemMessage } from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import { model, searchWeb, calculator } from "./shared.js";

const modelWithTools = model.bindTools([searchWeb, calculator]);
const toolNode = new ToolNode([searchWeb, calculator]);

const systemMessage = new SystemMessage(
  "You are a helpful assistant. Use tools when needed. Keep answers concise."
);

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state) => ({
    messages: [await modelWithTools.invoke([systemMessage, ...state.messages])],
  }))
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges(
    "agent",
    (state) => {
      const last = state.messages.at(-1) as AIMessage;
      return last.tool_calls?.length ? "tools" : END;
    },
    ["tools", END]
  )
  .addEdge("tools", "agent")
  .compile();
