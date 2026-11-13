/**
 * Minimal observable store backing every framework binding.
 *
 * The shape is intentionally tiny:
 *
 *  - `subscribe(listener) → unsubscribe` lines up with React's
 *    `useSyncExternalStore`.
 *  - `getSnapshot()` returns a referentially-stable value for
 *    unchanged state so React can bail out of renders.
 *  - Vue/Svelte/Angular bindings wrap `subscribe` + `getSnapshot` in
 *    their own reactivity primitive (`shallowRef` / `writable` /
 *    `signal`) in ~10 lines.
 *
 * Snapshot identity matters: a listener is only useful if
 * `getSnapshot()` returns a *different* reference when state changes.
 * Callers MUST pass a freshly-constructed value to {@link setState};
 * mutating the previous snapshot in place will break React's bail-out
 * and cause infinite re-renders.
 */

export type StoreListener = () => void;

export class StreamStore<T> {
  #snapshot: T;
  readonly #listeners = new Set<StoreListener>();

  constructor(initial: T) {
    this.#snapshot = initial;
  }

  subscribe = (listener: StoreListener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): T => this.#snapshot;

  /** Replace the snapshot and notify every listener. */
  setValue = (next: T): void => {
    if (Object.is(next, this.#snapshot)) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  };

  /**
   * Functional update. The `updater` receives the current snapshot and
   * MUST return a new object. Returning the same reference is a no-op.
   */
  setState = (updater: (previous: T) => T): void => {
    this.setValue(updater(this.#snapshot));
  };
}
