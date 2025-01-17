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
import { z } from "zod";

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
import { Annotation } from "../graph/annotation.js";
import { Messages, messagesStateReducer } from "../graph/message.js";

export interface AgentState<
  StructuredResponseType extends Record<string, any> = Record<string, any>
> {
  messages: BaseMessage[];
  // TODO: This won't be set until we
  // implement managed values in LangGraphJS
  // Will be useful for inserting a message on
  // graph recursion end
  // is_last_step: boolean;
  structuredResponse: StructuredResponseType;
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

export const createReactAgentAnnotation = <
  T extends Record<string, any> = Record<string, any>
>() =>
  Annotation.Root({
    messages: Annotation<BaseMessage[], Messages>({
      reducer: messagesStateReducer,
      default: () => [],
    }),
    structuredResponse: Annotation<T>,
  });

export type CreateReactAgentParams<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A extends AnnotationRoot<any> = AnnotationRoot<any>,
  StructuredResponseType extends Record<string, any> = Record<string, any>
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
  /**
   * An optional schema for the final agent output.
   *
   * If provided, output will be formatted to match the given schema and returned in the 'structured_response' state key.
   * If not provided, `structured_response` will not be present in the output state.
   *
   * Can be passed in as:
   *   - Zod schema
   *   - Dictionary object
   *   - [prompt, schema], where schema is one of the above.
   *        The prompt will be used together with the model that is being used to generate the structured response.
   */
  responseFormat?:
    | z.ZodType<StructuredResponseType>
    | {
        prompt: string;
        schema: z.ZodType<StructuredResponseType> | Record<string, any>;
      }
    | Record<string, any>;
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
  A extends AnnotationRoot<any> = AnnotationRoot<{}>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends Record<string, any> = Record<string, any>
>(
  params: CreateReactAgentParams<A, T>
): CompiledStateGraph<
  (typeof MessagesAnnotation)["State"],
  (typeof MessagesAnnotation)["Update"],
  typeof params extends { responseFormat: any }
    ? typeof START | "agent" | "tools" | "generate_structured_response"
    : typeof START | "agent" | "tools",
  typeof MessagesAnnotation.spec & A["spec"],
  ReturnType<typeof createReactAgentAnnotation<T>>["spec"] & A["spec"]
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
    responseFormat,
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

  const shouldContinue = (state: AgentState<T>) => {
    const { messages } = state;
    const lastMessage = messages[messages.length - 1];
    if (
      isAIMessage(lastMessage) &&
      (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0)
    ) {
      return responseFormat != null ? "generate_structured_response" : END;
    } else {
      return "continue";
    }
  };

  const generateStructuredResponse = async (
    state: AgentState<T>,
    config?: RunnableConfig
  ) => {
    if (responseFormat == null) {
      throw new Error(
        "Attempted to generate structured output with no passed response schema. Please contact us for help."
      );
    }
    // Exclude the last message as there's enough information
    // for the LLM to generate the structured response
    const messages = state.messages.slice(0, -1);
    let modelWithStructuredOutput;

    if (
      typeof responseFormat === "object" &&
      "prompt" in responseFormat &&
      "schema" in responseFormat
    ) {
      const { prompt, schema } = responseFormat;
      modelWithStructuredOutput = llm.withStructuredOutput(schema);
      messages.unshift(new SystemMessage({ content: prompt }));
    } else {
      modelWithStructuredOutput = llm.withStructuredOutput(responseFormat);
    }

    const response = await modelWithStructuredOutput.invoke(messages, config);
    return { structuredResponse: response };
  };

  const callModel = async (state: AgentState<T>, config?: RunnableConfig) => {
    // TODO: Auto-promote streaming.
    return { messages: [await modelRunnable.invoke(state, config)] };
  };

  const workflow = new StateGraph(
    stateSchema ?? createReactAgentAnnotation<T>()
  )
    .addNode("agent", callModel)
    .addNode("tools", new ToolNode(toolClasses))
    .addEdge(START, "agent")
    .addEdge("tools", "agent");

  if (responseFormat) {
    workflow
      .addNode("generate_structured_response", generateStructuredResponse)
      .addEdge("generate_structured_response", END)
      .addConditionalEdges("agent", shouldContinue, {
        continue: "tools",
        [END]: END,
        generate_structured_response: "generate_structured_response",
      });
  } else {
    workflow.addConditionalEdges("agent", shouldContinue, {
      continue: "tools",
      [END]: END,
    });
  }

  return workflow.compile({
    checkpointer: checkpointSaver,
    interruptBefore,
    interruptAfter,
    store,
  });
}
