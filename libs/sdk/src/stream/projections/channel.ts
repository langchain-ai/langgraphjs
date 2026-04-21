/**
 * Raw channel escape hatch.
 *
 * Subscribes to an arbitrary list of channels at an arbitrary
 * namespace and retains a bounded buffer of events. Consumers that
 * need assembly semantics should use `messagesProjection`,
 * `toolCallsProjection`, etc. instead; this one is for inspection,
 * custom reducers, or niche use-cases.
 */
import type { Channel, Event } from "@langchain/protocol";
import type { SubscriptionHandle } from "../../client/stream/index.js";
import type { ProjectionSpec, ProjectionRuntime } from "../types.js";

/** Max events retained per raw subscription. Older events are dropped. */
const DEFAULT_BUFFER = 512;

export function channelProjection(
  channels: readonly Channel[],
  namespace: readonly string[],
  options: { bufferSize?: number } = {}
): ProjectionSpec<Event[]> {
  const chs = [...channels].sort();
  const ns = [...namespace];
  const bufferSize = options.bufferSize ?? DEFAULT_BUFFER;
  const key = `channel|${bufferSize}|${chs.join(",")}|${ns.join("\u0000")}`;

  return {
    key,
    namespace: ns,
    initial: [],
    open({ thread, store, rootBus }): ProjectionRuntime {
      // If this projection is scoped to the root namespace AND every
      // requested channel is already covered by the controller's root
      // pump, attach to the shared fan-out instead of opening a
      // second server subscription. This is the common case for
      // lightweight event-trace / debug panels.
      const covered =
        ns.length === 0 && chs.every((c) => rootBus.channels.includes(c));

      if (covered) {
        const requestedSet = new Set(chs as Channel[]);
        const push = (event: Event): void => {
          if (!requestedSet.has(event.method as Channel)) return;
          const current = store.getSnapshot();
          const next =
            current.length >= bufferSize
              ? [...current.slice(current.length - bufferSize + 1), event]
              : [...current, event];
          store.setValue(next);
        };
        const unsubscribe = rootBus.subscribe(push);
        return {
          dispose() {
            unsubscribe();
          },
        };
      }

      let handle: SubscriptionHandle<Event, unknown> | undefined;
      let disposed = false;

      const start = async () => {
        try {
          handle = await thread.subscribe({
            channels: chs as Channel[],
            namespaces: ns.length > 0 ? [ns] : undefined,
          });
          for await (const event of handle) {
            if (disposed) break;
            const current = store.getSnapshot();
            const next =
              current.length >= bufferSize
                ? [
                    ...current.slice(current.length - bufferSize + 1),
                    event as Event,
                  ]
                : [...current, event as Event];
            store.setValue(next);
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
