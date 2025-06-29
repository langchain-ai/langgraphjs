import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  Command,
  MessagesAnnotation,
  getCurrentTaskInput,
} from "@langchain/langgraph";

const WHITESPACE_RE = /\s+/;
const METADATA_KEY_IS_HANDOFF_BACK = "__is_handoff_back";

function _normalizeAgentName(agentName: string): string {
  /**
   * Normalize an agent name to be used inside the tool name.
   */
  return agentName.trim().replace(WHITESPACE_RE, "_").toLowerCase();
}

const createHandoffTool = ({ agentName }: { agentName: string }) => {
  /**
   * Create a tool that can handoff control to the requested agent.
   *
   * @param agentName - The name of the agent to handoff control to, i.e.
   *   the name of the agent node in the multi-agent graph.
   *   Agent names should be simple, clear and unique, preferably in snake_case,
   *   although you are only limited to the names accepted by LangGraph
   *   nodes as well as the tool names accepted by LLM providers
   *   (the tool name will look like this: `transfer_to_<agent_name>`).
   */
  const toolName = `transfer_to_${_normalizeAgentName(agentName)}`;

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
        update: { ...state, messages: state.messages.concat(toolMessage) },
      });
    },
    {
      name: toolName,
      schema: z.object({}),
      description: "Ask another agent for help.",
    }
  );
  return handoffTool;
};

function createHandoffBackMessages(
  agentName: string,
  supervisorName: string
): [AIMessage, ToolMessage] {
  /**
   * Create a pair of (AIMessage, ToolMessage) to add to the message history when returning control to the supervisor.
   */
  const toolCallId = uuidv4();
  const toolName = `transfer_back_to_${_normalizeAgentName(supervisorName)}`;
  const toolCalls = [{ name: toolName, args: {}, id: toolCallId }];

  return [
    new AIMessage({
      content: `Transferring back to ${supervisorName}`,
      tool_calls: toolCalls,
      name: agentName,
      response_metadata: { [METADATA_KEY_IS_HANDOFF_BACK]: true },
    }),
    new ToolMessage({
      content: `Successfully transferred back to ${supervisorName}`,
      name: toolName,
      tool_call_id: toolCallId,
      response_metadata: { [METADATA_KEY_IS_HANDOFF_BACK]: true },
    }),
  ];
}

/**
 * Check if a value is an AIMessage
 * This avoids using instanceof which is not allowed by the linter
 */
function isAIMessage(value: unknown): value is AIMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "ai"
  );
}

/**
 * Check if response metadata has the handoff back flag
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasHandoffBackFlag(metadata: Record<string, any>): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return (
    METADATA_KEY_IS_HANDOFF_BACK in metadata &&
    metadata[METADATA_KEY_IS_HANDOFF_BACK]
  );
}

/**
 * Create a tool the supervisor can use to forward a worker message by name.
 *
 * This helps avoid information loss any time the supervisor rewrites a worker query
 * to the user and also can save some tokens.
 *
 * @param supervisorName - The name of the supervisor node (used for namespacing the tool)
 * @returns The 'forward_message' tool
 */
function createForwardMessageTool(supervisorName = "supervisor") {
  const toolName = "forward_message";
  const description =
    "Forwards the latest message from the specified agent to the user " +
    "without any changes. Use this to preserve information fidelity, avoid " +
    "misinterpretation of questions or responses, and save time.";

  const forwardMessageTool = tool(
    async ({ from_agent }, config) => {
      // inject the current agent state
      const state =
        getCurrentTaskInput() as (typeof MessagesAnnotation)["State"];

      // Find the latest message from the specified agent that isn't a handoff back message
      // We need to search in reverse order to find the most recent message
      const targetMessage = state.messages
        .slice()
        .reverse()
        .find(
          (msg) =>
            isAIMessage(msg) &&
            msg.name?.toLowerCase() === from_agent.toLowerCase() &&
            !hasHandoffBackFlag(msg.response_metadata)
        );

      if (!targetMessage) {
        // If no message is found, return an error message
        const foundNames = new Set(
          state.messages
            .filter((msg): msg is AIMessage => isAIMessage(msg) && !!msg.name)
            .map((msg) => msg.name)
        );

        const toolMessage = new ToolMessage({
          content: `Could not find message from source agent ${from_agent}. Found names: ${[
            ...foundNames,
          ].join(", ")}`,
          name: toolName,
          tool_call_id: config.toolCall.id,
        });

        return toolMessage;
      }

      // Create a new message with the content from the target message
      const forwardedMessage = new AIMessage({
        content: targetMessage.content,
        name: supervisorName,
      });

      return new Command({
        graph: Command.PARENT,
        goto: "__end__", // This does nothing
        update: { ...state, messages: [forwardedMessage] },
      });
    },
    {
      name: toolName,
      schema: z.object({
        from_agent: z
          .string()
          .describe("The name of the agent whose message you want to forward"),
      }),
      description,
    }
  );

  return forwardMessageTool;
}

export {
  createHandoffTool,
  createHandoffBackMessages,
  createForwardMessageTool,
};
