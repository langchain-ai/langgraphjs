import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  BaseMessage,
  BaseMessageChunk,
  isAIMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  Runnable,
  RunnableInterface,
  RunnableLambda,
} from "@langchain/core/runnables";
import { DynamicTool, StructuredTool } from "@langchain/core/tools";

import {
  BaseLanguageModelCallOptions,
  BaseLanguageModelInput,
} from "@langchain/core/language_models/base";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { BaseCheckpointSaver } from "../checkpoint/base.js";
import { END, START, StateGraph } from "../graph/index.js";
import { MessagesState } from "../graph/message.js";
import { CompiledStateGraph, StateGraphArgs } from "../graph/state.js";
import { All } from "../pregel/types.js";
import { ToolNode } from "./tool_node.js";

export interface AgentState {
  messages: BaseMessage[];
  // TODO: This won't be set until we
  // implement managed values in LangGraphJS
  // Will be useful for inserting a message on
  // graph recursion end
  // is_last_step: boolean;
}

export type N = typeof START | "agent" | "tools";

export type CreateReactAgentParams = {
  model: BaseChatModel;
  tools: ToolNode<MessagesState> | StructuredTool[];
  messageModifier?:
    | SystemMessage
    | string
    | ((messages: BaseMessage[]) => BaseMessage[])
    | ((messages: BaseMessage[]) => Promise<BaseMessage[]>)
    | Runnable;
  checkpointSaver?: BaseCheckpointSaver;
  interruptBefore?: N[] | All;
  interruptAfter?: N[] | All;
};

/**
 * Creates a StateGraph agent that relies on a chat model utilizing tool calling.
 * @param model The chat model that can utilize OpenAI-style function calling.
 * @param tools A list of tools or a ToolNode.
 * @param messageModifier An optional message modifier to apply to messages before being passed to the LLM.
 * Can be a SystemMessage, string, function that takes and returns a list of messages, or a Runnable.
 * @param checkpointSaver An optional checkpoint saver to persist the agent's state.
 * @param interruptBefore An optional list of node names to interrupt before running.
 * @param interruptAfter An optional list of node names to interrupt after running.
 * @returns A compiled agent as a LangChain Runnable.
 */
export function createReactAgent(
  props: CreateReactAgentParams
): CompiledStateGraph<
  AgentState,
  Partial<AgentState>,
  typeof START | "agent" | "tools"
> {
  const {
    model,
    tools,
    messageModifier,
    checkpointSaver,
    interruptBefore,
    interruptAfter,
  } = props;
  const schema: StateGraphArgs<AgentState>["channels"] = {
    messages: {
      value: (left: BaseMessage[], right: BaseMessage[]) => left.concat(right),
      default: () => [],
    },
  };

  let toolClasses: (StructuredTool | DynamicTool)[];
  if (!Array.isArray(tools)) {
    toolClasses = tools.tools;
  } else {
    toolClasses = tools;
  }
  if (!("bindTools" in model) || typeof model.bindTools !== "function") {
    throw new Error(`Model ${model} must define bindTools method.`);
  }
  const modelWithTools = model.bindTools(toolClasses);
  const modelRunnable = _createModelWrapper(modelWithTools, messageModifier);

  const shouldContinue = (state: AgentState) => {
    const { messages } = state;
    const lastMessage = messages[messages.length - 1];
    if (
      isAIMessage(lastMessage) &&
      (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0)
    ) {
      return END;
    } else {
      return "continue";
    }
  };

  const callModel = async (state: AgentState) => {
    const { messages } = state;
    // TODO: Auto-promote streaming.
    return { messages: [await modelRunnable.invoke(messages)] };
  };

  const workflow = new StateGraph<AgentState>({
    channels: schema,
  })
    .addNode(
      "agent",
      new RunnableLambda({ func: callModel }).withConfig({ runName: "agent" })
    )
    .addNode("tools", new ToolNode<AgentState>(toolClasses))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, {
      continue: "tools",
      end: END,
    })
    .addEdge("tools", "agent");

  return workflow.compile({
    checkpointer: checkpointSaver,
    interruptBefore,
    interruptAfter,
  });
}

function _createModelWrapper(
  modelWithTools: RunnableInterface<
    BaseLanguageModelInput,
    BaseMessageChunk,
    BaseLanguageModelCallOptions
  >,
  messageModifier?:
    | SystemMessage
    | string
    | ((messages: BaseMessage[]) => BaseMessage[])
    | ((messages: BaseMessage[]) => Promise<BaseMessage[]>)
    | Runnable
) {
  if (!messageModifier) {
    return modelWithTools;
  }
  const endict = new RunnableLambda({
    func: (messages: BaseMessage[]) => ({ messages }),
  });
  if (typeof messageModifier === "string") {
    const systemMessage = new SystemMessage(messageModifier);
    const prompt = ChatPromptTemplate.fromMessages([
      systemMessage,
      ["placeholder", "{messages}"],
    ]);
    return endict.pipe(prompt).pipe(modelWithTools);
  }
  if (typeof messageModifier === "function") {
    const lambda = new RunnableLambda({ func: messageModifier }).withConfig({
      runName: "message_modifier",
    });
    return lambda.pipe(modelWithTools);
  }
  if (Runnable.isRunnable(messageModifier)) {
    return messageModifier.pipe(modelWithTools);
  }
  if (messageModifier._getType() === "system") {
    const prompt = ChatPromptTemplate.fromMessages([
      messageModifier,
      ["placeholder", "{messages}"],
    ]);
    return endict.pipe(prompt).pipe(modelWithTools);
  }
  throw new Error(
    `Unsupported message modifier type: ${typeof messageModifier}`
  );
}
