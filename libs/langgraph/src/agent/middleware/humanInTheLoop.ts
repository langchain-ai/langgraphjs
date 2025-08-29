import { AIMessage, isAIMessage, ToolMessage } from "@langchain/core/messages";
import { AgentMiddleware, AgentState } from "../agent";
import { interrupt } from "../../interrupt";
import {
  HumanInterruptConfig,
  ActionRequest,
  HumanInterrupt,
  HumanResponse,
} from "../../prebuilt/interrupt";

export type ToolInterruptConfig = Record<string, HumanInterruptConfig>;

export class HumanInTheLoopMiddleware implements AgentMiddleware {
  name = "humanInTheLoop";

  constructor(
    private toolConfigs: ToolInterruptConfig,
    private messagePrefix: string = "Tool execution requires approval"
  ) {}

  afterModel = async (
    state: AgentState["State"]
  ): Promise<AgentState["Update"]> => {
    const messages = state.messages;
    if (!messages || messages.length === 0) {
      return {};
    }

    const lastMessage = messages[messages.length - 1];

    if (!isAIMessage(lastMessage) || !lastMessage.tool_calls?.length) {
      return {};
    }

    // Separate tool calls that need interrupts from those that don't
    const interruptToolCalls: typeof lastMessage.tool_calls = [];
    const autoApprovedToolCalls: typeof lastMessage.tool_calls = [];

    for (const toolCall of lastMessage.tool_calls) {
      const toolName = toolCall.name;
      if (toolName in this.toolConfigs) {
        interruptToolCalls.push(toolCall);
      } else {
        autoApprovedToolCalls.push(toolCall);
      }
    }

    // If no interrupts needed, return early
    if (interruptToolCalls.length === 0) {
      return {};
    }

    const approvedToolCalls = [...autoApprovedToolCalls];

    // Process all tool calls that need interrupts in parallel
    const requests: HumanInterrupt[] = [];

    for (const toolCall of interruptToolCalls) {
      const toolName = toolCall.name;
      const toolArgs = toolCall.args;
      const description = `${
        this.messagePrefix
      }\n\nTool: ${toolName}\nArgs: ${JSON.stringify(toolArgs)}`;
      const toolConfig = this.toolConfigs[toolName];

      const request: HumanInterrupt = {
        action_request: {
          action: toolName,
          args: toolArgs,
        },
        config: toolConfig,
        description,
      };
      requests.push(request);
    }

    const responses: HumanResponse[] = interrupt(requests);

    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      const toolCall = interruptToolCalls[i];

      if (response.type === "accept") {
        approvedToolCalls.push(toolCall);
      } else if (response.type === "edit") {
        const edited = response.args as ActionRequest;
        const newToolCall = {
          name: toolCall.name,
          args: edited.args,
          id: toolCall.id,
        };
        approvedToolCalls.push(newToolCall);
      } else if (response.type === "ignore") {
        // NOTE: does not work with multiple interrupts
        return { jumpTo: "__end__" };
      } else if (response.type === "response") {
        // NOTE: does not work with multiple interrupts
        const toolMessage = new ToolMessage({
          tool_call_id: toolCall.id!,
          content: response.args as string,
        });
        return {
          messages: [toolMessage],
          jumpTo: "model",
        };
      } else {
        throw new Error(`Unknown response type: ${(response as any).type}`);
      }
    }

    // Create a new AI message with the approved tool calls
    const updatedMessage = new AIMessage({
      content: lastMessage.content,
      tool_calls: approvedToolCalls,
      id: lastMessage.id,
    });

    return { messages: [updatedMessage] };
  };
}
