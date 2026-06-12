import { v4 as uuidv4 } from "@langchain/core/utils/uuid";
import { z } from "zod";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  Command,
  MessagesAnnotation,
  getCurrentTaskInput,
} from "@langchain/langgraph";

const WHITESPACE_RE = /\s+/g;

function _normalizeAgentName(agentName: string): string {
  /**
   * Normalize an agent name to be used inside the tool name.
   */
  return agentName.trim().replace(WHITESPACE_RE, "_").toLowerCase();
}

const createHandoffTool = ({
  agentName,
  description,
  agentDescription,
  addHandoffMessages = true,
}: {
  agentName: string;
  description?: string;
  /**
   * @deprecated Use `description` instead.
   */
  agentDescription?: string;
  addHandoffMessages?: boolean;
}) => {
  /**
   * Create a tool that can handoff control to the requested agent.
   *
   * @param agentName - The name of the agent to handoff control to, i.e.
   *   the name of the agent node in the multi-agent graph.
   *   Agent names should be simple, clear and unique, preferably in snake_case,
   *   although you are only limited to the names accepted by LangGraph
   *   nodes as well as the tool names accepted by LLM providers
   *   (the tool name will look like this: `transfer_to_<agent_name>`).
   * @param description - Optional description for the handoff tool.
   * @param agentDescription - Deprecated. Use `description` instead.
   * @param addHandoffMessages - Whether to add the handoff messages to the
   *   message history forwarded to the expert agent. If `false`, the
   *   supervisor `AIMessage` containing the handoff tool call and the handoff
   *   `ToolMessage` are omitted from the expert agent's message history.
   *   Defaults to `true`.
   */
  const toolName = `transfer_to_${_normalizeAgentName(agentName)}`;

  const handoffTool = tool(
    async (_, config) => {
      /**
       * Ask another agent for help.
       */
      // inject the current agent state
      const state =
        getCurrentTaskInput() as (typeof MessagesAnnotation)["State"];

      let messages = state.messages;
      if (addHandoffMessages) {
        const toolMessage = new ToolMessage({
          content: `Successfully transferred to ${agentName}`,
          name: toolName,
          tool_call_id: config.toolCall.id,
        });
        messages = messages.concat(toolMessage);
      } else {
        // omit the supervisor AIMessage containing the handoff tool call
        // (and the handoff ToolMessage) from the expert agent's history
        messages = messages.slice(0, -1);
      }

      return new Command({
        goto: agentName,
        graph: Command.PARENT,
        update: { messages },
      });
    },
    {
      name: toolName,
      schema: z.object({}),
      description:
        description ?? agentDescription ?? "Ask another agent for help.",
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
   *
   * @deprecated This helper is intended for supervisor internals. Prefer configuring handoff behavior through `createSupervisor`.
   */
  const toolCallId = uuidv4();
  const toolName = `transfer_back_to_${_normalizeAgentName(supervisorName)}`;
  const toolCalls = [{ name: toolName, args: {}, id: toolCallId }];

  return [
    new AIMessage({
      content: `Transferring back to ${supervisorName}`,
      tool_calls: toolCalls,
      name: agentName,
    }),
    new ToolMessage({
      content: `Successfully transferred back to ${supervisorName}`,
      name: toolName,
      tool_call_id: toolCallId,
    }),
  ];
}

export { createHandoffTool, createHandoffBackMessages };
