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
} from "@langchain/protocol";
import type { BaseMessage } from "@langchain/core/messages";
import { MessageAssembler } from "../../client/stream/messages.js";
import type { SubscriptionHandle } from "../../client/stream/index.js";
import {
  assembledMessageToBaseMessage,
  type ExtendedMessageRole,
} from "../assembled-to-message.js";
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
    open({ thread, store }): ProjectionRuntime {
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

      let handle: SubscriptionHandle<Event, unknown> | undefined;
      let disposed = false;

      const start = async () => {
        try {
          handle = await thread.subscribe({
            channels: ["messages"],
            namespaces: ns.length > 0 ? [ns] : undefined,
          });
          for await (const event of handle) {
            if (disposed) break;
            if (event.method !== "messages") continue;
            applyEvent(event as MessagesEvent);
          }
        } catch {
          // Thread closed / errored — nothing to surface on this store.
        }
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

        const current = store.getSnapshot();
        const existingIdx = indexById.get(id);
        if (existingIdx == null) {
          indexById.set(id, current.length);
          store.setValue([...current, base]);
        } else {
          const next = current.slice();
          next[existingIdx] = base;
          store.setValue(next);
        }
      };

      void start();

      return {
        async dispose() {
          disposed = true;
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
