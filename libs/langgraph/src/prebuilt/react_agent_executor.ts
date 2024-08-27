import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  BaseMessage,
  BaseMessageChunk,
  isAIMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  Runnable,
  RunnableConfig,
  RunnableInterface,
  RunnableLambda,
  RunnableToolLike,
} from "@langchain/core/runnables";
import { DynamicTool, StructuredToolInterface } from "@langchain/core/tools";

import {
  BaseLanguageModelCallOptions,
  BaseLanguageModelInput,
} from "@langchain/core/language_models/base";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { END, messagesStateReducer, START, StateGraph } from "../graph/index.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";
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
  llm: BaseChatModel;
  tools:
    | ToolNode<typeof MessagesAnnotation.State>
    | (StructuredToolInterface | RunnableToolLike)[];
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
 * Creates a StateGraph agent that relies on a chat llm utilizing tool calling.
 * @param llm The chat llm that can utilize OpenAI-style function calling.
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
    llm,
    tools,
    messageModifier,
    checkpointSaver,
    interruptBefore,
    interruptAfter,
  } = props;
  const schema: StateGraphArgs<AgentState>["channels"] = {
    messages: {
      value: messagesStateReducer,
      default: () => [],
    },
  };

  let toolClasses: (StructuredToolInterface | DynamicTool | RunnableToolLike)[];
  if (!Array.isArray(tools)) {
    toolClasses = tools.tools;
  } else {
    toolClasses = tools;
  }
  if (!("bindTools" in llm) || typeof llm.bindTools !== "function") {
    throw new Error(`llm ${llm} must define bindTools method.`);
  }
  const modelWithTools = llm.bindTools(toolClasses);
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

  const callModel = async (state: AgentState, config?: RunnableConfig) => {
    const { messages } = state;
    // TODO: Auto-promote streaming.
    return { messages: [await modelRunnable.invoke(messages, config)] };
  };

  const workflow = new StateGraph<AgentState>({
    channels: schema,
  })
    .addNode(
      "agent",
      RunnableLambda.from(callModel).withConfig({ runName: "agent" })
    )
    .addNode("tools", new ToolNode<AgentState>(toolClasses))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, {
      continue: "tools",
      [END]: END,
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
  const endict = RunnableLambda.from((messages: BaseMessage[]) => ({
    messages,
  }));
  if (typeof messageModifier === "string") {
    const systemMessage = new SystemMessage(messageModifier);
    const prompt = ChatPromptTemplate.fromMessages([
      systemMessage,
      ["placeholder", "{messages}"],
    ]);
    return endict.pipe(prompt).pipe(modelWithTools);
  }
  if (typeof messageModifier === "function") {
    const lambda = RunnableLambda.from(messageModifier).withConfig({
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
