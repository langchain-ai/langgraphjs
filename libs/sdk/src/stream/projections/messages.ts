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
  Event,
  MessagesEvent,
  MessageRole,
  MessageStartData,
  ValuesEvent,
} from "@langchain/protocol";
import type { BaseMessage } from "@langchain/core/messages";
import { MessageAssembler } from "../../client/stream/messages.js";
import type { SubscriptionHandle } from "../../client/stream/index.js";
import {
  assembledMessageToBaseMessage,
  type ExtendedMessageRole,
} from "../assembled-to-message.js";
import { ensureMessageInstances } from "../../ui/messages.js";
import type { Message } from "../../types.messages.js";
import type { ProjectionSpec, ProjectionRuntime } from "../types.js";

export function messagesProjection(
  namespace: readonly string[]
): ProjectionSpec<BaseMessage[]> {
  const ns = [...namespace];
  const key = `messages|${ns.join("\u0000")}`;

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

      // Root-scoped projections whose channels are already covered by
      // the controller's root pump attach to the shared fan-out
      // instead of opening a second server subscription. The root
      // pump runs at `{namespaces: [[]], depth: 1}`, which is exactly
      // the scope a root-namespace `messagesProjection` wants.
      const rootShortCircuit =
        ns.length === 0 && rootBus.channels.includes("messages");

      if (rootShortCircuit) {
        const unsubscribe = rootBus.subscribe((event) => {
          if (event.method !== "messages") return;
          if (event.params.namespace.length !== 0) return;
          applyEvent(event as MessagesEvent);
        });
        return {
          dispose() {
            unsubscribe();
          },
        };
      }

      let handle: SubscriptionHandle<Event> | undefined;
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

      const start = async () => {
        try {
          handle = await thread.subscribe({
            // Subscribe to both `messages` (live token deltas that
            // drive the in-flight assistant bubble) and `values`
            // (periodic full-state snapshots that include
            // `values.messages`). Consuming values lets a late-
            // mounted projection backfill the thread history after
            // the run has finished — the server does not replay
            // `messages` deltas, but every values checkpoint carries
            // the full messages array with `tool_call_id` intact.
            channels: ["messages", "values"],
            namespaces: ns.length > 0 ? [ns] : [[]],
            // Depth 1: a namespace-scoped projection only wants events
            // emitted AT its namespace (e.g. a subagent's own LLM
            // turns), not the deeper subagents it may spawn. Deeper
            // content is covered by their own projections opened when
            // those subagents are rendered.
            depth: 1,
          });
          for await (const event of handle) {
            if (disposed) break;
            if (event.method === "messages") {
              applyEvent(event as MessagesEvent);
            } else if (event.method === "values") {
              applyValuesEvent(event as ValuesEvent);
            }
          }
        } catch {
          // Thread closed / errored — nothing to surface on this store.
        }
      };

      // Backfill the store from `values.messages` snapshots.
      //
      // `values` events carry the full, committed state of the
      // thread's `messages` channel at a checkpoint — they fire
      // on node completion, AFTER every `messages`-channel delta
      // for that turn has been emitted. In practice they are the
      // authoritative source of truth for the final shape of
      // every message in the snapshot.
      //
      // We treat them as such: for any message whose id we have
      // already seen via the live `messages` channel, we REPLACE
      // the store entry with the values-coerced instance. This
      // self-heals two classes of glitch that surface in
      // `getToolCallsWithResults`-style pairing logic:
      //
      //  1. Tool messages arriving without `tool_call_id` on the
      //     messages channel (e.g. the `message-start` predates
      //     the server-side fix, or the client briefly saw an
      //     empty shell before the `content-block-*` deltas).
      //     The values snapshot always carries `tool_call_id` and
      //     the final content.
      //
      //  2. AI messages whose finalized `tool_calls` didn't fully
      //     land via the messages channel (e.g. a late-mounted
      //     subscription missed some `content-block-finish`
      //     events), leaving the store holding an
      //     `AIMessageChunk` with only partial
      //     `tool_call_chunks` and no resolved `tool_calls`. The
      //     values snapshot's AI message has `tool_calls`
      //     populated, so pairing downstream works.
      //
      // Overwriting is safe because values only fires on state
      // commits (never mid-stream) and the values-coerced shape
      // is the canonical one the rest of the app consumes. It's
      // also idempotent: a subsequent messages-channel
      // `content-block-*` or `message-finish` for the same id
      // will correct any regressions via `applyEvent`'s replace
      // path.
      //
      // Unkeyed messages (no stable id) are skipped because we
      // can't dedupe them safely across repeated snapshots.
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

        let changed = false;
        for (const message of coerced) {
          const id = (message as BaseMessage).id;
          if (typeof id !== "string" || id.length === 0) continue;
          const existingIdx = indexById.get(id);
          if (existingIdx != null) {
            pendingMessages[existingIdx] = message as BaseMessage;
          } else {
            indexById.set(id, pendingMessages.length);
            pendingMessages.push(message as BaseMessage);
          }
          changed = true;
        }
        if (changed) scheduleFlush();
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
          if (startData.message_id != null) {
            roleByKey.set(startData.message_id, {
              role: extendedRole,
              toolCallId: maybeToolCallId,
            });
          }
        }

        const update = assembler.consume(event);
        const msg = update.message;
        const id = msg.messageId;
        if (id == null) return;
        const captured = roleByKey.get(id) ?? { role: "ai" as const };
        const base = assembledMessageToBaseMessage(msg, captured.role, {
          toolCallId: captured.toolCallId,
        });

        const existingIdx = indexById.get(id);
        if (existingIdx == null) {
          indexById.set(id, pendingMessages.length);
          pendingMessages.push(base);
        } else {
          pendingMessages[existingIdx] = base;
        }
        scheduleFlush();
      };

      void start();

      return {
        async dispose() {
          disposed = true;
          if (flushChannel != null) {
            flushChannel.port1.onmessage = null;
            flushChannel.port1.close();
            flushChannel.port2.close();
          }
          try {
            await handle?.unsubscribe();
          } catch {
            // already closed
          }
        },
      };
    },
  };
}
