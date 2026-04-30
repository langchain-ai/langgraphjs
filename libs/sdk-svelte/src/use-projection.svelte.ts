import type {
  ChannelRegistry,
  ProjectionSpec,
} from "@langchain/langgraph-sdk/stream";

/**
 * Accepts either a plain `T` or a getter `() => T`. Selector
 * composables use this to support both static inputs (the common
 * case — `useMessages(stream, subagent)`) and reactive inputs
 * driven by component-level `$state`
 * (`useMessages(stream, () => activeSubagent)`).
 */
export type ValueOrGetter<T> = T | (() => T);

function unwrap<T>(input: ValueOrGetter<T>): T {
  if (typeof input === "function") return (input as () => T)();
  return input;
}

/**
 * Svelte-side handle returned by {@link useProjection} and all
 * single-value selector composables. Consumers read the reactive
 * payload via `proj.current`.
 *
 * Why an object with a `current` getter instead of a bare reactive
 * value:
 *  - Matches Svelte 5's `fromStore(...)` shape — users already know
 *    this pattern.
 *  - Portable across `.svelte` components and `.svelte.ts` modules.
 *    Returning a bare `$state` from a module function loses
 *    reactivity at the module boundary; a stable object with a
 *    getter keeps `$derived` tracking intact.
 *  - Templates read `{messages.current}` as data, not as a function
 *    call (`{messages()}` would be ambiguous in Svelte's template
 *    grammar).
 */
export interface ReactiveValue<T> {
  readonly current: T;
}

/**
 * Svelte binding over {@link ChannelRegistry.acquire}. Mirrors the
 * React and Vue `useProjection` primitives with an idiomatic Svelte
 * shape:
 *
 *  - On the first `$effect` run the composable acquires a ref-counted
 *    projection from the registry, seeds the returned `current` with
 *    the current snapshot, and subscribes to the store so templates
 *    auto-update on subsequent snapshots.
 *  - The `$effect` cleanup returned from the effect body runs on both
 *    scope teardown and before the next run, releasing the previous
 *    acquisition (and letting the registry close the underlying
 *    server subscription once the last consumer leaves).
 *  - When the resolved `registry` is `null` / `undefined` the
 *    composable stays at `initialValue`. This is the happy path for
 *    selector composables that short-circuit the root namespace by
 *    reading `stream.messages` / `stream.values` directly — they
 *    don't call `useProjection` at all at the root. Dynamic inputs
 *    that flip from root to scoped can pass `null` for the root case
 *    and fall back to `initialValue`.
 *
 * `registry` and `key` accept plain values or getters. Reading the
 * getter inside `$effect` auto-tracks any `$state` the getter
 * references, so the effect re-runs and re-acquires whenever the
 * resolved target changes.
 *
 * Must be called from a reactive context (a `.svelte` component
 * script or inside `$effect.root`). Calls outside a reactive scope
 * will not receive store updates because `$effect` never fires.
 */
export function useProjection<T>(
  registry: ValueOrGetter<ChannelRegistry | null | undefined>,
  specFactory: () => ProjectionSpec<T>,
  key: ValueOrGetter<string>,
  initialValue: T
): ReactiveValue<T> {
  let snapshot = $state<T>(initialValue);

  $effect(() => {
    const reg = unwrap(registry);
    // Reading `key` inside the effect auto-tracks any `$state` the
    // getter references so the effect re-runs when it changes.
    // The resolved value itself is not used beyond this read because
    // the registry is content-addressed by spec; the key is purely a
    // reactivity anchor for Svelte.
    unwrap(key);

    if (reg == null) {
      snapshot = initialValue;
      return;
    }

    const acquired = reg.acquire(specFactory());
    snapshot = acquired.store.getSnapshot();
    const unsubscribe = acquired.store.subscribe(() => {
      snapshot = acquired.store.getSnapshot();
    });

    return () => {
      unsubscribe();
      acquired.release();
    };
  });

  return {
    get current() {
      return snapshot;
    },
  };
}
