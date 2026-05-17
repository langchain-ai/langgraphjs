/**
 * Drives the {@link RootSnapshot.isLoading} flag from root lifecycle
 * events.
 *
 * # What it does
 *
 * The tracker watches a stream of protocol events and flips the
 * `isLoading` slot of a {@link StreamStore} based on root-namespace
 * `lifecycle` payloads:
 *
 *   - `running`                       → `isLoading = true`
 *   - `completed` / `failed` / `interrupted` / `cancelled`
 *                                     → `isLoading = false`
 *
 * Non-root, non-lifecycle, and unknown events are ignored.
 *
 * # Why it lives in its own class
 *
 * Lifecycle handling has two subtleties that we want to keep out of
 * the {@link StreamController}'s critical path:
 *
 *   1. **Stale `running` filtering.** SSE replays older events on
 *      reconnect — including a `running` lifecycle that fired before
 *      the run terminated. Without filtering, that replay would flip
 *      `isLoading` back to `true` after a `completed` already brought
 *      it down. We track the highest terminal `seq` we've seen and
 *      drop any `running` whose `seq` is at or below it.
 *   2. **Deferred terminal flip.** The flip from `true → false` is
 *      pushed to the next macrotask (`setTimeout(..., 0)`). This
 *      gives synchronous consumers — most notably `for await`
 *      iterators in framework bindings — one event-loop tick to
 *      observe terminal-related state (e.g. the final assistant
 *      message landing in `values`) before `isLoading` settles.
 *
 * # Why it's safe to register the listener as `controller.onEvent`
 *
 * The tracker subscribes to the controller's root event bus via the
 * exported {@link listener} arrow. Because the listener is bound at
 * construction time, removing it later (`bus.delete(tracker.listener)`)
 * works without `bind()` gymnastics in the controller.
 *
 * @typeParam T - The snapshot shape; must contain an `isLoading` flag.
 */
import type { Event, LifecycleEvent } from "@langchain/protocol";
import { StreamStore } from "./store.js";
import { isRootNamespace } from "./namespace.js";

/**
 * Minimal contract the snapshot must satisfy. The tracker only
 * touches `isLoading`, leaving everything else for the controller.
 */
type LoadingSnapshot = { readonly isLoading: boolean };

/**
 * Drives root-snapshot `isLoading` from root lifecycle events.
 */
export class LifecycleLoadingTracker<T extends LoadingSnapshot> {
  /** Snapshot store whose `isLoading` slot we manage. */
  readonly #store: StreamStore<T>;

  /**
   * Disposal probe. Consulted from the deferred `setTimeout` so a
   * controller torn down between scheduling and firing doesn't end
   * up writing to a defunct store.
   */
  readonly #isDisposed: () => boolean;

  /**
   * Highest sequence number of a terminal lifecycle we've observed.
   * `running` events at or below this seq are stale replays and
   * are dropped to avoid flipping the loading flag back on after the
   * run has already ended.
   */
  #lastTerminalLifecycleSeq = -1;

  /**
   * @param params.store      - Store whose `isLoading` slot we drive.
   * @param params.isDisposed - Disposal probe consulted from deferred callbacks.
   */
  constructor(params: { store: StreamStore<T>; isDisposed: () => boolean }) {
    this.#store = params.store;
    this.#isDisposed = params.isDisposed;
  }

  /**
   * Bound listener suitable for `EventBus.subscribe`. Re-exposed as a
   * stable property so the controller can later remove the same
   * function reference from the bus on teardown.
   */
  readonly listener = (event: Event): void => {
    this.handle(event);
  };

  /**
   * Reset internal state when rebinding to a new thread.
   *
   * The terminal-seq guard is per-thread: a new thread's `running`
   * events are not stale relative to the old thread's terminals.
   */
  reset(): void {
    this.#lastTerminalLifecycleSeq = -1;
  }

  /**
   * Process a single protocol event.
   *
   * Filters down to root-namespace lifecycle events, then mutates the
   * store's `isLoading` slot. All other events are ignored.
   *
   * @param event - Any protocol event from the controller's root bus.
   */
  handle(event: Event): void {
    if (event.method !== "lifecycle") return;
    if (!isRootNamespace(event.params.namespace)) return;
    const lifecycle = (event as LifecycleEvent).params.data as {
      event?: string;
    };
    const seq = typeof event.seq === "number" ? event.seq : undefined;
    if (lifecycle?.event === "running") {
      // Drop stale `running` replays that arrive *after* a terminal
      // for the same run. SSE re-streams history on reconnect; without
      // this filter the loading flag would oscillate.
      if (seq != null && seq <= this.#lastTerminalLifecycleSeq) {
        return;
      }
      this.#store.setState((s) =>
        s.isLoading ? s : { ...s, isLoading: true }
      );
      return;
    }
    if (
      lifecycle?.event === "completed" ||
      lifecycle?.event === "failed" ||
      lifecycle?.event === "interrupted" ||
      lifecycle?.event === "cancelled"
    ) {
      if (seq != null) {
        this.#lastTerminalLifecycleSeq = Math.max(
          this.#lastTerminalLifecycleSeq,
          seq
        );
      }
      // Flip `isLoading=false` on the next macrotask so synchronous
      // consumers iterating events get one tick to observe terminal
      // state (the final values snapshot etc.) before the loading
      // indicator drops.
      setTimeout(() => {
        if (this.#isDisposed()) return;
        this.#store.setState((s) =>
          s.isLoading ? { ...s, isLoading: false } : s
        );
      }, 0);
    }
  }
}
