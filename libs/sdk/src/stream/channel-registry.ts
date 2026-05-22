/**
 * Framework-agnostic ref-counted subscription cache.
 *
 * # What this module is
 *
 * Every framework binding (React, Vue, Svelte, Angular) owns one
 * {@link ChannelRegistry} per {@link StreamController}. The registry
 * is the single layer that:
 *
 *   1. Deduplicates server-side subscriptions across components — N
 *      hooks reading the same projection share one
 *      `thread.subscribe(...)` call and one {@link StreamStore}.
 *   2. Lazily opens / tears down subscriptions in step with mounting
 *      and unmounting consumers (ref counting on `spec.key`).
 *   3. Survives thread swaps — `controller.hydrate(newThreadId)`
 *      rebinds every live entry against the new thread without
 *      changing store identity, so React's
 *      `useSyncExternalStore` (and equivalents in other frameworks)
 *      keep working.
 *
 * # Why ref counting matters
 *
 * Most projections back at least one server subscription. Without
 * deduplication, every additional consumer of e.g. `useMessages(sub)`
 * would open its own SSE/WebSocket subscription, paying the same
 * payload N times. The registry guarantees we only ever pay once per
 * `spec.key`, regardless of how many consumers attach.
 *
 * # Why store identity is preserved on rebind
 *
 * Framework reactivity primitives subscribe to a store *instance* and
 * memoise their last seen snapshot. If we minted a new store on every
 * thread swap, every bound component would silently lose its
 * subscription. Instead, the registry keeps the same {@link StreamStore}
 * but resets its value to `spec.initial` and re-runs `spec.open()` —
 * consumers observe a clean slate without re-subscribing.
 *
 * @see ProjectionSpec - The contract every projection implements.
 * @see StreamStore - The observable store handed to consumers.
 */
import { StreamStore } from "./store.js";
import type {
  AcquiredProjection,
  ProjectionRuntime,
  ProjectionSpec,
  RootEventBus,
  ThreadStream,
} from "./types.js";

/**
 * Internal record kept for each unique `spec.key` actively held by at
 * least one consumer.
 *
 * We intentionally store `initial` and `open` separately from `spec`
 * so the registry never depends on the spec object's identity — two
 * specs sharing the same `key` but produced from different factory
 * calls (e.g. fresh objects on each render) still collapse onto the
 * same entry.
 */
interface Entry {
  /** Stable identity used for deduplication. */
  readonly key: string;
  /** Observable store handed back to every consumer of this key. */
  readonly store: StreamStore<unknown>;
  /** Initial snapshot reapplied on dispose / thread rebind. */
  readonly initial: unknown;
  /** Factory that opens the underlying subscription against a thread. */
  readonly open: ProjectionSpec<unknown>["open"];
  /** Live consumers of this entry. Drops to 0 → entry is torn down. */
  refCount: number;
  /**
   * Active runtime returned by `open()`. Undefined while detached
   * (no thread bound yet, or a rebind is in progress).
   */
  runtime: ProjectionRuntime | undefined;
}

/**
 * Ref-counted, thread-aware projection registry.
 *
 * Owns the `spec.key → (store, runtime)` mapping for one
 * {@link StreamController}. Lifecycle:
 *
 *   - `acquire(spec)`  → +1 ref, returns `{ store, release }`. The
 *      first acquire opens the projection's runtime; subsequent
 *      acquires for the same key share both the store and the
 *      runtime.
 *   - `release()`      → -1 ref. When the last consumer releases,
 *      the entry is removed and its runtime disposed.
 *   - `bind(thread)`   → swap or detach the underlying thread; every
 *      live entry's runtime is recreated against the new thread,
 *      keeping the same store identity.
 *   - `dispose()`      → tear everything down (idempotent). Safe to
 *      call multiple times.
 *
 * The registry is intentionally not generic over a state shape —
 * different consumers can hold projections producing different
 * snapshot types, so the registry keys everything as `unknown` and
 * lets {@link acquire} reapply the caller's `T` at the boundary.
 */
export class ChannelRegistry {
  /** Currently bound thread, or `undefined` while detached. */
  #thread: ThreadStream | undefined;

  /** Read-only fan-out of the controller's root subscription. */
  readonly #rootBus: RootEventBus;

  /** All live entries, keyed by `spec.key`. */
  readonly #entries = new Map<string, Entry>();

  /**
   * Construct a registry bound to the controller's root event bus.
   *
   * The bus is forwarded to every projection's `open()` so root-scoped
   * projections can avoid opening a second server subscription when
   * their channel set is already covered by the root pump.
   *
   * @param rootBus - Read-only fan-out of the root subscription.
   */
  constructor(rootBus: RootEventBus) {
    this.#rootBus = rootBus;
  }

  /**
   * Rebind every live entry to a new {@link ThreadStream} (or detach
   * when `thread == null`).
   *
   * Each live entry has its current runtime disposed (best-effort)
   * and its store reset to `entry.initial` so consumers see a clean
   * slate during the swap. When `thread != null`, a fresh runtime is
   * opened against the new thread.
   *
   * Critically the {@link StreamStore} *instance* is preserved across
   * the rebind: framework subscribers (e.g. React's
   * `useSyncExternalStore`) keep observing the same store reference,
   * so their subscriptions survive the swap.
   *
   * No-op when called with the currently bound thread.
   *
   * @param thread - The thread stream to bind, or `undefined` to detach.
   */
  bind(thread: ThreadStream | undefined): void {
    if (this.#thread === thread) return;
    const previous = this.#thread;
    this.#thread = thread;
    for (const entry of this.#entries.values()) {
      // Tear down any active runtime from the previous thread.
      if (entry.runtime != null && previous != null) {
        void tryDispose(entry.runtime);
      }
      entry.runtime = undefined;
      entry.store.setValue(entry.initial);
      if (thread != null) {
        entry.runtime = entry.open({
          thread,
          store: entry.store,
          rootBus: this.#rootBus,
        });
      }
    }
  }

  /** Currently bound thread (may be `undefined` pre-mount). */
  get thread(): ThreadStream | undefined {
    return this.#thread;
  }

  /**
   * Acquire a ref-counted projection.
   *
   * If no entry exists for `spec.key`, one is created (allocating a
   * {@link StreamStore} seeded with `spec.initial`) and — when a
   * thread is currently bound — its runtime is opened immediately.
   * If an entry already exists, its ref count is incremented and the
   * existing store is returned.
   *
   * The returned `release()` is idempotent: calling it more than once
   * is a no-op. When the ref count drops to zero, the entry is removed
   * and its runtime disposed (best-effort, never throws into callers).
   *
   * Safe to call from any framework lifecycle hook. Subsequent calls
   * for the same `spec.key` always return the same `store` reference
   * for the lifetime of the controller, so consumers can rely on store
   * identity.
   *
   * @typeParam T - Snapshot type produced by this projection.
   * @param spec - Projection contract; the registry keys off `spec.key`.
   * @returns A `{ store, release }` handle.
   */
  acquire<T>(spec: ProjectionSpec<T>): AcquiredProjection<T> {
    let entry = this.#entries.get(spec.key);
    if (entry == null) {
      const store = new StreamStore<T>(spec.initial);
      const newEntry: Entry = {
        key: spec.key,
        store: store as StreamStore<unknown>,
        initial: spec.initial as unknown,
        open: spec.open as ProjectionSpec<unknown>["open"],
        refCount: 0,
        runtime: undefined,
      };
      // Open the runtime immediately when a thread is already bound.
      // Otherwise it will be opened lazily by the next `bind()` call.
      if (this.#thread != null) {
        newEntry.runtime = spec.open({
          thread: this.#thread,
          store,
          rootBus: this.#rootBus,
        });
      }
      this.#entries.set(spec.key, newEntry);
      entry = newEntry;
    }
    entry.refCount += 1;

    let released = false;
    return {
      store: entry.store as StreamStore<T>,
      release: () => {
        if (released) return;
        released = true;
        const current = this.#entries.get(spec.key);
        if (current == null) return;
        current.refCount -= 1;
        if (current.refCount <= 0) {
          this.#entries.delete(spec.key);
          if (current.runtime != null) void tryDispose(current.runtime);
        }
      },
    };
  }

  /**
   * Tear everything down.
   *
   * Detaches the bound thread (so no further `bind()` calls reopen
   * runtimes) and disposes every live runtime in parallel. Safe to
   * call multiple times — subsequent calls find an empty registry
   * and resolve immediately.
   */
  async dispose(): Promise<void> {
    this.#thread = undefined;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.runtime != null) await tryDispose(entry.runtime);
      })
    );
  }

  /**
   * Number of live entries. Diagnostic-only — callers should not
   * branch on this value at runtime; it exists for tests asserting
   * that consumers properly release their projections.
   */
  get size(): number {
    return this.#entries.size;
  }
}

/**
 * Best-effort runtime disposal.
 *
 * `dispose()` should never throw, but a misbehaving projection should
 * not be able to wedge the entire registry. We swallow disposal
 * errors so the surrounding `bind()` / `release()` / `dispose()`
 * paths always make progress.
 *
 * @param runtime - Runtime returned by {@link ProjectionSpec.open}.
 */
async function tryDispose(runtime: ProjectionRuntime): Promise<void> {
  try {
    await runtime.dispose();
  } catch {
    // Best-effort — dispose should never throw, but we don't want a
    // bad projection to wedge the registry.
  }
}
