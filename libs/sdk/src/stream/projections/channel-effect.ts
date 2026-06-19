/**
 * Side-effect counterpart to {@link channelProjection}.
 *
 * Where `channelProjection` retains a bounded *buffer* of raw events
 * for rendering, this helper delivers each event to a callback exactly
 * once — the idiomatic shape for analytics, logging, and other side
 * effects that should not live in render. Framework bindings wrap it as
 * `useChannelEffect` (React/Svelte/Vue) / `injectChannelEffect`
 * (Angular).
 *
 * # Why this is built on the registry
 *
 * It acquires the very same ref-counted {@link channelProjection} entry
 * that the selector hooks use, so:
 *
 *  - N consumers of the same `channels`/`namespace`/options share a
 *    single server subscription (the registry dedupes by `spec.key`).
 *  - The subscription survives thread swaps for free (the registry
 *    rebinds every live entry on `controller.hydrate(...)`).
 *
 * Each consumer then diffs the shared store independently, so multiple
 * `useChannelEffect` callers with *different* callbacks each receive
 * their own delivery.
 *
 * # Delivery semantics
 *
 *  - Only events that arrive while the effect is attached are
 *    delivered. Events already buffered when the effect attaches (e.g.
 *    a sibling `useChannel` populated the buffer first) are skipped —
 *    analytics must not double-count history on a late mount.
 *  - `channelProjection` appends exactly one event per store
 *    notification, so the cursor below tracks the last delivered event
 *    by identity and forwards everything after it. On a thread rebind
 *    the store resets to `[]`; the old cursor is no longer found, so
 *    the next batch of events for the new thread is delivered from the
 *    start.
 *  - `replay` is forwarded to the projection. It defaults to `false`
 *    here (live-only) — the opposite of `useChannel`'s buffer default —
 *    because firing analytics for replayed history is rarely what a
 *    side-effect consumer wants.
 */
import type { Channel, Event } from "@langchain/protocol";
import type { ChannelRegistry } from "../channel-registry.js";
import { channelProjection, type ChannelProjectionOptions } from "./channel.js";

/**
 * Options for {@link acquireChannelEffect}. Extends
 * {@link ChannelProjectionOptions} (`bufferSize`, `replay`) with the
 * per-event callback and an optional error sink.
 */
export interface ChannelEffectOptions extends ChannelProjectionOptions {
  /** Invoked once for every event observed while attached. */
  onEvent: (event: Event) => void;
  /**
   * Invoked when {@link onEvent} throws. When omitted, a throwing
   * `onEvent` is swallowed so one bad delivery cannot wedge the shared
   * store's notification loop or other consumers.
   */
  onError?: (error: unknown) => void;
}

/**
 * Acquire a side-effect subscription over one or more channels.
 *
 * @param registry - The stream's {@link ChannelRegistry}.
 * @param channels - Channels to observe (e.g. `["lifecycle", "tools"]`).
 * @param namespace - Resolved namespace (`[]` for the root).
 * @param options - Callbacks plus projection (`bufferSize`/`replay`)
 *   options.
 * @returns A `dispose()` function that detaches the listener and
 *   releases the ref-counted projection. Idempotent.
 */
export function acquireChannelEffect(
  registry: ChannelRegistry,
  channels: readonly Channel[],
  namespace: readonly string[],
  options: ChannelEffectOptions
): () => void {
  const { onEvent, onError, ...projectionOptions } = options;
  const acquired = registry.acquire<Event[]>(
    channelProjection(channels, namespace, {
      // Live-only by default for side effects; callers opt into replay
      // explicitly when they want to re-process history.
      replay: projectionOptions.replay ?? false,
      bufferSize: projectionOptions.bufferSize,
    })
  );
  const { store } = acquired;

  // Cursor: the last event already delivered to `onEvent`. Seeded with
  // the current tail so events buffered before this consumer attached
  // are skipped (no double-counting on a late mount).
  const initial = store.getSnapshot();
  let lastDelivered: Event | undefined =
    initial.length > 0 ? initial[initial.length - 1] : undefined;

  const deliver = (): void => {
    const snapshot = store.getSnapshot();
    let start = 0;
    if (lastDelivered !== undefined) {
      const index = snapshot.lastIndexOf(lastDelivered);
      // `index === -1` means the cursor fell out of the buffer (thread
      // rebind reset the store, or the bounded buffer evicted it).
      // Deliver from the start of the current snapshot.
      start = index === -1 ? 0 : index + 1;
    }
    for (let i = start; i < snapshot.length; i += 1) {
      const event = snapshot[i] as Event;
      try {
        onEvent(event);
      } catch (error) {
        if (onError) onError(error);
      }
    }
    if (snapshot.length > 0) {
      lastDelivered = snapshot[snapshot.length - 1];
    }
  };

  const unsubscribe = store.subscribe(deliver);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    unsubscribe();
    acquired.release();
  };
}
