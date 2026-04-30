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
import { NAMESPACE_SEPARATOR } from "../constants.js";
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
  const key = `channel|${bufferSize}|${chs.join(",")}|${ns.join(
    NAMESPACE_SEPARATOR
  )}`;

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
        // Pre-compute `custom:<name>` sub-filters so incoming events
        // can be matched in O(1). The server delivers named custom
        // events as `{ method: "custom", params: { data: { name } } }`,
        // so matching purely on `event.method` would miss them — we
        // need to peek at `data.name` when the caller asked for a
        // specific `custom:<name>` channel.
        const namedCustom = new Set<string>();
        for (const channel of chs) {
          if (channel.startsWith("custom:")) {
            namedCustom.add(channel.slice("custom:".length));
          }
        }
        const matches = (event: Event): boolean => {
          if (requestedSet.has(event.method as Channel)) return true;
          if (event.method !== "custom" || namedCustom.size === 0) {
            return false;
          }
          const data = (event.params as Record<string, unknown>).data as
            | { name?: unknown }
            | undefined;
          return typeof data?.name === "string" && namedCustom.has(data.name);
        };
        const push = (event: Event): void => {
          if (!matches(event)) return;
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

      let handle: SubscriptionHandle<Event> | undefined;
      let disposed = false;

      const start = async () => {
        try {
          const subscription = await thread.subscribe({
            channels: chs as Channel[],
            namespaces: ns.length > 0 ? [ns] : [[]],
            depth: 1,
          });
          handle = subscription;
          if (disposed) {
            await subscription.unsubscribe();
            return;
          }
          for await (const event of subscription) {
            if (disposed) break;
            const current = store.getSnapshot();
            const next =
              current.length >= bufferSize
                ? [...current.slice(current.length - bufferSize + 1), event]
                : [...current, event];
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
