/**
 * Namespace-scoped `values` projection.
 *
 * Opens `thread.subscribe({ channels: ["values"], namespaces: [ns] })`
 * and stores the most-recent `values.data` payload. Mirrors
 * {@link ThreadStream.values} but scoped to an arbitrary namespace so
 * subgraphs and subagents can expose their own state.
 *
 * When the state payload carries a `messages` array of serialized
 * messages, those are coerced to `BaseMessage` class instances so the
 * surface shape matches the root snapshot.
 */
import type { Event, ValuesEvent } from "@langchain/protocol";
import type { BaseMessage } from "@langchain/core/messages";
import type { SubscriptionHandle } from "../../client/stream/index.js";
import {
  ensureMessageInstances,
  tryCoerceMessageLikeToMessage,
} from "../../ui/messages.js";
import type { Message } from "../../types.messages.js";
import type { ProjectionSpec, ProjectionRuntime } from "../types.js";

export function valuesProjection<T = unknown>(
  namespace: readonly string[],
  messagesKey: string = "messages"
): ProjectionSpec<T | undefined> {
  const ns = [...namespace];
  const key = `values|${messagesKey}|${ns.join("\u0000")}`;

  return {
    key,
    namespace: ns,
    initial: undefined,
    open({ thread, store, rootBus }): ProjectionRuntime {
      const applyValuesEvent = (event: ValuesEvent): void => {
        const coerced = coerceMessagesInState(event.params.data, messagesKey);
        store.setValue(coerced as T);
      };

      // See `messagesProjection` — root-scoped projections attach to
      // the controller's root bus instead of opening a duplicate
      // server subscription.
      const rootShortCircuit =
        ns.length === 0 && rootBus.channels.includes("values");

      if (rootShortCircuit) {
        const unsubscribe = rootBus.subscribe((event) => {
          if (event.method !== "values") return;
          if (event.params.namespace.length !== 0) return;
          applyValuesEvent(event as ValuesEvent);
        });
        return {
          dispose() {
            unsubscribe();
          },
        };
      }

      let handle: SubscriptionHandle<Event> | undefined;
      let disposed = false;

      const start = async () => {
        try {
          handle = await thread.subscribe({
            channels: ["values"],
            namespaces: ns.length > 0 ? [ns] : [[]],
            depth: 1,
          });
          for await (const event of handle) {
            if (disposed) break;
            if (event.method !== "values") continue;
            applyValuesEvent(event as ValuesEvent);
          }
        } catch {
          // closed / errored
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

function coerceMessagesInState(value: unknown, messagesKey: string): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const state = value as Record<string, unknown>;
  const maybeMessages = state[messagesKey];
  if (!Array.isArray(maybeMessages) || maybeMessages.length === 0) {
    return value;
  }
  // Fast path: array already contains class instances.
  const hasPlain = maybeMessages.some(
    (m) => m != null && typeof (m as BaseMessage).getType !== "function"
  );
  if (!hasPlain) return value;
  return {
    ...state,
    [messagesKey]: ensureMessageInstances(
      maybeMessages as (Message | BaseMessage)[]
    ),
  };
}

export { tryCoerceMessageLikeToMessage };
