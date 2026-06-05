import type { BaseMessage, BaseMessageChunk } from "@langchain/core/messages";
import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  coerceMessageLikeToMessage,
} from "@langchain/core/messages";
import type { Message } from "../types.messages.js";

type MessageLike = Omit<Message, "type"> & { type: string };

type ToolCallLike = {
  id?: string;
  name?: string;
  args?: unknown;
  input?: unknown;
};

type SerializedMessageWithContentBlocks = MessageLike & {
  content?: unknown;
  contentBlocks?: unknown;
  content_blocks?: unknown;
};

/**
 * Stream-local message coercion for serialized messages returned by
 * `getState()`, `getHistory()`, and `values` events.
 *
 * LangGraph API payloads may carry v1 content blocks as snake_case
 * `content_blocks`, while `@langchain/core` message constructors only
 * understand camelCase `contentBlocks` (or `content`). Normalize that
 * boundary here so stream consumers always see `BaseMessage.text`.
 */
export function tryCoerceMessageLikeToMessage(
  message: MessageLike
): BaseMessage | BaseMessageChunk {
  const normalized = normalizeAIMessageToolCalls(message);

  if (normalized.type === "human" || normalized.type === "user") {
    return new HumanMessage(normalized);
  }

  if (normalized.type === "ai" || normalized.type === "assistant") {
    return new AIMessage(normalized);
  }

  if (normalized.type === "system") {
    return new SystemMessage(normalized);
  }

  if (normalized.type === "tool" && "tool_call_id" in normalized) {
    return new ToolMessage({
      ...normalized,
      tool_call_id: normalized.tool_call_id as string,
    });
  }

  if (normalized.type === "remove" && normalized.id != null) {
    return new RemoveMessage({ ...normalized, id: normalized.id });
  }

  return coerceMessageLikeToMessage(normalized);
}

/**
 * Ensures all messages in an array are BaseMessage class instances.
 * Messages that are already class instances pass through unchanged.
 */
export function ensureMessageInstances(
  messages: (Message | BaseMessage)[]
): (BaseMessage | BaseMessageChunk)[] {
  return messages.map((msg) => {
    if (typeof (msg as BaseMessage).getType === "function") {
      return msg as BaseMessage;
    }
    return tryCoerceMessageLikeToMessage(
      msg as Omit<Message, "type"> & { type: string }
    );
  });
}

function normalizeSerializedContentBlocks<T extends MessageLike>(
  message: T
): T {
  const record = message as SerializedMessageWithContentBlocks;
  const contentBlocks = record.contentBlocks ?? record.content_blocks;
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    return message;
  }

  const shouldPreferContentBlocks =
    isEmptyContent(record.content) ||
    (!hasTextContent(record.content) && hasTextContent(contentBlocks));
  if (!shouldPreferContentBlocks && record.contentBlocks === contentBlocks) {
    return message;
  }

  return {
    ...message,
    content: shouldPreferContentBlocks ? contentBlocks : record.content,
    contentBlocks,
  } as T;
}

export function normalizeAIMessageToolCalls<T extends MessageLike>(
  message: T
): T {
  const normalized = normalizeSerializedContentBlocks(message);
  const record = normalized as T & {
    content?: unknown;
    tool_calls?: unknown;
  };
  if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
    return normalized;
  }

  const toolCalls = extractToolCallsFromContent(record.content);
  if (toolCalls.length === 0) return normalized;
  return {
    ...normalized,
    tool_calls: toolCalls,
  };
}

function extractToolCallsFromContent(content: unknown) {
  if (!Array.isArray(content)) return [];
  return content.flatMap(
    (
      block
    ): Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
      type: "tool_call";
    }> => {
      if (block == null || typeof block !== "object") return [];
      const record = block as ToolCallLike & { type?: unknown };
      if (record.type !== "tool_call" && record.type !== "tool_use") return [];
      return [
        {
          id: record.id ?? "",
          name: record.name ?? "",
          args: normalizeToolCallArgs(record.args ?? record.input),
          type: "tool_call",
        },
      ];
    }
  );
}

function normalizeToolCallArgs(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (
        parsed != null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Streaming input fragments are expected to be invalid until finalized.
    }
  }
  return {};
}

function isEmptyContent(content: unknown): boolean {
  return (
    content == null ||
    content === "" ||
    (Array.isArray(content) && content.length === 0)
  );
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block === "string") return block.length > 0;
    if (block == null || typeof block !== "object") return false;
    const record = block as { type?: unknown; text?: unknown };
    return (
      record.type === "text" &&
      typeof record.text === "string" &&
      record.text.length > 0
    );
  });
}
