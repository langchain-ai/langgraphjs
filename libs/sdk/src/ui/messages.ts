import {
  type BaseMessage,
  BaseMessageChunk,
  convertToChunk,
  HumanMessageChunk,
  SystemMessageChunk,
  AIMessageChunk,
  ToolMessageChunk,
} from "@langchain/core/messages";

import type { Message } from "../types.messages.js";
import type { ThreadState } from "../schema.js";
import { DEFAULT_MESSAGES_KEY } from "../stream/constants.js";
import {
  normalizeAIMessageToolCalls,
  tryCoerceMessageLikeToMessage,
} from "../stream/message-coercion.js";

export { tryCoerceMessageLikeToMessage };

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
    if (BaseMessageChunk.isInstance(message)) return message;
    return convertToChunk(message);
  } catch {
    return null;
  }
}

function tryCoerceMessageLikeToChunk(
  message: Omit<Message, "type"> & { type: string }
): BaseMessage | BaseMessageChunk {
  if (message.type === "human" || message.type === "user") {
    return new HumanMessageChunk(message);
  }

  if (message.type === "ai" || message.type === "assistant") {
    return new AIMessageChunk(normalizeAIMessageToolCalls(message));
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

  return tryCoerceMessageLikeToMessage(message);
}

/**
 * Concatenates chunks pairwise. Before @langchain/core 1.2.18,
 * `AIMessageChunk.concat` re-parses the arguments of every tool call
 * received so far, so concatenating deltas one by one onto a long tool call
 * is quadratic. Merging the deltas with each other first keeps the parse of
 * the whole tool call to once per merge.
 */
function concatChunks(chunks: BaseMessageChunk[]): BaseMessageChunk {
  let level = chunks;
  while (level.length > 1) {
    const next: BaseMessageChunk[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(
        i + 1 < level.length ? level[i].concat(level[i + 1]) : level[i]
      );
    }
    level = next;
  }
  return level[0];
}

type MessageTupleEntry = {
  chunk?: BaseMessageChunk | BaseMessage;
  metadata?: Record<string, unknown>;
  index?: number;
};

export class MessageTupleManager {
  private entries: Record<string, MessageTupleEntry> = {};

  /** Chunks added since the entry was last read, by message ID. */
  private pending: Record<string, BaseMessageChunk[]> = {};

  constructor() {
    this.chunks = {};
  }

  get chunks(): Record<string, MessageTupleEntry> {
    for (const id of Object.keys(this.pending)) this.merge(id);
    return this.entries;
  }

  set chunks(chunks: Record<string, MessageTupleEntry>) {
    this.entries = chunks;
    this.pending = {};
  }

  private merge(id: string) {
    const pending = this.pending[id];
    if (pending == null) return;
    delete this.pending[id];

    const entry = this.entries[id];
    const merged = concatChunks(pending);
    entry.chunk =
      (BaseMessageChunk.isInstance(entry.chunk) ? entry.chunk : null)?.concat(
        merged
      ) ?? merged;
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

    const message = tryCoerceMessageLikeToChunk(serialized);
    const chunk = tryConvertToChunk(message);

    const { id } = chunk ?? message;
    if (!id) {
      console.warn(
        "No message ID found for chunk, ignoring in state",
        serialized
      );
      return null;
    }

    this.entries[id] ??= {};
    this.entries[id].metadata = metadata ?? this.entries[id].metadata;
    if (chunk) {
      // Concatenated when the entry is read, so a burst of chunks between
      // reads is merged once.
      (this.pending[id] ??= []).push(chunk);
    } else {
      delete this.pending[id];
      this.entries[id].chunk = message;
    }

    return id;
  }

  clear() {
    this.chunks = {};
  }

  get(id: string | null | undefined, defaultIndex?: number) {
    if (id == null) return null;
    if (this.entries[id] == null) return null;
    this.merge(id);
    if (defaultIndex != null) this.entries[id].index ??= defaultIndex;
    return this.entries[id];
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
  messagesKey: string = DEFAULT_MESSAGES_KEY
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
