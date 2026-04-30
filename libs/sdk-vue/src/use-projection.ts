import {
  onScopeDispose,
  readonly,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type ShallowRef,
} from "vue";
import type {
  ChannelRegistry,
  ProjectionSpec,
} from "@langchain/langgraph-sdk/stream";

/**
 * Vue primitive that composes {@link ChannelRegistry.acquire} with
 * Vue's reactivity system.
 *
 * Contract (mirrors the React `useProjection` hook but adapted to
 * Vue's `setup` + `onScopeDispose` lifecycle):
 *
 *  - On `setup()` (or whenever `registry` / `key` change) the
 *    composable acquires a ref-counted projection from the registry
 *    and subscribes to its store. Vue re-renders automatically
 *    whenever the store's snapshot changes.
 *  - On `onScopeDispose` (or when `registry` / `key` change) the
 *    previous acquisition is released. If this was the last consumer
 *    of that spec, the registry closes the underlying server
 *    subscription.
 *  - When `registry` is `null`/`undefined` the composable stays at
 *    `initialValue`. This is the happy path for root-served
 *    projections (`useMessages`, `useToolCalls`, `useValues`) which
 *    delegate to the always-on root store instead of acquiring a new
 *    registry projection.
 *
 * `registry` and `key` accept `MaybeRefOrGetter` so selector
 * composables can pass a reactive target (e.g. a computed subagent
 * snapshot) and have the projection rebind automatically.
 *
 * Returns a `Readonly<ShallowRef<T>>` so templates auto-unwrap and
 * scripts can `computed(() => proj.value)`. The underlying ref is
 * `shallowRef` — consumers that mutate the snapshot get undefined
 * behaviour; stream projections should always be treated as
 * immutable snapshots.
 */
export function useProjection<T>(
  registry: MaybeRefOrGetter<ChannelRegistry | null | undefined>,
  specFactory: () => ProjectionSpec<T>,
  key: MaybeRefOrGetter<string>,
  initialValue: T
): Readonly<ShallowRef<T>> {
  const state = shallowRef<T>(initialValue);
  let currentRelease: (() => void) | null = null;
  let currentUnsubscribe: (() => void) | null = null;

  const detach = () => {
    currentUnsubscribe?.();
    currentUnsubscribe = null;
    currentRelease?.();
    currentRelease = null;
  };

  watch(
    () => [toValue(registry), toValue(key)] as const,
    ([nextRegistry]) => {
      detach();
      if (nextRegistry == null) {
        state.value = initialValue;
        return;
      }
      const acquired = nextRegistry.acquire(specFactory());
      state.value = acquired.store.getSnapshot();
      currentUnsubscribe = acquired.store.subscribe(() => {
        state.value = acquired.store.getSnapshot();
      });
      currentRelease = acquired.release;
    },
    { immediate: true, flush: "sync" }
  );

  onScopeDispose(detach);

  return readonly(state) as Readonly<ShallowRef<T>>;
}
