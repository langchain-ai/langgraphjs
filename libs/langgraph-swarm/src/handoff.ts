import { z } from "zod";
import { ToolMessage } from "@langchain/core/messages";
import {
  DynamicTool,
  StructuredToolInterface,
  tool,
} from "@langchain/core/tools";
import { RunnableToolLike } from "@langchain/core/runnables";
import {
  AnnotationRoot,
  MessagesAnnotation,
  Command,
  CompiledStateGraph,
  getCurrentTaskInput,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

const WHITESPACE_RE = /\s+/g;
const METADATA_KEY_HANDOFF_DESTINATION = "__handoff_destination";

function _normalizeAgentName(agentName: string): string {
  /**
   * Normalize an agent name to be used inside the tool name.
   */
  return agentName.trim().replace(WHITESPACE_RE, "_").toLowerCase();
}

/** @inline */
interface CreateHandoffToolParams {
  /**
   * The name of the agent to handoff control to, i.e. the name of the agent node in the multi-agent graph.
   *
   * Agent names should be simple, clear and unique, preferably in snake_case,
   * although you are only limited to the names accepted by LangGraph
   * nodes as well as the tool names accepted by LLM providers
   * (the tool name will look like this: `transfer_to_<agent_name>`).
   */
  agentName: string;

  /** Optional description for the handoff tool. */
  description?: string;
}

// type guard
function isDynamicTool(
  tool: StructuredToolInterface | DynamicTool | RunnableToolLike
): tool is DynamicTool {
  return (
    "schema" in tool &&
    "name" in tool &&
    "description" in tool &&
    "responseFormat" in tool
  );
}

/**
 * Create a tool that can handoff control to the requested agent.
 *
 * @param params Parameters for the handoff tool.
 */
const createHandoffTool = ({
  agentName,
  description,
}: CreateHandoffToolParams) => {
  const toolName = `transfer_to_${_normalizeAgentName(agentName)}`;
  const toolDescription = description || `Ask agent '${agentName}' for help`;

  const handoffTool = tool(
    async (_, config) => {
      /**
       * Ask another agent for help.
       */
      const toolMessage = new ToolMessage({
        content: `Successfully transferred to ${agentName}`,
        name: toolName,
        tool_call_id: config.toolCall.id,
      });

      // inject the current agent state
      const state =
        getCurrentTaskInput() as (typeof MessagesAnnotation)["State"];
      return new Command({
        goto: agentName,
        graph: Command.PARENT,
        update: {
          messages: state.messages.concat(toolMessage),
          activeAgent: agentName,
        },
      });
    },
    {
      name: toolName,
      schema: z.object({}),
      description: toolDescription,
    }
  );

  handoffTool.metadata = { [METADATA_KEY_HANDOFF_DESTINATION]: agentName };
  return handoffTool;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getHandoffDestinations = <AnnotationRootT extends AnnotationRoot<any>>(
  agent: CompiledStateGraph<
    AnnotationRootT["State"],
    AnnotationRootT["Update"],
    string,
    AnnotationRootT["spec"],
    AnnotationRootT["spec"]
  >,
  toolNodeName: string = "tools"
): string[] => {
  /**
   * Get a list of destinations from agent's handoff tools.
   *
   * @param agent - The compiled state graph
   * @param toolNodeName - The name of the tool node in the graph
   */
  const { nodes } = agent.getGraph();
  if (!(toolNodeName in nodes)) {
    return [];
  }

  const toolNode = nodes[toolNodeName].data;
  if (!toolNode || !("tools" in toolNode) || !toolNode.tools) {
    return [];
  }

  const { tools } = toolNode as ToolNode;
  return tools
    .filter(
      (tool): tool is DynamicTool =>
        isDynamicTool(tool) &&
        tool.metadata !== undefined &&
        METADATA_KEY_HANDOFF_DESTINATION in tool.metadata
    )
    .map((tool) => tool.metadata![METADATA_KEY_HANDOFF_DESTINATION] as string);
};

export {
  createHandoffTool,
  getHandoffDestinations,
  METADATA_KEY_HANDOFF_DESTINATION,
};
