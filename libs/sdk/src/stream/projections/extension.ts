/**
 * Namespace-scoped `custom:<name>` projection (stream extension).
 *
 * Opens a `custom` subscription and filters named events client-side.
 * The store retains the most-recent payload for the requested
 * transformer. Consumers that want the entire event history should use
 * the raw channel projection instead.
 */
import { NAMESPACE_SEPARATOR } from "../constants.js";
import type { ProjectionSpec, ProjectionRuntime } from "../types.js";
import type { Event } from "@langchain/protocol";
import type { SubscriptionHandle } from "../../client/stream/index.js";

export function extensionProjection<T = unknown>(
  name: string,
  namespace: readonly string[]
): ProjectionSpec<T | undefined> {
  const ns = [...namespace];
  const key = `extension|${name}|${ns.join(NAMESPACE_SEPARATOR)}`;

  return {
    key,
    namespace: ns,
    initial: undefined,
    open({ thread, store }): ProjectionRuntime {
      let handle: SubscriptionHandle<Event> | undefined;
      let disposed = false;

      const start = async () => {
        try {
          const subscription = await thread.subscribe({
            channels: ["custom"],
            namespaces: ns.length > 0 ? [ns] : [[]],
            depth: 1,
          });
          handle = subscription;
          if (disposed) {
            await subscription.unsubscribe();
            return;
          }
          while (!disposed) {
            for await (const event of subscription) {
              if (disposed) break;
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
              if (payload?.name !== name) continue;
              store.setValue(payload.payload as T);
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
