/**
 * Namespace-scoped `custom:<name>` projection (stream extension).
 *
 * Opens a `custom` subscription and filters named events client-side.
 * The store retains the most-recent payload for the requested
 * transformer. Consumers that want the entire event history should use
 * the raw channel projection instead.
 */
import type { ProjectionSpec, ProjectionRuntime } from "../types.js";
import type { Event } from "@langchain/protocol";
import { namespaceKey } from "../namespace.js";
import { openProjectionSubscription } from "./runtime.js";

export function extensionProjection<T = unknown>(
  name: string,
  namespace: readonly string[]
): ProjectionSpec<T | undefined> {
  const ns = [...namespace];
  const key = `extension|${name}|${namespaceKey(ns)}`;

  return {
    key,
    namespace: ns,
    initial: undefined,
    open({ thread, store }): ProjectionRuntime {
      return openProjectionSubscription({
        thread,
        channels: [`custom:${name}`],
        namespace: ns,
        resumeOnPause: true,
        onEvent(event: Event) {
          const data = event.params.data as
            | {
                name?: unknown;
                payload?: unknown;
              }
            | undefined;
          const payload =
            data?.payload != null &&
            typeof data.payload === "object" &&
            "name" in data.payload
              ? (data.payload as { name?: unknown; payload?: unknown })
              : data;
          if (payload?.name !== name) return;
          store.setValue(payload.payload as T);
        },
      });
    },
  };
}
