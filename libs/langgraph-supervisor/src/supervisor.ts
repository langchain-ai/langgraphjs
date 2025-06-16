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
  agents: CompiledStateGraph<
    AnnotationRootT["State"],
    AnnotationRootT["Update"],
    string,
    AnnotationRootT["spec"],
    AnnotationRootT["spec"]
  >[];
  llm: LanguageModelLike;
  tools?: (StructuredToolInterface | RunnableToolLike | DynamicTool)[];
  prompt?: CreateReactAgentParams["prompt"];
  responseFormat?:
    | InteropZodType<StructuredResponseFormat>
    | {
        prompt: string;
        schema:
          | InteropZodType<StructuredResponseFormat>
          | Record<string, unknown>;
      }
    | Record<string, unknown>;
  stateSchema?: AnnotationRootT;
  outputMode?: OutputMode;
  addHandoffBackMessages?: boolean;
  supervisorName?: string;
  includeAgentName?: AgentNameMode;
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
 * @param stateSchema State schema to use for the supervisor graph
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
  outputMode = "last_message",
  addHandoffBackMessages = true,
  supervisorName = "supervisor",
  includeAgentName,
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

  const handoffTools = agents.map((agent) =>
    createHandoffTool({ agentName: agent.name! })
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
    stateSchema: schema,
  });

  let builder = new StateGraph(schema)
    .addNode(supervisorAgent.name!, supervisorAgent, {
      ends: [...agentNames],
    })
    .addEdge(START, supervisorAgent.name!);

  for (const agent of agents) {
    builder = builder.addNode(
      agent.name!,
      makeCallAgent(agent, outputMode, addHandoffBackMessages, supervisorName),
      {
        subgraphs: [agent],
      }
    );
    builder = builder.addEdge(agent.name!, supervisorAgent.name!);
  }

  return builder;
};

export { createSupervisor, type OutputMode };
