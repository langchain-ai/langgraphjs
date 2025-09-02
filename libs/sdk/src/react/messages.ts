import {
  type BaseMessage,
  type BaseMessageChunk,
  convertToChunk,
  coerceMessageLikeToMessage,
  isBaseMessageChunk,
} from "@langchain/core/messages";

import type { Message } from "../types.messages.js";

function tryConvertToChunk(message: BaseMessage): BaseMessageChunk | null {
  try {
    return convertToChunk(message);
  } catch {
    return null;
  }
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

    const message = coerceMessageLikeToMessage(serialized);
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
