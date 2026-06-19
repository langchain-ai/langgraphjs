import type {
  Message,
  AIMessage,
  ToolMessage,
  ToolCallState,
  ToolCallWithResult,
  DefaultToolCall,
} from "../types.messages.js";

/**
 * Extracts tool calls with their results from a list of messages.
 *
 * @template ToolCall The type of tool calls.
 * @param messages The list of messages to extract tool calls from.
 * @returns An array of ToolCallWithResult objects.
 *
 * @example
 * ```ts
 * const toolCalls = getToolCallsWithResults(messages);
 * for (const { call, result } of toolCalls) {
 *   if (call.name === "get_weather") {
 *     console.log(`Weather for ${call.args.location}:`, result?.content);
 *   }
 * }
 * ```
 */
/**
 * Computes the lifecycle state of a tool call based on its result.
 */
function computeToolCallState(
  result: ToolMessage | undefined,
  impliedCompleted: boolean
): ToolCallState {
  if (result) return result.status === "error" ? "error" : "completed";
  if (impliedCompleted) return "completed";
  return "pending";
}

export function getToolCallsWithResults<ToolCall = DefaultToolCall>(
  messages: Message<ToolCall>[]
): ToolCallWithResult<ToolCall>[] {
  const results: ToolCallWithResult<ToolCall>[] = [];

  // Create a map of tool_call_id to ToolMessage for quick lookup
  const toolResultsById = new Map<string, ToolMessage>();
  for (const msg of messages) {
    if (msg.type === "tool") {
      toolResultsById.set(msg.tool_call_id, msg);
    }
  }

  // Find all AI messages with tool calls and pair them with results.
  // For each, independently check if there's a subsequent AI message,
  // which implies the tools completed (handles tools returning Commands
  // where ToolMessages are embedded in the state update rather than streamed).
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx += 1) {
    const msg = messages[msgIdx];
    if (msg.type === "ai" && msg.tool_calls && msg.tool_calls.length > 0) {
      const aiMessage = msg as AIMessage<ToolCall>;

      let impliedCompleted = false;
      for (let j = msgIdx + 1; j < messages.length; j += 1) {
        if (messages[j].type === "ai") {
          impliedCompleted = true;
          break;
        }
      }

      for (let i = 0; i < aiMessage.tool_calls!.length; i += 1) {
        const call = aiMessage.tool_calls![i] as ToolCall & { id?: string };
        const callId = call.id as string | undefined;
        const result = callId ? toolResultsById.get(callId) : undefined;

        results.push({
          id: callId ?? `${aiMessage.id ?? "unknown"}-${i}`,
          call,
          result,
          aiMessage,
          index: i,
          state: computeToolCallState(result, impliedCompleted),
        });
      }
    }
  }

  return results;
}
