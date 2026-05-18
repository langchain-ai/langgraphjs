/**
 * Namespace-scoped `messages` projection.
 *
 * Opens `thread.subscribe({ channels: ["messages"], namespaces: [ns] })`
 * and folds each `messages` event through {@link MessageAssembler}.
 * Every update — start, block delta, block finish, message finish —
 * re-derives a `BaseMessage` class instance for the currently-active
 * message and updates its slot in the store.
 *
 * The projection emits `BaseMessage[]` (class instances from
 * `@langchain/core/messages`), never plain serialized objects.
 */
import type {
  MessagesEvent,
  MessageRole,
  MessageStartData,
  ValuesEvent,
} from "@langchain/protocol";
import type { BaseMessage } from "@langchain/core/messages";
import { MessageAssembler } from "../../client/stream/messages.js";
import {
  assembledMessageToBaseMessage,
  type ExtendedMessageRole,
} from "../assembled-to-message.js";
import { ensureMessageInstances } from "../../ui/messages.js";
import type { Message } from "../../types.messages.js";
import type { ProjectionSpec, ProjectionRuntime } from "../types.js";
import { isRootNamespace, namespaceKey } from "../namespace.js";
import {
  buildMessageIndex,
  reconcileMessagesFromValues,
  shouldPreferValuesMessageForToolCalls,
} from "../message-reconciliation.js";
import { openProjectionSubscription } from "./runtime.js";

export function messagesProjection(
  namespace: readonly string[]
): ProjectionSpec<BaseMessage[]> {
  const ns = [...namespace];
  const key = `messages|${namespaceKey(ns)}`;

  return {
    key,
    namespace: ns,
    initial: [],
    open({ thread, store, rootBus }): ProjectionRuntime {
      const assembler = new MessageAssembler();
      // Per-messageId state needed for BaseMessage projection:
      //  - `role` is only in the `message-start` event; we cache it
      //    so subsequent delta events still produce a typed message.
      //  - `toolCallId` is pulled from message-start extras when role
      //    is `tool` (a convention we keep compatible with serialized
      //    v1 tool messages).
      const roleByKey = new Map<
        string,
        { role: ExtendedMessageRole; toolCallId?: string }
      >();
      const indexById = new Map<string, number>();
      // Ids this projection has observed via the `messages` channel
      // (token-level deltas). Used by `applyValuesEvent` to prefer the
      // stream-assembled version over the values-coerced shape while a
      // turn is streaming, matching the root controller's policy.
      const streamMessageIds = new Set<string>();
      // Ids observed in the most recent `values.messages` snapshot.
      // Messages that were present in a prior snapshot but are absent
      // from this one are treated as explicit removals (server-side
      // `RemoveMessage` reducer deltas). Stream-only messages (seen on
      // the messages channel but never echoed in a values snapshot)
      // are preserved — their enclosing superstep may simply not have
      // committed yet.
      let valuesMessageIds = new Set<string>();

      // Root-scoped projections whose channels are already covered by
      // the controller's root pump attach to the shared fan-out
      // instead of opening a second server subscription. The root
      // pump runs at `{namespaces: [[]], depth: 1}`, which is exactly
      // the scope a root-namespace `messagesProjection` wants.
      const rootShortCircuit =
        isRootNamespace(ns) && rootBus.channels.includes("messages");

      if (rootShortCircuit) {
        const unsubscribe = rootBus.subscribe((event) => {
          if (event.method !== "messages") return;
          if (!isRootNamespace(event.params.namespace)) return;
          applyEvent(event as MessagesEvent);
        });
        return {
          dispose() {
            unsubscribe();
          },
        };
      }

      let disposed = false;

      // Local mirror of the store contents. Every `applyEvent` /
      // `applyValuesEvent` mutates this synchronously; a coalesced
      // `scheduleFlush` copies it to `store` once per macrotask.
      //
      // Why the indirection? When a namespace-scoped projection
      // (e.g. a subagent modal opened after the run finished) first
      // subscribes, the server replays the entire history from
      // `seq=0`. Dozens of `messages`-channel events can land in a
      // single SSE parse — they drain through the `for await` loop
      // as a long microtask chain. Microtasks run before any
      // macrotask, so React's concurrent scheduler never gets a
      // chance to commit between updates. Calling `store.setValue`
      // per event in that burst overflows React's
      // `nestedUpdateCount` guard and throws "Maximum update depth
      // exceeded", permanently killing the projection and
      // leaving the store stuck at its first few messages.
      //
      // Batching via `MessageChannel` (macrotask) coalesces the
      // replay burst into one `setValue` call and lets React
      // commit between flushes for live token streaming too.
      const pendingMessages: BaseMessage[] = [];
      let dirty = false;
      let flushScheduled = false;
      const flushChannel =
        typeof MessageChannel !== "undefined" ? new MessageChannel() : null;

      const flush = (): void => {
        flushScheduled = false;
        if (!dirty || disposed) return;
        dirty = false;
        // `.slice()` breaks identity so React's `Object.is` bail-out
        // in `StreamStore.setValue` propagates the change.
        store.setValue(pendingMessages.slice());
      };
      if (flushChannel != null) {
        flushChannel.port1.onmessage = flush;
      }

      const scheduleFlush = (): void => {
        dirty = true;
        if (flushScheduled) return;
        flushScheduled = true;
        if (flushChannel != null) {
          flushChannel.port2.postMessage(null);
        } else {
          setTimeout(flush, 0);
        }
      };

      // Rebuild the store from `values.messages` snapshots.
      //
      // `values` events carry the full, committed state of the
      // thread's `messages` channel at a checkpoint — they fire
      // on node completion, AFTER every `messages`-channel delta
      // for that turn has been emitted. They are the authoritative
      // source of truth for ORDER and for non-streamed messages
      // (human turns, serialised tool results, subagent echoes, …).
      //
      // Why rebuild rather than merge-by-id?
      //
      // In practice the server may emit the same logical message
      // with DIFFERENT ids across successive `values` snapshots at
      // the same namespace — e.g. a subagent first surfaces its
      // seed prompt with a synthetic id like
      // `subagent:<tool_call_id>:human`, then a later superstep
      // echoes the same prompt back with a real UUID (or vice
      // versa). A naive "match-or-append by id" strategy treats
      // each fresh id as a new entry and the list grows
      // monotonically, showing the same content twice (or more)
      // in the UI.
      //
      // Policy (mirrors the root controller's `#applyValues`):
      //
      //  1. Walk `values.messages` in order. For each id, prefer
      //     the stream-assembled entry if we have one for that id
      //     (keeps in-progress token streaming visible); otherwise
      //     take the values-coerced instance. This self-heals the
      //     two classes of glitch the old merge-by-id handler
      //     targeted:
      //       - tool messages arriving without `tool_call_id` on
      //         the messages channel — the values snapshot always
      //         carries it;
      //       - AI messages whose finalized `tool_calls` didn't
      //         fully land via the messages channel — the values
      //         snapshot's AI message has them populated.
      //
      //  2. Append any stream-only ids (seen on the messages
      //     channel but never echoed in ANY values snapshot yet)
      //     — their enclosing superstep hasn't committed yet, so
      //     dropping them would flash the UI.
      //
      //  3. Ids that WERE in a prior values snapshot but are gone
      //     from this one are treated as explicit removals
      //     (`RemoveMessage` reducer deltas) and dropped.
      //
      // Unkeyed messages (no stable id) are passed through in
      // their values order because we can't dedupe them safely.
      const applyValuesEvent = (event: ValuesEvent): void => {
        const data = event.params.data;
        if (data == null || typeof data !== "object" || Array.isArray(data)) {
          return;
        }
        const state = data as Record<string, unknown>;
        const rawMessages = state.messages;
        if (!Array.isArray(rawMessages) || rawMessages.length === 0) return;

        const coerced = ensureMessageInstances(
          rawMessages as (Message | BaseMessage)[]
        );

        const reconciliation = reconcileMessagesFromValues({
          valueMessages: coerced,
          currentMessages: pendingMessages,
          currentIndexById: indexById,
          previousValueMessageIds: valuesMessageIds,
          streamedMessageIds: streamMessageIds,
          preferValuesMessage: shouldPreferValuesMessageForToolCalls,
        });
        valuesMessageIds = reconciliation.valueMessageIds;
        const reconciledMessages = [...reconciliation.messages];

        pendingMessages.length = 0;
        for (const message of reconciledMessages) pendingMessages.push(message);
        indexById.clear();
        for (const [id, idx] of buildMessageIndex(pendingMessages)) {
          indexById.set(id, idx);
        }
        scheduleFlush();
      };

      const applyEvent = (event: MessagesEvent): void => {
        const data = event.params.data;

        if (data.event === "message-start") {
          const startData = data as MessageStartData;
          const role = (startData.role ?? "ai") as MessageRole;
          // "tool" role is a v1 convention not represented in the
          // protocol enum but common in practice — keep it working
          // for graphs that emit it as an extensible field.
          const extendedRole =
            (startData as { role?: ExtendedMessageRole }).role ?? role;
          const maybeToolCallId = (startData as { tool_call_id?: string })
            .tool_call_id;
          if (startData.id != null) {
            roleByKey.set(startData.id, {
              role: extendedRole,
              toolCallId: maybeToolCallId,
            });
          }
        }

        const update = assembler.consume(event);
        if (update == null) return;
        const msg = update.message;
        const id = msg.id;
        if (id == null) return;
        const captured = roleByKey.get(id) ?? { role: "ai" as const };
        const base = assembledMessageToBaseMessage(msg, captured.role, {
          toolCallId: captured.toolCallId,
        });

        streamMessageIds.add(id);
        const existingIdx = indexById.get(id);
        if (existingIdx == null) {
          indexById.set(id, pendingMessages.length);
          pendingMessages.push(base);
        } else {
          pendingMessages[existingIdx] = base;
        }
        scheduleFlush();
      };

      const runtime = openProjectionSubscription({
        thread,
        // Subscribe to both `messages` (live token deltas that drive
        // the in-flight assistant bubble) and `values` (periodic full-
        // state snapshots). Consuming values lets late-mounted scoped
        // projections backfill history after the run has finished.
        channels: ["messages", "values"],
        namespace: ns,
        onEvent(event) {
          if (event.method === "messages") {
            applyEvent(event as MessagesEvent);
          } else if (event.method === "values") {
            applyValuesEvent(event as ValuesEvent);
          }
        },
      });

      return {
        async dispose() {
          disposed = true;
          if (flushChannel != null) {
            flushChannel.port1.onmessage = null;
            flushChannel.port1.close();
            flushChannel.port2.close();
          }
          await runtime.dispose();
        },
      };
    },
  };
}
