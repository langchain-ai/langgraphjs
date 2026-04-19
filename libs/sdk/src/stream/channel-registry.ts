/**
 * Framework-agnostic ref-counted subscription cache.
 *
 * Every framework binding (React, Vue, Svelte, Angular) owns one
 * `ChannelRegistry` per stream controller. Components acquire a
 * projection by `spec.key` — the first acquire opens one
 * `thread.subscribe(...)` call and spins up the spec's `open()`
 * pump; subsequent acquires with the same key bump a ref count and
 * share the same {@link StreamStore}.
 *
 * When the last consumer calls `release()`, the registry tears the
 * entry down (awaits `dispose()`, drops the store) so the server
 * subscription is closed. Thread rebinds (e.g. `controller.hydrate`
 * swapping to a new thread id) transparently reopen every live entry
 * against the new thread while keeping the same store identity — any
 * bound components just see snapshots reset to `initial`.
 */
import { StreamStore } from "./store.js";
import type {
  AcquiredProjection,
  ProjectionRuntime,
  ProjectionSpec,
  RootEventBus,
  ThreadStream,
} from "./types.js";

interface Entry {
  readonly key: string;
  readonly store: StreamStore<unknown>;
  readonly initial: unknown;
  readonly open: ProjectionSpec<unknown>["open"];
  refCount: number;
  runtime: ProjectionRuntime | undefined;
}

export class ChannelRegistry {
  #thread: ThreadStream | undefined;
  readonly #rootBus: RootEventBus;
  readonly #entries = new Map<string, Entry>();

  constructor(rootBus: RootEventBus) {
    this.#rootBus = rootBus;
  }

  /**
   * Rebind every live entry to a new {@link ThreadStream} (or
   * detach when `thread == null`). Each entry's store is reset to
   * its `initial` value so consumers see a clean slate on
   * thread switch.
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

  /** Current bound thread (may be `undefined` pre-mount). */
  get thread(): ThreadStream | undefined {
    return this.#thread;
  }

  /**
   * Acquire a ref-counted projection. Safe to call from any
   * framework lifecycle hook; the returned `store` is stable across
   * calls for the same `spec.key`, so `useSyncExternalStore` /
   * `watchEffect` / `effect` sees a consistent source.
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

  /** Tear everything down. Safe to call multiple times. */
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

  /** Diagnostic only — used by tests to assert no leaks. */
  get size(): number {
    return this.#entries.size;
  }
}

async function tryDispose(runtime: ProjectionRuntime): Promise<void> {
  try {
    await runtime.dispose();
  } catch {
    // Best-effort — dispose should never throw, but we don't want a
    // bad projection to wedge the registry.
  }
}
