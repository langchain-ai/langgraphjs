/**
 * Root-namespace message projection.
 *
 * # What this module is
 *
 * The {@link RootMessageProjection} is the piece of the
 * {@link StreamController} that owns "what messages does the root
 * namespace currently contain?". It assembles streamed message deltas
 * via {@link MessageAssembler}, reconciles them against authoritative
 * `values.messages` snapshots from the server, and writes the merged
 * list back into the controller's root snapshot store.
 *
 * # Two streams of truth
 *
 * Root messages arrive on two channels and need to merge cleanly:
 *
 *   - **`messages` channel.** Token-level deltas that build messages
 *     incrementally. The {@link MessageAssembler} keeps partial
 *     messages by id and emits an updated `BaseMessage` per delta.
 *   - **`values` channel.** Periodic full-state snapshots that include
 *     the authoritative messages array. Used for ordering, removals,
 *     and forks (where the streamed messages may pre-date the new
 *     timeline).
 *
 * The reconciliation rules (delegated to
 * {@link reconcileMessagesFromValues}) preserve in-flight streamed
 * content while letting values dictate ordering and removals.
 *
 * # Tool-message namespace correlation
 *
 * Tool messages arrive on `messages-start` events with `role: "tool"`
 * but the start event doesn't always include a `tool_call_id`. We
 * recover it via three fallbacks:
 *
 *   1. The start event itself, when the server includes it.
 *   2. The legacy `<id>-tool-<call_id>` message id format.
 *   3. The most recent `tool-started` event recorded under the same
 *      namespace via {@link recordToolCallNamespace}.
 *
 * Without this correlation, tool messages render with empty
 * `tool_call_id` and downstream UIs can't pair them with the
 * originating tool call.
 *
 * # Store-write batching
 *
 * Every {@link handleMessage} / {@link applyValues} call updates the
 * in-projection bookkeeping (assembler state, id index, role cache)
 * synchronously, then stages the new `messages` / `values` into a
 * pending buffer and schedules a `setTimeout(0)` flush. A single
 * coalesced `store.setState` runs at the next macrotask boundary.
 *
 * The motivation is the long-replay freeze: a thread with hundreds
 * of messages replays through the `messages` channel on refresh or
 * mid-run join. Those events drain through the controller's
 * `for await` pump as a long microtask chain. Per-event
 * `store.setState` notifies `useSyncExternalStore` per event, and
 * after enough notifications React's `nestedUpdateCount` guard trips
 * with "Maximum update depth exceeded", permanently freezing the UI
 * on the first few messages. Coalescing to one notification per
 * macrotask lets React's scheduler commit between flushes.
 *
 * # Lifecycle
 *
 *   - `handleMessage(event)`              — apply a `messages` event delta.
 *   - `applyValues(values, msgs)`         — merge a `values` snapshot.
 *   - `recordToolCallNamespace(ns, id)`   — capture `namespace → tool_call_id`
 *     so subsequent tool message starts can recover the id.
 *   - `reset()`                           — clear all state on thread rebind.
 */
import type {
  MessagesEvent,
  MessageRole,
  MessageStartData,
} from "@langchain/protocol";
import type { BaseMessage } from "@langchain/core/messages";
import { MessageAssembler } from "../client/stream/messages.js";
import {
  assembledMessageToBaseMessage,
  type ExtendedMessageRole,
} from "./assembled-to-message.js";
import type { StreamStore } from "./store.js";
import type { RootSnapshot } from "./types.js";
import { namespaceKey } from "./namespace.js";
import {
  buildMessageIndex,
  messagesEqual,
  reconcileMessagesFromValues,
  shouldPreferValuesMessageForToolCalls,
} from "./message-reconciliation.js";

/**
 * Root-namespace message projection. Owns the merge between the
 * `messages` (streamed deltas) and `values` (authoritative
 * snapshots) channels for the root namespace.
 *
 * @typeParam StateType     - Root state shape; the messages array is read
 *   from `values[messagesKey]`.
 * @typeParam InterruptType - Shape of root protocol interrupts (forwarded
 *   into `RootSnapshot` updates).
 */
export class RootMessageProjection<
  StateType extends object,
  InterruptType = unknown,
> {
  /**
   * Key inside `values` that holds the message array. Defaults to
   * `"messages"` in the controller; configurable for state graphs
   * that surface messages under a different slot.
   */
  readonly #messagesKey: string;

  /** Root snapshot store written to on every merge. */
  readonly #store: StreamStore<RootSnapshot<StateType, InterruptType>>;

  /**
   * Stateful chunk assembler for in-flight messages. Reset (via a
   * fresh instance) on every {@link reset} so a new thread starts
   * with no half-built messages from the previous one.
   */
  #assembler = new MessageAssembler();

  /**
   * `messageId → role/toolCallId` captured from `message-start` events.
   * The assembler's intermediate output drops these fields, so we cache
   * them at start-time and reapply when projecting to a `BaseMessage`.
   */
  readonly #roles = new Map<
    string,
    { role: ExtendedMessageRole; toolCallId?: string }
  >();

  /**
   * `messageId → position in #store.messages` for fast in-place
   * updates as deltas arrive. Rebuilt on every full reconciliation
   * driven by a `values` event.
   */
  readonly #indexById = new Map<string, number>();

  /**
   * Ids observed in the most recent `values.messages` snapshot.
   * Reconciliation uses this to detect server-side removals: a
   * previously-seen id missing from the next snapshot means it was
   * removed by the server (and should drop from the projection).
   */
  #valuesMessageIds = new Set<string>();

  /**
   * `namespaceKey → tool_call_id` captured from root `tool-started`
   * events. Used as a fallback when a tool-role `message-start` is
   * missing its `tool_call_id` field.
   */
  readonly #toolCallIdByNamespace = new Map<string, string>();

  /**
   * Coalescing buffer for store writes. {@link handleMessage} and
   * {@link applyValues} stage their computed `messages` / `values`
   * here instead of calling `store.setState` per event. A single
   * `setTimeout(0)` flush commits them in one `setState`, so a
   * burst of SSE events draining as a microtask chain becomes one
   * store notification at the next macrotask boundary.
   *
   * `null` means "no staged write" — once a flush settles, the
   * slots are cleared so the next call starts from the latest
   * committed store snapshot.
   */
  #pendingMessages: BaseMessage[] | null = null;
  #pendingValues: StateType | null = null;
  #flushScheduled = false;

  /**
   * @param params.messagesKey - Key inside `values` that holds the
   *   message array.
   * @param params.store       - Root snapshot store to mutate.
   */
  constructor(params: {
    messagesKey: string;
    store: StreamStore<RootSnapshot<StateType, InterruptType>>;
  }) {
    this.#messagesKey = params.messagesKey;
    this.#store = params.store;
  }

  /**
   * Drop all per-thread state. Called by the controller on thread
   * rebind / dispose so a swap doesn't surface stale messages.
   */
  reset(): void {
    this.#assembler = new MessageAssembler();
    this.#roles.clear();
    this.#indexById.clear();
    this.#valuesMessageIds = new Set();
    this.#toolCallIdByNamespace.clear();
    // Drop any unflushed pending writes — they were computed against
    // the previous thread's baseline and committing them after a
    // rebind would bleed stale messages into the new thread.
    this.#pendingMessages = null;
    this.#pendingValues = null;
    this.#flushScheduled = false;
  }

  /**
   * Record a `namespace → tool_call_id` mapping captured from a root
   * `tool-started` event.
   *
   * The companion tool-role `message-start` event may not carry a
   * `tool_call_id`, so we fall back to the most recent value recorded
   * here for the same namespace.
   *
   * @param namespace  - Event namespace from the `tool-started` event.
   * @param toolCallId - Tool call id from the same event.
   */
  recordToolCallNamespace(
    namespace: readonly string[],
    toolCallId: string
  ): void {
    this.#toolCallIdByNamespace.set(namespaceKey(namespace), toolCallId);
  }

  /**
   * Apply a `messages` channel event to the projection.
   *
   * Captures role/tool metadata on `message-start`, feeds the chunk
   * to the assembler, projects the assembled output to a
   * {@link BaseMessage}, and either appends or in-place updates the
   * pending messages buffer based on whether the id was seen before.
   *
   * @param event - The `messages` channel event to consume.
   */
  handleMessage(event: MessagesEvent): void {
    const data = event.params.data;
    if (data.event === "message-start") {
      const startData = data as MessageStartData;
      const role = (startData.role ?? "ai") as MessageRole;
      const extendedRole =
        (startData as { role?: ExtendedMessageRole }).role ?? role;
      let toolCallId = (startData as { tool_call_id?: string }).tool_call_id;
      // Tool messages need a tool_call_id to render. Fall back through:
      //   1. legacy `<id>-tool-<call_id>` message id format
      //   2. namespace-recorded tool_call_id (from #recordToolCallNamespace)
      if (extendedRole === "tool" && toolCallId == null) {
        const messageId = startData.id;
        if (messageId != null) {
          const match = /-tool-(.+)$/.exec(messageId);
          if (match != null) toolCallId = match[1];
        }
        if (toolCallId == null) {
          toolCallId = this.#toolCallIdByNamespace.get(
            namespaceKey(event.params.namespace)
          );
        }
      }
      if (startData.id != null) {
        this.#roles.set(startData.id, {
          role: extendedRole,
          toolCallId,
        });
      }
    }

    const update = this.#assembler.consume(event);
    if (update == null) return;
    const id = update.message.id;
    if (id == null) return;
    const captured = this.#roles.get(id) ?? { role: "ai" as const };
    const base = assembledMessageToBaseMessage(update.message, captured.role, {
      toolCallId: captured.toolCallId,
    });

    // Compute against the pending baseline if we have one (so an
    // earlier handleMessage in the same tick is the input to this
    // one), else against the latest committed store snapshot.
    // `#indexById` is the synchronous source of truth for "where is
    // each id in the current messages list" — every code path below
    // keeps it in sync before returning.
    const baselineMessages =
      this.#pendingMessages ?? this.#store.getSnapshot().messages;
    const existingIdx = this.#indexById.get(id);
    let messages: BaseMessage[];
    if (existingIdx == null) {
      this.#indexById.set(id, baselineMessages.length);
      messages = [...baselineMessages, base];
    } else if (messagesEqual(baselineMessages[existingIdx], base)) {
      // Identical re-emission — skip the store write to keep
      // snapshot identity stable.
      return;
    } else {
      messages = baselineMessages.slice();
      messages[existingIdx] = base;
    }

    // Mirror the new messages list into `values[messagesKey]` so
    // direct `values` reads (used by some hooks and by the eventual
    // `values` reconciliation) stay in sync.
    const baselineValues =
      this.#pendingValues ?? this.#store.getSnapshot().values;
    const values = syncMessagesIntoValues(
      baselineValues,
      this.#messagesKey,
      messages
    );
    this.#pendingMessages = messages;
    if (values !== baselineValues) this.#pendingValues = values;
    this.#scheduleFlush();
  }

  /**
   * Reconcile a full `values` snapshot into the projection.
   *
   * Delegates the merge to {@link reconcileMessagesFromValues}:
   * values stays authoritative for ordering and removals, while
   * streamed in-flight messages keep their content until the server
   * echoes them back. Empty messages just refresh the values blob.
   *
   * Rebuilds {@link #indexById} after the merge so subsequent delta
   * applications target the new positions.
   *
   * @param nextValues   - Full values snapshot from the `values` event.
   * @param nextMessages - The messages array extracted from
   *   `values[messagesKey]` and coerced to `BaseMessage` instances.
   */
  applyValues(nextValues: StateType, nextMessages: BaseMessage[]): void {
    const baselineSnapshot = this.#store.getSnapshot();
    const baselineMessages = this.#pendingMessages ?? baselineSnapshot.messages;
    const baselineValues = this.#pendingValues ?? baselineSnapshot.values;

    if (nextMessages.length === 0) {
      if (
        stateValuesShallowEqual(baselineValues, nextValues, this.#messagesKey)
      ) {
        return;
      }
      // Mirror the current `messages` list back into the values slot
      // so the staged snapshot stays consistent with the (separately
      // tracked) messages array.
      this.#pendingValues = syncMessagesIntoValues(
        nextValues,
        this.#messagesKey,
        baselineMessages
      );
      this.#scheduleFlush();
      return;
    }

    const reconciliation = reconcileMessagesFromValues({
      valueMessages: nextMessages,
      currentMessages: baselineMessages,
      currentIndexById: this.#indexById,
      previousValueMessageIds: this.#valuesMessageIds,
      preferValuesMessage: shouldPreferValuesMessageForToolCalls,
    });
    this.#valuesMessageIds = reconciliation.valueMessageIds;
    const messages = reconciliation.messages as BaseMessage[];
    const values = {
      ...(nextValues as Record<string, unknown>),
      [this.#messagesKey]: messages,
    } as StateType;
    if (
      messages === baselineMessages &&
      stateValuesShallowEqual(baselineValues, values, this.#messagesKey)
    ) {
      return;
    }

    // Reconciliation may reorder, drop, or substitute messages, so
    // rebuild the id → index map to match the new array.
    this.#indexById.clear();
    for (const [id, idx] of buildMessageIndex(messages)) {
      this.#indexById.set(id, idx);
    }
    this.#pendingMessages = messages;
    this.#pendingValues = values;
    this.#scheduleFlush();
  }

  /**
   * Schedule a coalesced flush on the next macrotask. Idempotent
   * within a tick — multiple `handleMessage` / `applyValues` calls
   * before the flush fires collapse into one store write.
   *
   * `setTimeout(0)` is a macrotask: it runs after the current
   * microtask chain drains, so a burst of SSE events processed by
   * the controller's `for await` pump becomes one `store.setState`
   * (and therefore one `useSyncExternalStore` notification).
   */
  #scheduleFlush = (): void => {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    setTimeout(this.#flushPending, 0);
  };

  /**
   * Drain `#pendingMessages` / `#pendingValues` to the store in a
   * single `setState` call.
   */
  #flushPending = (): void => {
    this.#flushScheduled = false;
    const messages = this.#pendingMessages;
    const values = this.#pendingValues;
    this.#pendingMessages = null;
    this.#pendingValues = null;
    if (messages == null && values == null) return;
    this.#store.setState((s) => {
      // Other rootStore mutators (controller-driven `isLoading`,
      // `interrupts`, `toolCalls`, etc.) do not touch `s.messages`
      // / `s.values`, so a last-write-wins commit on those two
      // fields is safe.
      if (messages == null) {
        return values == null ? s : { ...s, values };
      }
      if (values == null) return { ...s, messages };
      return { ...s, messages, values };
    });
  };
}

/**
 * Mirror a freshly-updated message list into `values[messagesKey]`.
 *
 * Returns the same `values` reference when the list is already
 * equal-by-content so the caller can keep the existing snapshot
 * identity (and avoid spurious `setSnapshot` notifications).
 */
function syncMessagesIntoValues<StateType extends object>(
  values: StateType,
  messagesKey: string,
  messages: BaseMessage[]
): StateType {
  const record = values as Record<string, unknown>;
  const current = record[messagesKey];
  if (Array.isArray(current) && messagesEqualList(current, messages)) {
    return values;
  }
  return {
    ...record,
    [messagesKey]: messages,
  } as StateType;
}

/**
 * True when two `BaseMessage` arrays carry the same per-message
 * content (using {@link messagesEqual}).
 */
function messagesEqualList(
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

/**
 * Shallow-equal for `values` objects, *ignoring* the messages slot.
 *
 * The messages array is compared separately by the caller (via
 * {@link messagesEqualList}) because both arrays contain class
 * instances whose JSON representation is not stable across reads.
 */
function stateValuesShallowEqual(
  previous: object,
  next: object,
  messagesKey: string
): boolean {
  if (previous === next) return true;
  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const previousKeys = Object.keys(previousRecord);
  const nextKeys = Object.keys(nextRecord);
  if (previousKeys.length !== nextKeys.length) return false;
  for (const key of previousKeys) {
    if (!Object.prototype.hasOwnProperty.call(nextRecord, key)) return false;
    const previousValue = previousRecord[key];
    const nextValue = nextRecord[key];
    if (
      key === messagesKey &&
      Array.isArray(previousValue) &&
      Array.isArray(nextValue)
    ) {
      continue;
    }
    if (!Object.is(previousValue, nextValue)) return false;
  }
  return true;
}
