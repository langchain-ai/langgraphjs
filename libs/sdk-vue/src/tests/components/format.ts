import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

/**
 * Render helper used across v1 stream test components. Mirrors the
 * React counterpart so fixtures read consistently between the two
 * suites.
 */
export function formatMessage(message: BaseMessage): string {
  if (
    AIMessage.isInstance(message) &&
    "tool_calls" in message &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  ) {
    return message.tool_calls
      .map(
        (toolCall) =>
          `tool_call:${toolCall.name}:${JSON.stringify(toolCall.args)}`,
      )
      .join(",");
  }

  if (ToolMessage.isInstance(message)) {
    return `tool_result:${formatUnknown(message.content)}`;
  }

  return formatUnknown(message.content);
}

export function formatUnknown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
