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
 * It also feeds {@link SubagentDiscovery} from each new root message
 * — that's the layer that surfaces `task` tool calls as discovered
 * subagents, even before any subagent-scoped subscription is opened.
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
import type { SubagentDiscovery } from "./discovery/index.js";
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
   * Subagent discovery runner notified about every assembled root
   * message. Driving discovery from assembled messages (rather than
   * raw events) lets us discover subagents from synthesized
   * `tool_calls` without re-parsing protocol payloads.
   */
  readonly #subagents: SubagentDiscovery;

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
   * @param params.messagesKey - Key inside `values` that holds the
   *   message array.
   * @param params.store       - Root snapshot store to mutate.
   * @param params.subagents   - Discovery runner fed by each new
   *   assembled message.
   */
  constructor(params: {
    messagesKey: string;
    store: StreamStore<RootSnapshot<StateType, InterruptType>>;
    subagents: SubagentDiscovery;
  }) {
    this.#messagesKey = params.messagesKey;
    this.#store = params.store;
    this.#subagents = params.subagents;
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
   * store's messages array based on whether the id was seen before.
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
    this.#subagents.discoverFromMessage(base, event.params.namespace);

    this.#store.setState((s) => {
      const existingIdx = this.#indexById.get(id);
      let messages: BaseMessage[];
      if (existingIdx == null) {
        // First sighting: append at end and remember its index for
        // future delta updates.
        this.#indexById.set(id, s.messages.length);
        messages = [...s.messages, base];
      } else if (messagesEqual(s.messages[existingIdx], base)) {
        // Identical re-emission of an already-projected message —
        // skip the store write to keep snapshot identity stable.
        return s;
      } else {
        // In-place update for a known id.
        messages = s.messages.slice();
        messages[existingIdx] = base;
      }

      // Mirror the new messages list into `values[messagesKey]` so
      // direct `values` reads (used by some hooks and by the eventual
      // `values` reconciliation) stay in sync.
      const values = syncMessagesIntoValues(
        s.values,
        this.#messagesKey,
        messages
      );
      return values === s.values
        ? { ...s, messages }
        : { ...s, messages, values };
    });
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
    this.#store.setState((s) => {
      if (nextMessages.length === 0) {
        return stateValuesShallowEqual(s.values, nextValues, this.#messagesKey)
          ? s
          : { ...s, values: nextValues };
      }

      const reconciliation = reconcileMessagesFromValues({
        valueMessages: nextMessages,
        currentMessages: s.messages,
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
        messages === s.messages &&
        stateValuesShallowEqual(s.values, values, this.#messagesKey)
      ) {
        return s;
      }

      // Reconciliation may reorder, drop, or substitute messages, so
      // rebuild the id → index map to match the new array.
      this.#indexById.clear();
      for (const [id, idx] of buildMessageIndex(messages)) {
        this.#indexById.set(id, idx);
      }
      return {
        ...s,
        values,
        messages,
      };
    });
  }
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
