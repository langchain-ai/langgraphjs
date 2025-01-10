import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  BaseMessage,
  BaseMessageLike,
  isAIMessage,
  isBaseMessage,
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
  All,
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";

import {
  END,
  START,
  StateGraph,
  CompiledStateGraph,
  AnnotationRoot,
} from "../graph/index.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";
import { ToolNode } from "./tool_node.js";
import { LangGraphRunnableConfig } from "../pregel/runnable_types.js";

export interface AgentState {
  messages: BaseMessage[];
  // TODO: This won't be set until we
  // implement managed values in LangGraphJS
  // Will be useful for inserting a message on
  // graph recursion end
  // is_last_step: boolean;
}

export type N = typeof START | "agent" | "tools";

function _convertMessageModifierToStateModifier(
  messageModifier: MessageModifier
): StateModifier {
  // Handle string or SystemMessage
  if (
    typeof messageModifier === "string" ||
    (isBaseMessage(messageModifier) && messageModifier._getType() === "system")
  ) {
    return messageModifier;
  }

  // Handle callable function
  if (typeof messageModifier === "function") {
    return async (state: typeof MessagesAnnotation.State) =>
      messageModifier(state.messages);
  }

  // Handle Runnable
  if (Runnable.isRunnable(messageModifier)) {
    return RunnableLambda.from(
      (state: typeof MessagesAnnotation.State) => state.messages
    ).pipe(messageModifier);
  }

  throw new Error(
    `Unexpected type for messageModifier: ${typeof messageModifier}`
  );
}

function _getStateModifierRunnable(
  stateModifier: StateModifier | undefined
): RunnableInterface {
  let stateModifierRunnable: RunnableInterface;

  if (stateModifier == null) {
    stateModifierRunnable = RunnableLambda.from(
      (state: typeof MessagesAnnotation.State) => state.messages
    ).withConfig({ runName: "state_modifier" });
  } else if (typeof stateModifier === "string") {
    const systemMessage = new SystemMessage(stateModifier);
    stateModifierRunnable = RunnableLambda.from(
      (state: typeof MessagesAnnotation.State) => {
        return [systemMessage, ...(state.messages ?? [])];
      }
    ).withConfig({ runName: "state_modifier" });
  } else if (
    isBaseMessage(stateModifier) &&
    stateModifier._getType() === "system"
  ) {
    stateModifierRunnable = RunnableLambda.from(
      (state: typeof MessagesAnnotation.State) => [
        stateModifier,
        ...state.messages,
      ]
    ).withConfig({ runName: "state_modifier" });
  } else if (typeof stateModifier === "function") {
    stateModifierRunnable = RunnableLambda.from(stateModifier).withConfig({
      runName: "state_modifier",
    });
  } else if (Runnable.isRunnable(stateModifier)) {
    stateModifierRunnable = stateModifier;
  } else {
    throw new Error(
      `Got unexpected type for 'stateModifier': ${typeof stateModifier}`
    );
  }

  return stateModifierRunnable;
}

function _getModelPreprocessingRunnable(
  stateModifier: CreateReactAgentParams["stateModifier"],
  messageModifier: CreateReactAgentParams["messageModifier"]
) {
  // Check if both modifiers exist
  if (stateModifier != null && messageModifier != null) {
    throw new Error(
      "Expected value for either stateModifier or messageModifier, got values for both"
    );
  }

  // Convert message modifier to state modifier if necessary
  if (stateModifier == null && messageModifier != null) {
    // eslint-disable-next-line no-param-reassign
    stateModifier = _convertMessageModifierToStateModifier(messageModifier);
  }

  return _getStateModifierRunnable(stateModifier);
}

export type StateModifier =
  | SystemMessage
  | string
  | ((
      state: typeof MessagesAnnotation.State,
      config: LangGraphRunnableConfig
    ) => BaseMessageLike[])
  | ((
      state: typeof MessagesAnnotation.State,
      config: LangGraphRunnableConfig
    ) => Promise<BaseMessageLike[]>)
  | Runnable;

/** @deprecated Use StateModifier instead. */
export type MessageModifier =
  | SystemMessage
  | string
  | ((messages: BaseMessage[]) => BaseMessage[])
  | ((messages: BaseMessage[]) => Promise<BaseMessage[]>)
  | Runnable;

export type CreateReactAgentParams<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A extends AnnotationRoot<any> = AnnotationRoot<any>
> = {
  /** The chat model that can utilize OpenAI-style tool calling. */
  llm: BaseChatModel;
  /** A list of tools or a ToolNode. */
  tools: ToolNode | (StructuredToolInterface | RunnableToolLike)[];
  /**
   * @deprecated
   * Use stateModifier instead. stateModifier works the same as
   * messageModifier in that it runs right before calling the chat model,
   * but if passed as a function, it takes the full graph state as
   * input whenever a tool is called rather than a list of messages.
   *
   * If a function is passed, it should return a list of messages to
   * pass directly to the chat model.
   *
   * @example
   * ```ts
   * import { ChatOpenAI } from "@langchain/openai";
   * import { MessagesAnnotation } from "@langchain/langgraph";
   * import { createReactAgent } from "@langchain/langgraph/prebuilt";
   * import { type BaseMessage, SystemMessage } from "@langchain/core/messages";
   *
   * const model = new ChatOpenAI({
   *   model: "gpt-4o-mini",
   * });
   *
   * const tools = [...];
   *
   * // Deprecated style with messageModifier
   * const deprecated = createReactAgent({
   *   llm,
   *   tools,
   *   messageModifier: async (messages: BaseMessage[]) => {
   *     return [new SystemMessage("You are a pirate")].concat(messages);
   *   }
   * });
   *
   * // New style with stateModifier
   * const agent = createReactAgent({
   *   llm,
   *   tools,
   *   stateModifier: async (state: typeof MessagesAnnotation.State) => {
   *     return [new SystemMessage("You are a pirate.")].concat(messages);
   *   }
   * });
   * ```
   */
  messageModifier?: MessageModifier;
  /**
   * An optional state modifier. This takes full graph state BEFORE the LLM is called and prepares the input to LLM.
   *
   * Can take a few different forms:
   *
   * - SystemMessage: this is added to the beginning of the list of messages in state["messages"].
   * - str: This is converted to a SystemMessage and added to the beginning of the list of messages in state["messages"].
   * - Function: This function should take in full graph state and the output is then passed to the language model.
   * - Runnable: This runnable should take in full graph state and the output is then passed to the language model.
   */
  stateModifier?: StateModifier;
  stateSchema?: A;
  /** An optional checkpoint saver to persist the agent's state. */
  checkpointSaver?: BaseCheckpointSaver;
  /** An optional list of node names to interrupt before running. */
  interruptBefore?: N[] | All;
  /** An optional list of node names to interrupt after running. */
  interruptAfter?: N[] | All;
  store?: BaseStore;
};

/**
 * Creates a StateGraph agent that relies on a chat model utilizing tool calling.
 *
 * @example
 * ```ts
 * import { ChatOpenAI } from "@langchain/openai";
 * import { tool } from "@langchain/core/tools";
 * import { z } from "zod";
 * import { createReactAgent } from "@langchain/langgraph/prebuilt";
 *
 * const model = new ChatOpenAI({
 *   model: "gpt-4o",
 * });
 *
 * const getWeather = tool((input) => {
 *   if (["sf", "san francisco"].includes(input.location.toLowerCase())) {
 *     return "It's 60 degrees and foggy.";
 *   } else {
 *     return "It's 90 degrees and sunny.";
 *   }
 * }, {
 *   name: "get_weather",
 *   description: "Call to get the current weather.",
 *   schema: z.object({
 *     location: z.string().describe("Location to get the weather for."),
 *   })
 * })
 *
 * const agent = createReactAgent({ llm: model, tools: [getWeather] });
 *
 * const inputs = {
 *   messages: [{ role: "user", content: "what is the weather in SF?" }],
 * };
 *
 * const stream = await agent.stream(inputs, { streamMode: "values" });
 *
 * for await (const { messages } of stream) {
 *   console.log(messages);
 * }
 * // Returns the messages in the state at each step of execution
 * ```
 */

export function createReactAgent<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A extends AnnotationRoot<any> = AnnotationRoot<any>
>(
  params: CreateReactAgentParams<A>
): CompiledStateGraph<
  (typeof MessagesAnnotation)["State"],
  (typeof MessagesAnnotation)["Update"],
  typeof START | "agent" | "tools",
  typeof MessagesAnnotation.spec & A["spec"],
  typeof MessagesAnnotation.spec & A["spec"]
> {
  const {
    llm,
    tools,
    messageModifier,
    stateModifier,
    stateSchema,
    checkpointSaver,
    interruptBefore,
    interruptAfter,
    store,
  } = params;

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

  // we're passing store here for validation
  const preprocessor = _getModelPreprocessingRunnable(
    stateModifier,
    messageModifier
  );
  const modelRunnable = (preprocessor as Runnable).pipe(modelWithTools);

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
    // TODO: Auto-promote streaming.
    return { messages: [await modelRunnable.invoke(state, config)] };
  };

  const workflow = new StateGraph(stateSchema ?? MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", new ToolNode(toolClasses))
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
    store,
  });
}
