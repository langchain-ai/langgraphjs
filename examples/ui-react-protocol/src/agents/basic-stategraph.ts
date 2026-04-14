import { SystemMessage } from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import {
  ToolNode,
  toolsCondition,
} from "@langchain/langgraph/prebuilt";

import { basicProtocolTools, model } from "./shared";

const systemMessage = new SystemMessage(`You are a basic LangGraph StateGraph demo.

Answer protocol and frontend exploration questions clearly. Use tools when the
user wants a checklist or asks for a specific protocol concept such as session
setup or subscriptions. Keep the final answer compact and practical.`);

const modelWithTools = model.bindTools([...basicProtocolTools]);

const tools = new ToolNode([...basicProtocolTools]);

const callModel = async (state: typeof MessagesAnnotation.State) => {
  const response = await modelWithTools.invoke([
    systemMessage,
    ...state.messages,
  ]);
  return { messages: [response] };
};

export const agent = new StateGraph(MessagesAnnotation)
  .addNode("model", callModel)
  .addNode("tools", tools)
  .addEdge(START, "model")
  .addConditionalEdges("model", toolsCondition, ["tools", END])
  .addEdge("tools", "model")
  .compile();
