import type { AssembledToolCall } from "../client/stream/handles/tools.js";

/**
 * Insert or replace an assembled tool call by call id.
 */
export function upsertToolCall(
  current: readonly AssembledToolCall[],
  next: AssembledToolCall
): AssembledToolCall[] {
  const idx = current.findIndex((toolCall) => toolCall.callId === next.callId);
  if (idx < 0) return [...current, next];
  const updated = current.slice();
  updated[idx] = next;
  return updated;
}
