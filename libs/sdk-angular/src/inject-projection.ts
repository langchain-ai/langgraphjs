import {
  DestroyRef,
  computed,
  effect,
  inject,
  isSignal,
  signal,
  untracked,
  type Signal,
} from "@angular/core";
import type {
  ChannelRegistry,
  ProjectionSpec,
} from "@langchain/langgraph-sdk/stream";

/**
 * Angular-side primitive that composes {@link ChannelRegistry.acquire}
 * with Angular Signals + {@link DestroyRef}.
 *
 * Contract (mirrors the React `useProjection` hook and the Vue
 * `useProjection` composable, but adapted to Angular's injection
 * context):
 *
 *  - Must be called in an injection context (component / directive /
 *    service field initializer, or `runInInjectionContext(...)`).
 *  - On first read (or when `registry` / `key` change) acquires a
 *    ref-counted projection from the registry and subscribes to its
 *    store. A `computed` view over the snapshot signal is returned.
 *  - On destroy (or when `registry` / `key` change) the previous
 *    acquisition is released. If this was the last consumer of that
 *    spec, the registry closes the underlying server subscription.
 *  - When `registry` is `null`/`undefined` the projection stays at
 *    `initialValue`. This is the happy path for root-served
 *    projections (`injectMessages`, `injectToolCalls`,
 *    `injectValues`) which delegate to the always-on root snapshot
 *    instead of acquiring a new registry projection.
 *
 * Reactive inputs: `registry` and `key` accept either a plain value
 * or a `Signal` so selector helpers can feed a computed target (e.g.
 * a subagent snapshot tracked on a signal) and rebind automatically.
 */
export function injectProjection<T>(
  registry:
    | ChannelRegistry
    | null
    | undefined
    | Signal<ChannelRegistry | null | undefined>,
  specFactory: () => ProjectionSpec<T>,
  key: string | Signal<string>,
  initialValue: T
): Signal<T> {
  const state = signal<T>(initialValue);
  const destroyRef = inject(DestroyRef);

  const registrySignal: () => ChannelRegistry | null | undefined = isSignal(
    registry
  )
    ? (registry as Signal<ChannelRegistry | null | undefined>)
    : () => registry as ChannelRegistry | null | undefined;
  const keySignal: () => string = isSignal(key)
    ? (key as Signal<string>)
    : () => key as string;

  let currentRegistry: ChannelRegistry | null | undefined;
  let currentKey: string | undefined;
  let currentRelease: (() => void) | undefined;
  let currentUnsubscribe: (() => void) | undefined;

  const detach = () => {
    currentUnsubscribe?.();
    currentUnsubscribe = undefined;
    currentRelease?.();
    currentRelease = undefined;
  };

  const attach = (
    nextRegistry: ChannelRegistry | null | undefined,
    nextKey: string
  ) => {
    if (nextRegistry === currentRegistry && nextKey === currentKey) return;
    detach();
    currentRegistry = nextRegistry;
    currentKey = nextKey;

    if (nextRegistry == null) {
      state.set(initialValue);
      return;
    }

    const acquired = nextRegistry.acquire(specFactory());
    state.set(acquired.store.getSnapshot());
    currentUnsubscribe = acquired.store.subscribe(() => {
      state.set(acquired.store.getSnapshot());
    });
    currentRelease = acquired.release;
  };

  // Acquire synchronously so selectors are subscribed before a user can
  // submit and emit short-lived custom/projection events.
  attach(registrySignal(), keySignal());
  destroyRef.onDestroy(detach);

  effect(() => {
    const nextRegistry = registrySignal();
    const nextKey = keySignal();
    untracked(() => {
      attach(nextRegistry, nextKey);
    });
  });

  return computed(() => state());
}
