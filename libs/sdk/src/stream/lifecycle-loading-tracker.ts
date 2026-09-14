/**
 * Drives the {@link RootSnapshot.isLoading} and
 * {@link RootSnapshot.isRunning} flags from root lifecycle events.
 *
 * # What it does
 *
 * The tracker watches a stream of protocol events and flips the
 * `isLoading` / `isRunning` slots of a {@link StreamStore} based on
 * root-namespace `lifecycle` payloads:
 *
 *   - `running`                       → `isLoading = isRunning = true`
 *   - `completed` / `failed` / `interrupted`
 *                                     → `isLoading = isRunning = false`
 *
 * `isRunning` marks that the run has begun running; combined with the
 * optimistic `isLoading` set on submit it lets
 * {@link deriveStreamStatus} tell "submitting" from "streaming".
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
 *      The deferred callback re-checks whether a newer `running`
 *      arrived in the meantime (HITL interrupt → resume, or SSE
 *      history replay of interrupted → running) and bails if so,
 *      so a stale terminal reset cannot stomp an active run.
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
type LoadingSnapshot = {
  readonly isLoading: boolean;
  readonly isRunning: boolean;
};

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
   * Highest sequence number of a `running` lifecycle we've observed.
   * Deferred terminal resets compare against this so an
   * `interrupted`/`completed`/`failed` whose macrotask fires after a
   * newer `running` does not incorrectly clear `isLoading`.
   */
  #lastRunningLifecycleSeq = -1;

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
   * The seq guards are per-thread: a new thread's lifecycle events
   * are not stale relative to the old thread's.
   */
  reset(): void {
    this.#lastTerminalLifecycleSeq = -1;
    this.#lastRunningLifecycleSeq = -1;
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
      if (seq != null) {
        this.#lastRunningLifecycleSeq = Math.max(
          this.#lastRunningLifecycleSeq,
          seq
        );
      }
      this.#store.setState((s) =>
        s.isLoading && s.isRunning
          ? s
          : { ...s, isLoading: true, isRunning: true }
      );
      return;
    }
    if (
      lifecycle?.event === "completed" ||
      lifecycle?.event === "failed" ||
      lifecycle?.event === "interrupted"
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
      // indicator drops. Bail if a newer `running` arrived since this
      // terminal was scheduled (answered HITL interrupt, back-to-back
      // runs, or history replay of interrupted → running).
      setTimeout(() => {
        if (this.#isDisposed()) return;
        if (seq != null && this.#lastRunningLifecycleSeq > seq) return;
        this.#store.setState((s) =>
          s.isLoading || s.isRunning
            ? { ...s, isLoading: false, isRunning: false }
            : s
        );
      }, 0);
    }
  }
}
