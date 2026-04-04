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
import type { ThreadState } from "../schema.js";

/**
 * Replaces the `messages` property in a state type with `BaseMessage[]`.
 * Used by framework SDKs to reflect that `ensureHistoryMessageInstances`
 * converts plain message objects to class instances at runtime.
 */
export type StateWithBaseMessages<S> = S extends { messages: unknown }
  ? Omit<S, "messages"> & { messages: BaseMessage[] }
  : S;

/**
 * Maps a `ThreadState<StateType>[]` so that the `messages` field inside
 * `values` is typed as `BaseMessage[]` instead of `Message[]`.
 */
export type HistoryWithBaseMessages<T> = T extends ThreadState<infer S>[]
  ? ThreadState<StateWithBaseMessages<S>>[]
  : T;

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

/**
 * Ensures all messages in an array are BaseMessage class instances.
 * Messages that are already class instances pass through unchanged.
 * Plain message objects (e.g. from API values/history) are converted
 * via {@link tryCoerceMessageLikeToMessage}.
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

/**
 * Converts plain message objects within each history state's values
 * to proper BaseMessage class instances. Returns a new array with
 * shallow-copied states whose messages have been coerced.
 */
export function ensureHistoryMessageInstances<
  StateType extends Record<string, unknown>,
>(
  history: ThreadState<StateType>[],
  messagesKey: string = "messages"
): ThreadState<StateType>[] {
  return history.map((state) => {
    if (state.values == null) return state;
    const messages = state.values[messagesKey];
    if (!Array.isArray(messages)) return state;
    return {
      ...state,
      values: {
        ...state.values,
        [messagesKey]: ensureMessageInstances(messages),
      },
    };
  });
}
