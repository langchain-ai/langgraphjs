/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  ChannelRegistry,
  ProjectionSpec,
  StreamStore,
} from "@langchain/langgraph-sdk/stream";

/**
 * React-side primitive that composes {@link ChannelRegistry.acquire}
 * with {@link useSyncExternalStore}.
 *
 * Contract:
 *  - On mount (or when `key` changes) this hook acquires a
 *    ref-counted projection from the registry and subscribes to its
 *    store. React re-renders automatically whenever the store's
 *    snapshot changes.
 *  - On unmount (or when `key` changes) the previous acquisition is
 *    released. If this was the last consumer of that spec, the
 *    registry closes the underlying server subscription.
 *
 * The first render (before `useEffect` runs) returns `initialValue`.
 * Subsequent renders read from the acquired store.
 *
 * Framework bindings for Vue/Svelte/Angular follow the same shape —
 * acquire on setup/mount, release on scope-dispose/unmount — but use
 * their own reactivity primitive instead of `useSyncExternalStore`.
 */
export function useProjection<T>(
  registry: ChannelRegistry | null | undefined,
  specFactory: () => ProjectionSpec<T>,
  key: string,
  initialValue: T
): T {
  const [store, setStore] = useState<StreamStore<T> | null>(null);

  useEffect(() => {
    if (registry == null) return undefined;
    const acquired = registry.acquire(specFactory());
    setStore(acquired.store);
    return () => {
      acquired.release();
      setStore(null);
    };
    // `specFactory` is intentionally not in the dep array: identity
    // of the factory function is not meaningful — only the `key` is.
    // Callers construct the spec inline and rely on the key to dedupe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, key]);

  return useSyncExternalStore<T>(
    store != null ? store.subscribe : NOOP_SUBSCRIBE,
    () => (store != null ? store.getSnapshot() : initialValue),
    () => initialValue
  );
}

const NOOP_SUBSCRIBE: (listener: () => void) => () => void = () => () => {};
