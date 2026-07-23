/**
 * Pure helpers for the optimistic `submit()` path.
 *
 * Splitting the input-shaping logic out of {@link StreamController}
 * keeps it unit-testable in isolation: given a raw submit input it
 * produces (a) the payload to dispatch to the server — with stable ids
 * minted for any id-less message so the server echo reconciles by id —
 * and (b) the coerced `BaseMessage` instances to append to the root
 * projection immediately.
 *
 * No mutation of the caller's input is performed: message entries are
 * rebuilt as fresh dicts before ids are injected, and the top-level
 * object is shallow-cloned.
 */
import type { BaseMessage } from "@langchain/core/messages";
import type { Message } from "../types.messages.js";
import { toMessageDict } from "../ui/messages.js";
import { ensureMessageInstances } from "./message-coercion.js";

/**
 * Pre-submit snapshot of a single non-message `values` key, captured so
 * it can be rolled back if the run fails before the server echoes any
 * `values`.
 */
export interface OptimisticKeySnapshot {
  readonly key: string;
  /** Whether the key existed in `values` before the optimistic merge. */
  readonly hadKey: boolean;
  /** The pre-submit value (meaningful only when `hadKey` is true). */
  readonly prevValue: unknown;
}

/**
 * Opaque handle returned by the controller's optimistic apply step and
 * threaded back through the submit coordinator to the terminal
 * reconciliation step. Carries the echoed message ids (to transition
 * `pending` → `sent` / `failed`) and the non-message key snapshot (to
 * roll back on failure-before-echo).
 */
export interface OptimisticHandle {
  readonly echoedIds: string[];
  readonly restoreKeys: OptimisticKeySnapshot[];
}

/**
 * Result of preparing a raw submit input for optimistic dispatch.
 */
export interface PreparedOptimisticInput {
  /**
   * Input to actually send to the server. The messages key (when
   * present) is normalized to an array of message dicts, each carrying
   * a stable id; all other keys are copied verbatim.
   */
  readonly dispatchInput: Record<string, unknown>;
  /** Coerced message instances (with ids) to append to the projection. */
  readonly optimisticMessages: BaseMessage[];
  /** Ids of the messages echoed optimistically (minted or pre-existing). */
  readonly echoedIds: string[];
  /** Non-message input keys to shallow-merge into `values`. */
  readonly extraValues: Record<string, unknown>;
}

function isBaseMessageInstance(value: unknown): value is BaseMessage {
  return (
    value != null &&
    typeof (value as { getType?: unknown }).getType === "function"
  );
}

/**
 * Serialize `BaseMessage` instances under a state update's message key
 * into plain message dicts so they survive JSON transport.
 *
 * `respond({ update })` / `respondAll({}, { update })` fold `update` into
 * `Command(update=...)` on the wire. A `BaseMessage`'s default JSON form
 * is the `lc` "constructor" envelope (`{ lc, type: "constructor", id,
 * kwargs }`), which the server's `add_messages` reducer does **not**
 * coerce — whereas the flat `{ type, content, ... }` dict that
 * {@link toMessageDict} emits (and that `submit()` already sends) does.
 * Mirroring the `submit()` path lets
 * `respond({ update: { messages: [new AIMessage(...)] } })` behave like
 * `submit({ messages: [new AIMessage(...)] })`.
 *
 * Only the configured `messagesKey` is touched — in both the object form
 * and the `[key, value][]` tuple form. Every other key, and any already
 * plain (non-`BaseMessage`) entry, passes through untouched.
 */
export function serializeUpdateMessages(
  update: Record<string, unknown> | [string, unknown][],
  messagesKey: string
): Record<string, unknown> | [string, unknown][] {
  if (Array.isArray(update)) {
    return update.map((entry) =>
      Array.isArray(entry) && entry[0] === messagesKey
        ? [entry[0], serializeMessageValue(entry[1])]
        : entry
    ) as [string, unknown][];
  }
  if (!(messagesKey in update)) return update;
  return {
    ...update,
    [messagesKey]: serializeMessageValue(update[messagesKey]),
  };
}

function serializeMessageValue(value: unknown): unknown {
  if (isBaseMessageInstance(value)) return toMessageDict(value);
  if (Array.isArray(value)) {
    return value.map((item) =>
      isBaseMessageInstance(item) ? toMessageDict(item) : item
    );
  }
  return value;
}

function extractId(value: unknown): string | undefined {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Normalize a message-key value into an array of entries. Mirrors the
 * server's `add_messages` coercion: a bare string or single message
 * object is treated as a one-element list.
 */
function toEntryArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return [value];
}

/**
 * Build a message dict carrying `id` from an arbitrary input entry,
 * without mutating the original.
 */
function toDispatchDict(entry: unknown, id: string): Message {
  if (typeof entry === "string") {
    return { type: "human", content: entry, id } as unknown as Message;
  }
  if (isBaseMessageInstance(entry)) {
    return { ...toMessageDict(entry), id } as Message;
  }
  return { ...(entry as object), id } as Message;
}

/**
 * Prepare a raw submit input for optimistic dispatch.
 *
 * @param raw         - Raw input passed to `submit()`. Must be a
 *   non-null, non-array object (caller guards this).
 * @param messagesKey - State key holding the message array.
 * @param mintId      - Factory for stable client message ids.
 * @returns The dispatch payload, optimistic messages, echoed ids, and
 *   the non-message portion of the input.
 */
export function prepareOptimisticInput(
  raw: Record<string, unknown>,
  messagesKey: string,
  mintId: () => string
): PreparedOptimisticInput {
  const dispatchInput: Record<string, unknown> = { ...raw };
  const extraValues: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (key !== messagesKey) extraValues[key] = raw[key];
  }

  const echoedIds: string[] = [];
  const messagesValue = raw[messagesKey];
  if (messagesValue == null) {
    return { dispatchInput, optimisticMessages: [], echoedIds, extraValues };
  }

  const entries = toEntryArray(messagesValue);
  const dispatchEntries: unknown[] = [];
  const optimisticDicts: Message[] = [];
  for (const entry of entries) {
    const echoable =
      typeof entry === "string" ||
      isBaseMessageInstance(entry) ||
      (entry != null && typeof entry === "object" && !Array.isArray(entry));
    if (!echoable) {
      // Non-message-shaped entry (number/bool/null): forward as-is,
      // nothing to echo.
      dispatchEntries.push(entry);
      continue;
    }
    const id = extractId(entry) ?? mintId();
    const dict = toDispatchDict(entry, id);
    dispatchEntries.push(dict);
    optimisticDicts.push(dict);
    echoedIds.push(id);
  }

  dispatchInput[messagesKey] = dispatchEntries;
  const optimisticMessages = ensureMessageInstances(
    optimisticDicts
  ) as BaseMessage[];
  return { dispatchInput, optimisticMessages, echoedIds, extraValues };
}
