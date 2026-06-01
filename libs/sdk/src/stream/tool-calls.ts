import type { BaseMessage } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages";
import type { AssembledToolCall } from "../client/stream/handles/tools.js";
import { parseToolOutput } from "../client/stream/handles/tools.js";

/**
 * Insert or replace an assembled tool call by call id.
 *
 * ToolCallAssembler mutates its active handle in place as `tool-finished` /
 * `tool-error` events arrive. Publish a fresh object here so framework
 * adapters that pass individual tool calls as props (notably Vue's shallow
 * prop tracking) observe status/output changes.
 */
export function upsertToolCall(
  current: readonly AssembledToolCall[],
  next: AssembledToolCall
): AssembledToolCall[] {
  const snapshot = { ...next };
  const idx = current.findIndex((toolCall) => toolCall.callId === next.callId);
  if (idx < 0) return [...current, snapshot];
  const updated = current.slice();
  updated[idx] = snapshot;
  return updated;
}

/**
 * Backfill unfinished tool-call handles from authoritative ToolMessages in a
 * values snapshot. This covers headless tools whose graph state contains the
 * result even when the `tools` channel omits a matching `tool-finished` event.
 */
export function reconcileToolCallsFromMessages(
  toolCalls: readonly AssembledToolCall[],
  messages: readonly BaseMessage[]
): AssembledToolCall[] {
  let updated: AssembledToolCall[] | undefined;
  for (const message of messages) {
    if (!ToolMessage.isInstance(message)) continue;
    const callId = message.tool_call_id;
    if (typeof callId !== "string" || callId.length === 0) continue;

    const currentToolCalls = updated ?? toolCalls;
    const idx = currentToolCalls.findIndex(
      (toolCall) => toolCall.callId === callId
    );
    if (idx < 0) continue;

    const current = currentToolCalls[idx];
    if (current.status === "finished" && current.output != null) continue;

    const output = parseToolOutput(message.content);
    if (output == null) continue;

    updated = upsertToolCall(currentToolCalls, {
      ...current,
      output,
      status: "finished",
      error: undefined,
    });
  }
  return updated ?? (toolCalls as AssembledToolCall[]);
}
