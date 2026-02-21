import {
  type BaseMessage,
  BaseMessageChunk,
  RemoveMessage,
  convertToChunk,
  coerceMessageLikeToMessage,
  isBaseMessageChunk,
  HumanMessageChunk,
  SystemMessageChunk,
  AIMessageChunk,
  ToolMessageChunk,
} from "@langchain/core/messages";

import type { Message } from "../types.messages.js";

export function tryConvertToChunk(
  message: BaseMessage | BaseMessageChunk
): BaseMessageChunk | null {
  try {
    if (isBaseMessageChunk(message)) return message;
    return convertToChunk(message);
  } catch {
    return null;
  }
}

export function tryCoerceMessageLikeToMessage(
  message: Omit<Message, "type"> & { type: string }
): BaseMessage | BaseMessageChunk {
  if (message.type === "human" || message.type === "user") {
    return new HumanMessageChunk(message);
  }

  if (message.type === "ai" || message.type === "assistant") {
    return new AIMessageChunk(message);
  }

  if (message.type === "system") {
    return new SystemMessageChunk(message);
  }

  if (message.type === "tool" && "tool_call_id" in message) {
    return new ToolMessageChunk({
      ...message,
      tool_call_id: message.tool_call_id as string,
    });
  }

  if (message.type === "remove" && message.id != null) {
    return new RemoveMessage({ ...message, id: message.id });
  }

  return coerceMessageLikeToMessage(message);
}

export class MessageTupleManager {
  chunks: Record<
    string,
    {
      chunk?: BaseMessageChunk | BaseMessage;
      metadata?: Record<string, unknown>;
      index?: number;
    }
  > = {};

  constructor() {
    this.chunks = {};
  }

  add(
    serialized: Message,
    metadata: Record<string, unknown> | undefined
  ): string | null {
    // TODO: this is sometimes sent from the API
    // figure out how to prevent this or move this to LC.js
    if (serialized.type.endsWith("MessageChunk")) {
      // eslint-disable-next-line no-param-reassign
      serialized.type = serialized.type
        .slice(0, -"MessageChunk".length)
        .toLowerCase() as Message["type"];
    }

    const message = tryCoerceMessageLikeToMessage(serialized);
    const chunk = tryConvertToChunk(message);

    const { id } = chunk ?? message;
    if (!id) {
      console.warn(
        "No message ID found for chunk, ignoring in state",
        serialized
      );
      return null;
    }

    this.chunks[id] ??= {};
    this.chunks[id].metadata = metadata ?? this.chunks[id].metadata;
    if (chunk) {
      const prev = this.chunks[id].chunk;
      this.chunks[id].chunk =
        (isBaseMessageChunk(prev) ? prev : null)?.concat(chunk) ?? chunk;
    } else {
      this.chunks[id].chunk = message;
    }

    return id;
  }

  clear() {
    this.chunks = {};
  }

  get(id: string | null | undefined, defaultIndex?: number) {
    if (id == null) return null;
    if (this.chunks[id] == null) return null;
    if (defaultIndex != null) this.chunks[id].index ??= defaultIndex;
    return this.chunks[id];
  }
}

export const toMessageDict = (chunk: BaseMessage): Message => {
  const { type, data } = chunk.toDict();
  return { ...data, type } as Message;
};

/**
 * Identity converter that keeps @langchain/core class instances.
 * Used by framework SDKs to expose BaseMessage instances instead of plain dicts.
 */
export const toMessageClass = (chunk: BaseMessage): BaseMessage => chunk;
