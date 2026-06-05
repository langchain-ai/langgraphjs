import type { BaseMessage } from "@langchain/core/messages";

export interface ReconcileMessagesFromValuesOptions {
  /**
   * Messages from the authoritative `values.messages` snapshot.
   */
  readonly valueMessages: readonly BaseMessage[];
  /**
   * Current message projection, including stream-assembled in-flight messages.
   */
  readonly currentMessages: readonly BaseMessage[];
  /**
   * Index from message id to current message position.
   */
  readonly currentIndexById: ReadonlyMap<string, number>;
  /**
   * Ids observed in the most recent previous `values.messages` snapshot.
   * If one of these ids is missing from the next snapshot, it is treated as
   * an explicit server-side removal.
   */
  readonly previousValueMessageIds: ReadonlySet<string>;
  /**
   * Optional stream-id filter. When supplied, only these current ids are
   * eligible to override the values snapshot. When omitted, any id present in
   * `currentIndexById` is eligible, preserving the root controller's historic
   * behavior.
   */
  readonly streamedMessageIds?: ReadonlySet<string>;
  /**
   * Allows callers to keep a values message even when a streamed message with
   * the same id exists. Used by the root controller when the values message
   * carries finalized tool-call data missing from the streamed message.
   */
  readonly preferValuesMessage?: (
    valuesMessage: BaseMessage,
    streamedMessage: BaseMessage
  ) => boolean;
  /**
   * When true, treat the snapshot as a non-authoritative (older / replayed)
   * view: never drop a current message just because it is absent from this
   * snapshot. Used on reconnect, where the content pump replays older
   * checkpoints after the authoritative `getState()` seed — an older
   * snapshot legitimately lacks later messages and must not remove them.
   */
  readonly addOnly?: boolean;
}

export interface ReconciledMessages {
  readonly messages: readonly BaseMessage[];
  readonly valueMessageIds: Set<string>;
}

/**
 * Merge an authoritative `values.messages` snapshot with the current streamed
 * message projection.
 *
 * Values remain authoritative for ordering and removals. Streamed messages
 * remain authoritative for in-flight content until the server echoes them in a
 * values snapshot, and stream-only messages are preserved until they either
 * appear in values or are known to have been removed.
 */
export function reconcileMessagesFromValues({
  valueMessages,
  currentMessages,
  currentIndexById,
  previousValueMessageIds,
  streamedMessageIds,
  preferValuesMessage,
  addOnly,
}: ReconcileMessagesFromValuesOptions): ReconciledMessages {
  const valueMessageIds = new Set<string>();
  const merged: BaseMessage[] = [];

  for (const valuesMessage of valueMessages) {
    const id = normalizedMessageId(valuesMessage);
    if (id == null) {
      merged.push(valuesMessage);
      continue;
    }

    valueMessageIds.add(id);
    const streamIdx = currentIndexById.get(id);
    const canUseStreamed =
      streamIdx != null &&
      (streamedMessageIds == null || streamedMessageIds.has(id));
    const streamedMessage = canUseStreamed
      ? currentMessages[streamIdx]
      : undefined;

    if (
      streamedMessage != null &&
      preferValuesMessage?.(valuesMessage, streamedMessage) !== true
    ) {
      merged.push(streamedMessage);
    } else {
      merged.push(valuesMessage);
    }
  }

  for (const existing of currentMessages) {
    const id = normalizedMessageId(existing);
    if (id == null) continue;
    if (valueMessageIds.has(id)) continue;
    // A previously-seen id missing from this snapshot is a server-side
    // removal — UNLESS this is an older/replayed snapshot (`addOnly`),
    // where the absence only means "this earlier checkpoint predates the
    // message", not "the message was removed".
    if (!addOnly && previousValueMessageIds.has(id)) continue;
    if (streamedMessageIds != null && !streamedMessageIds.has(id)) continue;
    merged.push(existing);
  }

  return {
    messages: messagesEqualList(currentMessages, merged)
      ? currentMessages
      : merged,
    valueMessageIds,
  };
}

/**
 * Build a position index for keyed messages.
 */
export function buildMessageIndex(
  messages: readonly BaseMessage[]
): Map<string, number> {
  const index = new Map<string, number>();
  messages.forEach((message, idx) => {
    const id = normalizedMessageId(message);
    if (id != null) index.set(id, idx);
  });
  return index;
}

/**
 * Decide whether a values message carries tool-call data missing from the
 * streamed message.
 */
export function shouldPreferValuesMessageForToolCalls(
  valuesMessage: BaseMessage,
  streamedMessage: BaseMessage
): boolean {
  const valuesToolCalls = getMessageToolCalls(valuesMessage);
  if (valuesToolCalls.length === 0) return false;

  const streamedToolCalls = getMessageToolCalls(streamedMessage);
  if (streamedToolCalls.length < valuesToolCalls.length) return true;

  const streamedIds = new Set(
    streamedToolCalls
      .map((toolCall) => toolCall.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );
  if (
    valuesToolCalls.some((toolCall) => {
      return typeof toolCall.id === "string" && !streamedIds.has(toolCall.id);
    })
  ) {
    return true;
  }

  // Values snapshots carry the finalized tool-call args. Prefer them only when
  // they add meaningful data, so empty placeholder args do not replace an
  // otherwise useful streamed message.
  return valuesToolCalls.some((valuesToolCall) => {
    const streamedToolCall = streamedToolCalls.find(
      (candidate) =>
        typeof valuesToolCall.id === "string" &&
        candidate.id === valuesToolCall.id
    );
    return (
      streamedToolCall != null &&
      hasMeaningfulArgs(valuesToolCall.args) &&
      !jsonishEqual(valuesToolCall.args, streamedToolCall.args)
    );
  });
}

function hasMeaningfulArgs(args: unknown): boolean {
  if (args == null) return false;
  if (typeof args === "string") return args.length > 0;
  if (typeof args === "object") return Object.keys(args).length > 0;
  return true;
}

export function messagesEqualList(
  previous: readonly BaseMessage[],
  next: readonly BaseMessage[]
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let i = 0; i < previous.length; i += 1) {
    if (!messagesEqual(previous[i], next[i])) return false;
  }
  return true;
}

export function messagesEqual(
  previous: BaseMessage | undefined,
  next: BaseMessage | undefined
): boolean {
  if (previous === next) return true;
  if (previous == null || next == null) return false;
  const previousRecord = previous as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  const previousType =
    typeof previous.getType === "function"
      ? previous.getType()
      : previousRecord.type;
  const nextType =
    typeof next.getType === "function" ? next.getType() : nextRecord.type;

  return (
    previous.id === next.id &&
    previousType === nextType &&
    jsonishEqual(previous.content, next.content) &&
    previousRecord.tool_call_id === nextRecord.tool_call_id &&
    previousRecord.status === nextRecord.status &&
    jsonishEqual(
      previousRecord.additional_kwargs,
      nextRecord.additional_kwargs
    ) &&
    jsonishEqual(
      previousRecord.response_metadata,
      nextRecord.response_metadata
    ) &&
    jsonishEqual(previousRecord.tool_calls, nextRecord.tool_calls) &&
    jsonishEqual(
      previousRecord.tool_call_chunks,
      nextRecord.tool_call_chunks
    ) &&
    jsonishEqual(previousRecord.usage_metadata, nextRecord.usage_metadata)
  );
}

function normalizedMessageId(message: BaseMessage): string | undefined {
  return typeof message.id === "string" && message.id.length > 0
    ? message.id
    : undefined;
}

function getMessageToolCalls(
  message: BaseMessage
): Array<{ id?: string; name?: string; args?: unknown }> {
  const raw = (message as unknown as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (toolCall): toolCall is { id?: string; name?: string; args?: unknown } =>
      toolCall != null && typeof toolCall === "object"
  );
}

function jsonishEqual(previous: unknown, next: unknown): boolean {
  return jsonishEqualAtDepth(previous, next, 0);
}

function jsonishEqualAtDepth(
  previous: unknown,
  next: unknown,
  depth: number
): boolean {
  if (Object.is(previous, next)) return true;
  if (previous == null || next == null) return false;
  if (typeof previous !== "object" || typeof next !== "object") return false;
  if (depth >= 4) return false;

  if (Array.isArray(previous) || Array.isArray(next)) {
    if (!Array.isArray(previous) || !Array.isArray(next)) return false;
    if (previous.length !== next.length) return false;
    for (let i = 0; i < previous.length; i += 1) {
      if (!jsonishEqualAtDepth(previous[i], next[i], depth + 1)) return false;
    }
    return true;
  }

  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const previousKeys = Object.keys(previousRecord).filter(
    (key) => typeof previousRecord[key] !== "function"
  );
  const nextKeys = Object.keys(nextRecord).filter(
    (key) => typeof nextRecord[key] !== "function"
  );
  if (previousKeys.length !== nextKeys.length) return false;

  for (const key of previousKeys) {
    if (!Object.prototype.hasOwnProperty.call(nextRecord, key)) return false;
    if (!jsonishEqualAtDepth(previousRecord[key], nextRecord[key], depth + 1)) {
      return false;
    }
  }
  return true;
}
