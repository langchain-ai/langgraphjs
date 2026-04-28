import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
} from "langchain";
import type { ToolCallWithResult } from "@langchain/react";

export type MessageFeedToolCall = {
  id?: string;
  name: string;
  args: unknown;
  type?: "tool_call";
};

export const getToolCallId = (message: BaseMessage) => {
  const direct = (message as { tool_call_id?: unknown }).tool_call_id;
  if (typeof direct === "string") return direct;
  const kwargs = (message as { lc_kwargs?: { tool_call_id?: unknown } })
    .lc_kwargs;
  return typeof kwargs?.tool_call_id === "string" ? kwargs.tool_call_id : undefined;
};

export const isToolMessage = (message: BaseMessage): message is ToolMessage =>
  ToolMessage.isInstance(message);

const isAiMessageWithToolCalls = (
  message: BaseMessage
): message is AIMessage & {
  tool_calls?: Array<{
    id?: string;
    name: string;
    args: unknown;
  }>;
  tool_call_chunks?: Array<{
    id?: string;
    name?: string;
    args?: string;
    index?: number;
  }>;
} =>
  (AIMessage.isInstance(message) || AIMessageChunk.isInstance(message)) &&
  "tool_calls" in message;

// Parse a (possibly partial) JSON string from streaming tool_call_chunks.
// During streaming Anthropic-style models emit `args` as an incomplete
// JSON fragment that accumulates across deltas; best-effort parsing keeps
// card previews live instead of empty until the final chunk arrives.
const tryParsePartialJson = (value: string | undefined): unknown => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const getToolCallsWithResults = (
  messages: BaseMessage[]
): ToolCallWithResult<MessageFeedToolCall>[] => {
  const toolResultsById = new Map<string, ToolMessage>();
  for (const message of messages) {
    const toolCallId = getToolCallId(message);
    if (isToolMessage(message) && toolCallId != null) {
      toolResultsById.set(toolCallId, message);
    }
  }

  const toolCalls: ToolCallWithResult<MessageFeedToolCall>[] = [];
  for (const message of messages) {
    if (!isAiMessageWithToolCalls(message)) {
      continue;
    }

    // `AIMessageChunk` auto-derives `tool_calls` from
    // `tool_call_chunks` with `args: {}` when the partial JSON can't
    // be parsed yet, which would make the UI look "empty" mid-stream.
    // While chunks are present we render from them (best-effort
    // parsing the partial JSON) so the tool card shows live args.
    // Once `content-block-finish` lands, chunks are gone and
    // `tool_calls` carries the finalized args.
    const hasChunks =
      Array.isArray(message.tool_call_chunks) &&
      message.tool_call_chunks.length > 0;

    const finalized =
      !hasChunks && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const chunkSource = hasChunks ? (message.tool_call_chunks ?? []) : [];

    for (const [index, call] of finalized.entries()) {
      if (call == null || typeof call.name !== "string") {
        continue;
      }

      const result =
        typeof call.id === "string" ? toolResultsById.get(call.id) : undefined;
      const status = result?.status === "error"
        ? "error"
        : result
          ? "completed"
          : "pending";

      toolCalls.push({
        id: call.id ?? `${message.id ?? "message"}:${call.name}:${toolCalls.length}`,
        state: status,
        call: {
          id: call.id,
          name: call.name,
          args: call.args,
        },
        aiMessage: message,
        index,
        result,
      });
    }

    for (const [chunkIndex, chunk] of chunkSource.entries()) {
      if (chunk == null || typeof chunk.name !== "string") continue;
      const index = chunk.index ?? chunkIndex;
      toolCalls.push({
        id:
          chunk.id ??
          `${message.id ?? "message"}:${chunk.name}:${index}`,
        state: "pending",
        call: {
          id: chunk.id,
          name: chunk.name,
          args: tryParsePartialJson(chunk.args),
        },
        aiMessage: message,
        index,
        result: undefined,
      });
    }
  }

  return toolCalls;
};
