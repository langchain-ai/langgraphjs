import {
  BaseChatModel,
  BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import { LanguageModelLike } from "@langchain/core/language_models/base";
import {
  BaseMessage,
  BaseMessageLike,
  isAIMessage,
  isBaseMessage,
  isToolMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  Runnable,
  RunnableConfig,
  RunnableInterface,
  RunnableLambda,
  RunnableToolLike,
  RunnableSequence,
  RunnableBinding,
} from "@langchain/core/runnables";
import { DynamicTool, StructuredToolInterface } from "@langchain/core/tools";
import {
  All,
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import { z } from "zod";

import {
  StateGraph,
  CompiledStateGraph,
  AnnotationRoot,
} from "../graph/index.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";
import { ToolNode } from "./tool_node.js";
import { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import { Annotation } from "../graph/annotation.js";
import { Messages, messagesStateReducer } from "../graph/message.js";
import { END, START } from "../constants.js";

export interface AgentState<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

export type StructuredResponseSchemaAndPrompt<StructuredResponseType> = {
  prompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodType<StructuredResponseType> | Record<string, any>;
};

function _convertMessageModifierToPrompt(
  messageModifier: MessageModifier
): Prompt {
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

const PROMPT_RUNNABLE_NAME = "prompt";

function _getPromptRunnable(prompt?: Prompt): RunnableInterface {
  let promptRunnable: RunnableInterface;

  if (prompt == null) {
    promptRunnable = RunnableLambda.from(
      (state: typeof MessagesAnnotation.State) => state.messages
    ).withConfig({ runName: PROMPT_RUNNABLE_NAME });
  } else if (typeof prompt === "string") {
    const systemMessage = new SystemMessage(prompt);
    promptRunnable = RunnableLambda.from(
      (state: typeof MessagesAnnotation.State) => {
        return [systemMessage, ...(state.messages ?? [])];
      }
    ).withConfig({ runName: PROMPT_RUNNABLE_NAME });
  } else if (isBaseMessage(prompt) && prompt._getType() === "system") {
    promptRunnable = RunnableLambda.from(
      (state: typeof MessagesAnnotation.State) => [prompt, ...state.messages]
    ).withConfig({ runName: PROMPT_RUNNABLE_NAME });
  } else if (typeof prompt === "function") {
    promptRunnable = RunnableLambda.from(prompt).withConfig({
      runName: PROMPT_RUNNABLE_NAME,
    });
  } else if (Runnable.isRunnable(prompt)) {
    promptRunnable = prompt;
  } else {
    throw new Error(`Got unexpected type for 'prompt': ${typeof prompt}`);
  }

  return promptRunnable;
}

function _getPrompt(
  prompt?: Prompt,
  stateModifier?: CreateReactAgentParams["stateModifier"],
  messageModifier?: CreateReactAgentParams["messageModifier"]
) {
  // Check if multiple modifiers exist
  const definedCount = [prompt, stateModifier, messageModifier].filter(
    (x) => x != null
  ).length;
  if (definedCount > 1) {
    throw new Error(
      "Expected only one of prompt, stateModifier, or messageModifier, got multiple values"
    );
  }

  let finalPrompt = prompt;
  if (stateModifier != null) {
    finalPrompt = stateModifier;
  } else if (messageModifier != null) {
    finalPrompt = _convertMessageModifierToPrompt(messageModifier);
  }

  return _getPromptRunnable(finalPrompt);
}

function _isBaseChatModel(model: LanguageModelLike): model is BaseChatModel {
  return (
    "invoke" in model &&
    typeof model.invoke === "function" &&
    "_modelType" in model
  );
}

export function _shouldBindTools(
  llm: LanguageModelLike,
  tools: (StructuredToolInterface | DynamicTool | RunnableToolLike)[]
): boolean {
  // If model is a RunnableSequence, find a RunnableBinding or BaseChatModel in its steps
  let model = llm;
  if (RunnableSequence.isRunnableSequence(model)) {
    model =
      model.steps.find(
        (step) =>
          RunnableBinding.isRunnableBinding(step) || _isBaseChatModel(step)
      ) || model;
  }

  // If not a RunnableBinding, we should bind tools
  if (!RunnableBinding.isRunnableBinding(model)) {
    return true;
  }

  // If no tools in kwargs, we should bind tools
  if (
    !model.kwargs ||
    typeof model.kwargs !== "object" ||
    !("tools" in model.kwargs)
  ) {
    return true;
  }

  let boundTools = model.kwargs.tools as BindToolsInput[];
  // google-style
  if (boundTools.length === 1 && "functionDeclarations" in boundTools[0]) {
    boundTools = boundTools[0].functionDeclarations;
  }

  // Check if tools count matches
  if (tools.length !== boundTools.length) {
    throw new Error(
      "Number of tools in the model.bindTools() and tools passed to createReactAgent must match"
    );
  }

  const toolNames = new Set(tools.map((tool) => tool.name));
  const boundToolNames = new Set<string>();

  for (const boundTool of boundTools) {
    let boundToolName: string | undefined;

    // OpenAI-style tool
    if ("type" in boundTool && boundTool.type === "function") {
      boundToolName = boundTool.function.name;
    }
    // Anthropic- or Google-style tool
    else if ("name" in boundTool) {
      boundToolName = boundTool.name;
    }
    // Bedrock-style tool
    else if ("toolSpec" in boundTool && "name" in boundTool.toolSpec) {
      boundToolName = boundTool.toolSpec.name;
    }
    // unknown tool type so we'll ignore it
    else {
      continue;
    }

    if (boundToolName) {
      boundToolNames.add(boundToolName);
    }
  }

  const missingTools = [...toolNames].filter((x) => !boundToolNames.has(x));
  if (missingTools.length > 0) {
    throw new Error(
      `Missing tools '${missingTools}' in the model.bindTools().` +
        `Tools in the model.bindTools() must match the tools passed to createReactAgent.`
    );
  }

  return false;
}

export function _getModel(llm: LanguageModelLike): BaseChatModel {
  // If model is a RunnableSequence, find a RunnableBinding or BaseChatModel in its steps
  let model = llm;
  if (RunnableSequence.isRunnableSequence(model)) {
    model =
      model.steps.find(
        (step) =>
          RunnableBinding.isRunnableBinding(step) || _isBaseChatModel(step)
      ) || model;
  }

  // Get the underlying model from a RunnableBinding
  if (RunnableBinding.isRunnableBinding(model)) {
    model = model.bound as BaseChatModel;
  }

  if (!_isBaseChatModel(model)) {
    throw new Error(
      `Expected \`llm\` to be a ChatModel or RunnableBinding (e.g. llm.bind_tools(...)) with invoke() and generate() methods, got ${model.constructor.name}`
    );
  }

  return model as BaseChatModel;
}

export type Prompt =
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

/** @deprecated Use Prompt instead. */
export type StateModifier = Prompt;

/** @deprecated Use Prompt instead. */
export type MessageModifier =
  | SystemMessage
  | string
  | ((messages: BaseMessage[]) => BaseMessage[])
  | ((messages: BaseMessage[]) => Promise<BaseMessage[]>)
  | Runnable;

export const createReactAgentAnnotation = <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StructuredResponseType = Record<string, any>
> = {
  /** The chat model that can utilize OpenAI-style tool calling. */
  llm: LanguageModelLike;
  /** A list of tools or a ToolNode. */
  tools:
    | ToolNode
    | (StructuredToolInterface | DynamicTool | RunnableToolLike)[];
  /**
   * @deprecated Use prompt instead.
   */
  messageModifier?: MessageModifier;
  /**
   * @deprecated Use prompt instead.
   */
  stateModifier?: StateModifier;
  /**
   * An optional prompt for the LLM. This takes full graph state BEFORE the LLM is called and prepares the input to LLM.
   *
   * Can take a few different forms:
   *
   * - str: This is converted to a SystemMessage and added to the beginning of the list of messages in state["messages"].
   * - SystemMessage: this is added to the beginning of the list of messages in state["messages"].
   * - Function: This function should take in full graph state and the output is then passed to the language model.
   * - Runnable: This runnable should take in full graph state and the output is then passed to the language model.
   *
   * Note:
   * Prior to `v0.2.46`, the prompt was set using `stateModifier` / `messagesModifier` parameters.
   * This is now deprecated and will be removed in a future release.
   */
  prompt?: Prompt;
  stateSchema?: A;
  /** An optional checkpoint saver to persist the agent's state. */
  checkpointSaver?: BaseCheckpointSaver;
  /** An optional checkpoint saver to persist the agent's state. Alias of "checkpointSaver". */
  checkpointer?: BaseCheckpointSaver;
  /** An optional list of node names to interrupt before running. */
  interruptBefore?: N[] | All;
  /** An optional list of node names to interrupt after running. */
  interruptAfter?: N[] | All;
  store?: BaseStore;
  /**
   * An optional schema for the final agent output.
   *
   * If provided, output will be formatted to match the given schema and returned in the 'structuredResponse' state key.
   * If not provided, `structuredResponse` will not be present in the output state.
   *
   * Can be passed in as:
   *   - Zod schema
   *   - JSON schema
   *   - { prompt, schema }, where schema is one of the above.
   *        The prompt will be used together with the model that is being used to generate the structured response.
   *
   * @remarks
   * **Important**: `responseFormat` requires the model to support `.withStructuredOutput()`.
   *
   * **Note**: The graph will make a separate call to the LLM to generate the structured response after the agent loop is finished.
   * This is not the only strategy to get structured responses, see more options in [this guide](https://langchain-ai.github.io/langgraph/how-tos/react-agent-structured-output/).
   */
  responseFormat?:
    | z.ZodType<StructuredResponseType>
    | StructuredResponseSchemaAndPrompt<StructuredResponseType>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | Record<string, any>;
  name?: string;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types
  A extends AnnotationRoot<any> = typeof MessagesAnnotation,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StructuredResponseFormat extends Record<string, any> = Record<string, any>
>(
  params: CreateReactAgentParams<A, StructuredResponseFormat>
): CompiledStateGraph<
  A["State"],
  A["Update"],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  typeof MessagesAnnotation.spec & A["spec"],
  ReturnType<
    typeof createReactAgentAnnotation<StructuredResponseFormat>
  >["spec"] &
    A["spec"]
> {
  const {
    llm,
    tools,
    messageModifier,
    stateModifier,
    prompt,
    stateSchema,
    checkpointSaver,
    checkpointer,
    interruptBefore,
    interruptAfter,
    store,
    responseFormat,
    name,
  } = params;

  let toolClasses: (StructuredToolInterface | DynamicTool | RunnableToolLike)[];
  let toolNode: ToolNode;
  if (!Array.isArray(tools)) {
    toolClasses = tools.tools;
    toolNode = tools;
  } else {
    toolClasses = tools;
    toolNode = new ToolNode(tools);
  }

  let modelWithTools: LanguageModelLike;
  if (_shouldBindTools(llm, toolClasses)) {
    if (!("bindTools" in llm) || typeof llm.bindTools !== "function") {
      throw new Error(`llm ${llm} must define bindTools method.`);
    }
    modelWithTools = llm.bindTools(toolClasses);
  } else {
    modelWithTools = llm;
  }

  const modelRunnable = (
    _getPrompt(prompt, stateModifier, messageModifier) as Runnable
  ).pipe(modelWithTools);

  // If any of the tools are configured to return_directly after running,
  // our graph needs to check if these were called
  const shouldReturnDirect = new Set(
    toolClasses
      .filter((tool) => "returnDirect" in tool && tool.returnDirect)
      .map((tool) => tool.name)
  );

  const shouldContinue = (state: AgentState<StructuredResponseFormat>) => {
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
    state: AgentState<StructuredResponseFormat>,
    config?: RunnableConfig
  ) => {
    if (responseFormat == null) {
      throw new Error(
        "Attempted to generate structured output with no passed response schema. Please contact us for help."
      );
    }
    const messages = [...state.messages];
    let modelWithStructuredOutput;

    if (
      typeof responseFormat === "object" &&
      "prompt" in responseFormat &&
      "schema" in responseFormat
    ) {
      const { prompt, schema } = responseFormat;
      modelWithStructuredOutput = _getModel(llm).withStructuredOutput(schema);
      messages.unshift(new SystemMessage({ content: prompt }));
    } else {
      modelWithStructuredOutput =
        _getModel(llm).withStructuredOutput(responseFormat);
    }

    const response = await modelWithStructuredOutput.invoke(messages, config);
    return { structuredResponse: response };
  };

  const callModel = async (
    state: AgentState<StructuredResponseFormat>,
    config?: RunnableConfig
  ) => {
    // TODO: Auto-promote streaming.
    const response = (await modelRunnable.invoke(state, config)) as BaseMessage;
    // add agent name to the AIMessage
    // TODO: figure out if we can avoid mutating the message directly
    response.name = name;
    response.lc_kwargs.name = name;
    return { messages: [response] };
  };

  const workflow = new StateGraph(
    stateSchema ?? createReactAgentAnnotation<StructuredResponseFormat>()
  )
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge(START, "agent");

  if (responseFormat !== undefined) {
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

  const routeToolResponses = (state: AgentState<StructuredResponseFormat>) => {
    // Check the last consecutive tool calls
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const message = state.messages[i];
      if (!isToolMessage(message)) {
        break;
      }
      // Check if this tool is configured to return directly
      if (message.name !== undefined && shouldReturnDirect.has(message.name)) {
        return END;
      }
    }
    return "agent";
  };

  if (shouldReturnDirect.size > 0) {
    workflow.addConditionalEdges("tools", routeToolResponses, ["agent", END]);
  } else {
    workflow.addEdge("tools", "agent");
  }

  return workflow.compile({
    checkpointer: checkpointer ?? checkpointSaver,
    interruptBefore,
    interruptAfter,
    store,
    name,
  });
}
