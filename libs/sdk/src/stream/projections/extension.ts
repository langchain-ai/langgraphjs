/**
 * Namespace-scoped `custom:<name>` projection (stream extension).
 *
 * Opens a `custom:<name>` subscription — already unwrapped server-side
 * by `ThreadStream.#subscribeRaw`, so the subscription yields the raw
 * payload emitted by the transformer, not the event envelope. The
 * store retains the most-recent payload. Consumers that want the
 * entire event history should use the raw channel projection instead.
 */
import { NAMESPACE_SEPARATOR } from "../constants.js";
import type { ProjectionSpec, ProjectionRuntime } from "../types.js";
import type { EventSubscription } from "../../client/stream/index.js";

export function extensionProjection<T = unknown>(
  name: string,
  namespace: readonly string[]
): ProjectionSpec<T | undefined> {
  const ns = [...namespace];
  const key = `extension|${name}|${ns.join(NAMESPACE_SEPARATOR)}`;
  const channel = `custom:${name}` as const;

  return {
    key,
    namespace: ns,
    initial: undefined,
    open({ thread, store }): ProjectionRuntime {
      let handle: EventSubscription<unknown> | undefined;
      let disposed = false;

      const start = async () => {
        try {
          const subscription = await thread.subscribe(channel, {
            namespaces: ns.length > 0 ? [ns] : [[]],
            depth: 1,
          });
          handle = subscription;
          while (!disposed) {
            for await (const payload of subscription) {
              if (disposed) break;
              // The SDK transforms `custom:<name>` events to their raw
              // `data.payload` at the subscribe boundary, so `payload`
              // is already the user-space value.
              store.setValue(payload as T);
            }
            if (disposed || !subscription.isPaused) break;
            await subscription.waitForResume();
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
