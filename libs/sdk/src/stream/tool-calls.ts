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

/**
 * Build completed scoped tool-call handles from an authoritative
 * `values.messages` snapshot. Used when an idle thread hydrates card panels
 * from checkpoint history instead of replaying scoped `/events`.
 */
export function seedToolCallsFromMessages(
  namespace: readonly string[],
  messages: readonly BaseMessage[]
): AssembledToolCall[] {
  let toolCalls: AssembledToolCall[] = [];
  for (const message of messages) {
    const raw = (message as unknown as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(raw)) continue;
    for (const toolCall of raw) {
      if (toolCall == null || typeof toolCall !== "object") continue;
      const record = toolCall as {
        id?: unknown;
        name?: unknown;
        args?: unknown;
      };
      if (typeof record.id !== "string" || record.id.length === 0) continue;
      if (typeof record.name !== "string" || record.name.length === 0) {
        continue;
      }
      // Mirrors `shouldIgnoreScopedTaskToolEvent`: the wrapper `task` call
      // is represented by the subagent card itself, not as an inner tool.
      if (namespace.length > 0 && record.name === "task") continue;
      toolCalls = upsertToolCall(toolCalls, {
        id: record.id,
        callId: record.id,
        name: record.name,
        namespace: [...namespace, `tools:${record.id}`],
        input: record.args ?? {},
        args: record.args ?? {},
        output: null,
        status: "running",
        error: undefined,
      });
    }
  }
  return reconcileToolCallsFromMessages(toolCalls, messages);
}
