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
import type { ValuesEvent } from "@langchain/protocol";
import type { BaseMessage } from "@langchain/core/messages";
import {
  ensureMessageInstances,
  tryCoerceMessageLikeToMessage,
} from "../../ui/messages.js";
import type { Message } from "../../types.messages.js";
import type { ProjectionSpec, ProjectionRuntime } from "../types.js";
import { isRootNamespace, namespaceKey } from "../namespace.js";
import { openProjectionSubscription } from "./runtime.js";

export function valuesProjection<T = unknown>(
  namespace: readonly string[],
  messagesKey: string = "messages"
): ProjectionSpec<T | undefined> {
  const ns = [...namespace];
  const key = `values|${messagesKey}|${namespaceKey(ns)}`;

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
        isRootNamespace(ns) && rootBus.channels.includes("values");

      if (rootShortCircuit) {
        const unsubscribe = rootBus.subscribe((event) => {
          if (event.method !== "values") return;
          if (!isRootNamespace(event.params.namespace)) return;
          applyValuesEvent(event as ValuesEvent);
        });
        return {
          dispose() {
            unsubscribe();
          },
        };
      }

      return openProjectionSubscription({
        thread,
        channels: ["values"],
        namespace: ns,
        onEvent(event) {
          if (event.method !== "values") return;
          applyValuesEvent(event as ValuesEvent);
        },
      });
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
