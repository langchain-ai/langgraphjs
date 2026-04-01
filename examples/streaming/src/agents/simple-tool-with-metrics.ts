/**
 * Simple tool graph compiled with custom stream transformers baked in.
 *
 * Same shape as `./simple-tool-graph.ts`, but compiled with the
 * `statsTransformer` and `toolActivityTransformer` factories so the
 * transformer projections are available both in-process
 * (`run.extensions.*`) and remotely (via the `custom:toolActivity` channel,
 * when deployed through the LangGraph API server).
 */

import { AIMessage, SystemMessage } from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import {
  statsTransformer,
  toolActivityTransformer,
} from "../shared/custom-transformers.js";
import { calculator, model, searchWeb } from "./shared.js";

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
  .compile({ transformers: [statsTransformer, toolActivityTransformer] });
