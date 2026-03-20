import type { BaseMessage } from "@langchain/core/messages";
import type { DefaultToolCall } from "@langchain/langgraph-sdk";
import type { SubagentStreamInterface } from "@langchain/langgraph-sdk/ui";

/**
 * Subagent stream view with {@link BaseMessage} arrays (Angular SDK uses class
 * messages end-to-end).
 */
export type ClassSubagentStreamInterface<
  StateType = Record<string, unknown>,
  ToolCall = DefaultToolCall,
  SubagentName extends string = string,
> = Omit<
  SubagentStreamInterface<StateType, ToolCall, SubagentName>,
  "messages"
> & {
  messages: BaseMessage[];
};
