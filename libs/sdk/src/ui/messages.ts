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
 * How often streamed tool call args are re-parsed while `onRefresh` is set.
 */
const TOOL_CALL_REFRESH_MS = 50;

export class MessageTupleManager {
  chunks: Record<
    string,
    {
      chunk?: BaseMessageChunk | BaseMessage;
      metadata?: Record<string, unknown>;
      index?: number;
    }
  > = {};

  /**
   * When set, streamed tool call args are re-parsed at most every
   * {@link TOOL_CALL_REFRESH_MS} rather than on every chunk, and this is called
   * with the IDs of the messages whose tool calls were re-parsed.
   */
  onRefresh?: (ids: string[]) => void;

  private staleIds = new Set<string>();

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  private replaying = new Set<string>();

  constructor() {
    this.chunks = {};
  }

  /**
   * Call when a stream replays a run from its first event: a message it sends
   * again starts over, instead of its chunks being appended to the copy kept
   * from an earlier stream.
   */
  startReplay() {
    this.replaying = new Set(Object.keys(this.chunks));
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

    this.chunks[id] ??= {};
    if (this.replaying.delete(id)) delete this.chunks[id].chunk;
    this.chunks[id].metadata = metadata ?? this.chunks[id].metadata;
    if (chunk) {
      const prev = this.chunks[id].chunk;
      const next =
        (BaseMessageChunk.isInstance(prev) ? prev : null)?.concat(chunk) ??
        chunk;

      // Parsing the accumulated tool call args on every chunk is quadratic in
      // their length, so carry the previous parse forward and re-parse on a
      // timer instead.
      if (
        this.onRefresh != null &&
        AIMessageChunk.isInstance(prev) &&
        AIMessageChunk.isInstance(next) &&
        next.tool_call_chunks?.length
      ) {
        next.tool_calls = prev.tool_calls;
        next.invalid_tool_calls = prev.invalid_tool_calls;
        this.staleIds.add(id);
        this.refreshTimer ??= setTimeout(
          () => this.flush(),
          TOOL_CALL_REFRESH_MS
        );
      }

      this.chunks[id].chunk = next;
    } else {
      this.chunks[id].chunk = message;
    }

    return id;
  }

  /**
   * Re-parse any tool calls left stale by `add` and notify `onRefresh`.
   */
  flush() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (this.staleIds.size === 0) return;

    const ids = [...this.staleIds];
    this.staleIds.clear();
    for (const id of ids) {
      const chunk = this.chunks[id]?.chunk;
      if (AIMessageChunk.isInstance(chunk)) {
        // `concat` returns a new chunk whose tool calls are re-derived from
        // `tool_call_chunks`.
        this.chunks[id].chunk = chunk.concat(
          new AIMessageChunk({ content: "" })
        );
      }
    }
    this.onRefresh?.(ids);
  }

  clear() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.staleIds.clear();
    this.chunks = {};
    this.replaying.clear();
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
