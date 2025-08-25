import { LanguageModelLike } from "@langchain/core/language_models/base";
import { StructuredToolInterface, DynamicTool } from "@langchain/core/tools";
import { RunnableToolLike } from "@langchain/core/runnables";
import { InteropZodType } from "@langchain/core/utils/types";
import {
  START,
  StateGraph,
  CompiledStateGraph,
  AnnotationRoot,
  MessagesAnnotation,
} from "@langchain/langgraph";
import {
  createReactAgent,
  createReactAgentAnnotation,
  CreateReactAgentParams,
  withAgentName,
  AgentNameMode,
} from "@langchain/langgraph/prebuilt";
import {
  BaseChatModel,
  BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import { createHandoffTool, createHandoffBackMessages } from "./handoff.js";

export type { AgentNameMode };
export { withAgentName };

type OutputMode = "full_history" | "last_message";
const PROVIDERS_WITH_PARALLEL_TOOL_CALLS_PARAM = new Set(["ChatOpenAI"]);

// type guards
type ChatModelWithBindTools = BaseChatModel & {
  bindTools(tools: BindToolsInput[], kwargs?: unknown): LanguageModelLike;
};

type ChatModelWithParallelToolCallsParam = BaseChatModel & {
  bindTools(
    tools: BindToolsInput[],
    kwargs?: { parallel_tool_calls?: boolean } & Record<string, unknown>
  ): LanguageModelLike;
};

function isChatModelWithBindTools(
  llm: LanguageModelLike
): llm is ChatModelWithBindTools {
  return (
    "_modelType" in llm &&
    typeof llm._modelType === "function" &&
    llm._modelType() === "base_chat_model" &&
    "bindTools" in llm &&
    typeof llm.bindTools === "function"
  );
}

function isChatModelWithParallelToolCallsParam(
  llm: ChatModelWithBindTools
): llm is ChatModelWithParallelToolCallsParam {
  return llm.bindTools.length >= 2;
}

const makeCallAgent = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: any, // TODO: agent should not be `any`
  outputMode: OutputMode,
  addHandoffBackMessages: boolean,
  supervisorName: string
) => {
  if (!["full_history", "last_message"].includes(outputMode)) {
    throw new Error(
      `Invalid agent output mode: ${outputMode}. Needs to be one of ["full_history", "last_message"]`
    );
  }

  return async (state: Record<string, unknown>) => {
    const output = await agent.invoke(state);
    let { messages } = output;

    if (outputMode === "last_message") {
      messages = messages.slice(-1);
    }

    if (addHandoffBackMessages) {
      messages.push(...createHandoffBackMessages(agent.name, supervisorName));
    }
    return { ...output, messages };
  };
};

export type CreateSupervisorParams<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AnnotationRootT extends AnnotationRoot<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StructuredResponseFormat extends Record<string, any> = Record<string, any>
> = {
  /**
   * List of agents to manage
   */
  agents: CompiledStateGraph<
    AnnotationRootT["State"],
    AnnotationRootT["Update"],
    string,
    AnnotationRootT["spec"],
    AnnotationRootT["spec"]
  >[];

  /**
   * Language model to use for the supervisor
   */
  llm: LanguageModelLike;

  /**
   * Tools to use for the supervisor
   */
  tools?: (StructuredToolInterface | RunnableToolLike | DynamicTool)[];

  /**
   * An optional prompt for the supervisor. Can be one of:
   * - `string`: This is converted to a SystemMessage and added to the beginning of the list of messages in state["messages"]
   * - `SystemMessage`: this is added to the beginning of the list of messages in state["messages"]
   * - `Function`: This function should take in full graph state and the output is then passed to the language model
   * - `Runnable`: This runnable should take in full graph state and the output is then passed to the language model
   */
  prompt?: CreateReactAgentParams["prompt"];

  /**
   * An optional schema for the final supervisor output.
   */
  responseFormat?:
    | InteropZodType<StructuredResponseFormat>
    | {
        prompt: string;
        schema:
          | InteropZodType<StructuredResponseFormat>
          | Record<string, unknown>;
      }
    | Record<string, unknown>;

  /**
   * State schema to use for the supervisor graph
   */
  stateSchema?: AnnotationRootT;

  /**
   * Context schema to use for the supervisor graph
   */
  contextSchema?: AnnotationRootT;

  /**
   * Mode for adding managed agents' outputs to the message history in the multi-agent workflow.
   * Can be one of:
   * - `"full_history"`: add the entire agent message history
   * - `"last_message"`: add only the last message (default)
   */
  outputMode?: OutputMode;

  /**
   * Whether to add a pair of (AIMessage, ToolMessage) to the message history
   * when returning control to the supervisor to indicate that a handoff has occurred
   */
  addHandoffBackMessages?: boolean;

  /**
   * Name of the supervisor node
   */
  supervisorName?: string;

  /**
   * Use to specify how to expose the agent name to the underlying supervisor LLM.
   * - `undefined`: Relies on the LLM provider using the name attribute on the AI message. Currently, only OpenAI supports this.
   * - `"inline"`: Add the agent name directly into the content field of the AI message using XML-style tags.
   *   Example: "How can I help you" -> "<name>agent_name</name><content>How can I help you?</content>"
   */
  includeAgentName?: AgentNameMode;

  /**
   * An optional node to add before the LLM node in the supervisor agent (i.e., the node that calls the LLM).
   * Useful for managing long message histories (e.g., message trimming, summarization, etc.).
   *
   * Pre-model hook must be a callable or a runnable that takes in current graph state and returns a state update in the form of:
   * ```javascript
   * {
   *   messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...],
   *   llmInputMessages: [...]
   *   ...
   * }
   * ```
   * **Important**: At least one of `messages` or `llmInputMessages` MUST be provided and will be used as an input to the `agent` node.
   * The rest of the keys will be added to the graph state.
   *
   *
   * **Warning**: If you are returning `messages` in the pre-model hook, you should OVERWRITE the `messages` key by doing the following:
   * ```javascript
   * { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...newMessages], ... }
   * ```
   */
  preModelHook?: CreateReactAgentParams<
    AnnotationRootT,
    StructuredResponseFormat
  >["preModelHook"];

  /**
   * An optional node to add after the LLM node in the supervisor agent (i.e., the node that calls the LLM).
   * Useful for implementing human-in-the-loop, guardrails, validation, or other post-processing.
   * Post-model hook must be a callable or a runnable that takes in current graph state and returns a state update.
   */
  postModelHook?: CreateReactAgentParams<
    AnnotationRootT,
    StructuredResponseFormat
  >["postModelHook"];
};

/**
 * Create a multi-agent supervisor.
 *
 * @param agents List of agents to manage
 * @param llm Language model to use for the supervisor
 * @param tools Tools to use for the supervisor
 * @param prompt Optional prompt to use for the supervisor. Can be one of:
 *   - string: This is converted to a SystemMessage and added to the beginning of the list of messages in state["messages"]
 *   - SystemMessage: this is added to the beginning of the list of messages in state["messages"]
 *   - Function: This function should take in full graph state and the output is then passed to the language model
 *   - Runnable: This runnable should take in full graph state and the output is then passed to the language model
 * @param responseFormat An optional schema for the final supervisor output.
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
 * @param preModelHook An optional node to add before the LLM node in the supervisor agent (i.e., the node that calls the LLM).
 *   Useful for managing long message histories (e.g., message trimming, summarization, etc.).
 *   Pre-model hook must be a callable or a runnable that takes in current graph state and returns a state update in the form of:
 *   ```javascript
 *   // At least one of `messages` or `llmInputMessages` MUST be provided
 *   {
 *     // If provided, will UPDATE the `messages` in the state
 *     messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...],
 *     // If provided, will be used as the input to the LLM,
 *     // and will NOT UPDATE `messages` in the state
 *     llmInputMessages: [...]
 *     // Any other state keys that need to be propagated...
 *   }
 *   ```
 *   **Important**: At least one of `messages` or `llmInputMessages` MUST be provided and will be used as an input to the `agent` node.
 *   The rest of the keys will be added to the graph state.
 *
 *   **Warning**: If you are returning `messages` in the pre-model hook, you should OVERWRITE the `messages` key by doing the following:
 *   ```javascript
 *   { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...newMessages], ... }
 *   ```
 * @param postModelHook An optional node to add after the LLM node in the supervisor agent (i.e., the node that calls the LLM).
 *   Useful for implementing human-in-the-loop, guardrails, validation, or other post-processing.
 *   Post-model hook must be a callable or a runnable that takes in current graph state and returns a state update.
 * @param stateSchema State schema to use for the supervisor graph
 * @param contextSchema Context schema to use for the supervisor graph
 * @param outputMode Mode for adding managed agents' outputs to the message history in the multi-agent workflow.
 *   Can be one of:
 *   - `full_history`: add the entire agent message history
 *   - `last_message`: add only the last message (default)
 * @param addHandoffBackMessages Whether to add a pair of (AIMessage, ToolMessage) to the message history
 *   when returning control to the supervisor to indicate that a handoff has occurred
 * @param supervisorName Name of the supervisor node
 * @param includeAgentName Use to specify how to expose the agent name to the underlying supervisor LLM.
 *   - undefined: Relies on the LLM provider using the name attribute on the AI message. Currently, only OpenAI supports this.
 *   - "inline": Add the agent name directly into the content field of the AI message using XML-style tags.
 *     Example: "How can I help you" -> "<name>agent_name</name><content>How can I help you?</content>"
 */
const createSupervisor = <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AnnotationRootT extends AnnotationRoot<any> = typeof MessagesAnnotation,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StructuredResponseFormat extends Record<string, any> = Record<string, any>
>({
  agents,
  llm,
  tools,
  prompt,
  responseFormat,
  stateSchema,
  contextSchema,
  outputMode = "last_message",
  addHandoffBackMessages = true,
  supervisorName = "supervisor",
  includeAgentName,
  preModelHook,
  postModelHook,
}: CreateSupervisorParams<
  AnnotationRootT,
  StructuredResponseFormat
>): StateGraph<
  AnnotationRootT["spec"],
  AnnotationRootT["State"],
  AnnotationRootT["Update"],
  string,
  AnnotationRootT["spec"],
  AnnotationRootT["spec"]
> => {
  const agentNames = new Set<string>();

  for (const agent of agents) {
    if (!agent.name || agent.name === "LangGraph") {
      throw new Error(
        "Please specify a name when you create your agent, either via `createReactAgent({ ..., name: agentName })` " +
          "or via `graph.compile({ name: agentName })`."
      );
    }

    if (agentNames.has(agent.name)) {
      throw new Error(
        `Agent with name '${agent.name}' already exists. Agent names must be unique.`
      );
    }

    agentNames.add(agent.name);
  }

  const handoffTools = agents.map(({ name, description }) =>
    createHandoffTool({ agentName: name!, agentDescription: description })
  );
  const allTools = [...(tools ?? []), ...handoffTools];

  let supervisorLLM = llm;
  if (isChatModelWithBindTools(llm)) {
    if (
      isChatModelWithParallelToolCallsParam(llm) &&
      PROVIDERS_WITH_PARALLEL_TOOL_CALLS_PARAM.has(llm.getName())
    ) {
      supervisorLLM = llm.bindTools(allTools, { parallel_tool_calls: false });
    } else {
      supervisorLLM = llm.bindTools(allTools);
    }

    // hack: with newer version of LangChain we've started using `withConfig()` instead of `bind()`
    // when binding tools, thus older version of LangGraph will incorrectly try to bind tools twice.
    // TODO: remove when we start handling tools from config in @langchain/langgraph

    // @ts-expect-error hack
    supervisorLLM.kwargs ??= {};

    // @ts-expect-error hack
    // eslint-disable-next-line prefer-destructuring
    const kwargs = supervisorLLM.kwargs;

    if (!("tools" in kwargs)) {
      if (
        "config" in supervisorLLM &&
        typeof supervisorLLM.config === "object" &&
        supervisorLLM.config != null &&
        "tools" in supervisorLLM.config
      ) {
        kwargs.tools = supervisorLLM.config.tools;
      }
    }
  }

  // Apply agent name handling if specified
  if (includeAgentName) {
    supervisorLLM = withAgentName(supervisorLLM, includeAgentName);
  }

  const schema = stateSchema ?? createReactAgentAnnotation();
  const supervisorAgent = createReactAgent({
    name: supervisorName,
    llm: supervisorLLM,
    tools: allTools,
    prompt,
    responseFormat,
    stateSchema: schema as AnnotationRootT,
    preModelHook,
    postModelHook,
  });

  let builder = new StateGraph(schema, contextSchema)
    .addNode(supervisorAgent.name!, supervisorAgent, {
      ends: [...agentNames],
    })
    .addEdge(START, supervisorAgent.name!);

  for (const agent of agents) {
    builder = builder.addNode(
      agent.name!,
      makeCallAgent(agent, outputMode, addHandoffBackMessages, supervisorName),
      { subgraphs: [agent] }
    );
    builder = builder.addEdge(agent.name!, supervisorAgent.name!);
  }

  return builder;
};

export { createSupervisor, type OutputMode };
