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
 *   - `completed` / `failed` / `interrupted`
 *                                     → `isLoading = false`
 *
 * Non-root, non-lifecycle, and unknown events are ignored.
 *
 * # Why it lives in its own class
 *
 * Lifecycle handling has two subtleties that we want to keep out of
 * the {@link StreamController}'s critical path:
 *
 *   1. **Stale replay filtering.** SSE replays older events on
 *      reconnect — including a `running` lifecycle that fired before
 *      the run terminated. Without filtering, that replay would flip
 *      `isLoading` back to `true` after a `completed` already brought
 *      it down. When an event's id names its run, we drop the events
 *      of runs that already ended. Otherwise we track the highest
 *      terminal `seq` we've seen and drop any event whose `seq` is at
 *      or below it. This also drops the second copy of a terminal,
 *      which both the lifecycle watcher and the content pump deliver.
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
import { StreamStore } from "../ui/store.js";
import { isRootNamespace } from "../ui/namespace.js";

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
   * Events at or below this seq are stale replays and are dropped to
   * avoid flipping the loading flag back on after the run has already
   * ended.
   */
  #lastTerminalLifecycleSeq = -1;

  /**
   * Runs whose terminal we applied. Their seqs can't mark a replay
   * stale: the agent server numbers each connection's events from 1.
   */
  readonly #endedRunIds = new Set<string>();

  #handled = 0;

  /** Notified once `isLoading` actually settles to `false` on a terminal event. */
  readonly #onSettled: (() => void) | undefined;

  readonly #ignore: ((event: Event) => boolean) | undefined;

  readonly #runId: ((event: Event) => string | undefined) | undefined;

  /**
   * @param params.store      - Store whose `isLoading` slot we drive.
   * @param params.isDisposed - Disposal probe consulted from deferred callbacks.
   * @param params.onSettled  - Called once `isLoading` flips to `false`,
   *   including for a run this client only observed and never
   *   dispatched itself.
   * @param params.ignore     - Lifecycle events to skip, e.g. another run's
   *   replayed terminal while this client's own run is in flight.
   * @param params.runId      - The run an event belongs to, when its id
   *   names one.
   */
  constructor(params: {
    store: StreamStore<T>;
    isDisposed: () => boolean;
    onSettled?: () => void;
    ignore?: (event: Event) => boolean;
    runId?: (event: Event) => string | undefined;
  }) {
    this.#store = params.store;
    this.#isDisposed = params.isDisposed;
    this.#onSettled = params.onSettled;
    this.#ignore = params.ignore;
    this.#runId = params.runId;
  }

  /**
   * Bound listener suitable for `EventBus.subscribe`. Re-exposed as a
   * stable property so the controller can later remove the same
   * function reference from the bus on teardown.
   */
  readonly listener = (event: Event): void => {
    this.handle(event);
  };

  /** Root lifecycle events applied so far. */
  get handled(): number {
    return this.#handled;
  }

  /**
   * Reset internal state when rebinding to a new thread.
   *
   * The stale guards are per-thread: a new thread's lifecycle events
   * are not stale relative to the old thread's.
   */
  reset(): void {
    this.#lastTerminalLifecycleSeq = -1;
    this.#endedRunIds.clear();
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
    if (this.#ignore?.(event)) return;
    const lifecycle = (event as LifecycleEvent).params.data as {
      event?: string;
    };
    const seq = typeof event.seq === "number" ? event.seq : undefined;
    const runId = this.#runId?.(event);
    // Drop events of a run that already ended. SSE re-streams history on
    // reconnect, and without this filter the loading flag would oscillate.
    if (
      runId != null
        ? this.#endedRunIds.has(runId)
        : seq != null && seq <= this.#lastTerminalLifecycleSeq
    ) {
      return;
    }
    if (lifecycle?.event === "running") {
      this.#handled += 1;
      this.#store.setState((s) =>
        s.isLoading ? s : { ...s, isLoading: true }
      );
      return;
    }
    if (
      lifecycle?.event === "completed" ||
      lifecycle?.event === "failed" ||
      lifecycle?.event === "interrupted"
    ) {
      if (runId != null) {
        this.#endedRunIds.add(runId);
      } else if (seq != null) {
        this.#lastTerminalLifecycleSeq = seq;
      }
      const handled = ++this.#handled;
      // Flip `isLoading=false` on the next macrotask so synchronous
      // consumers iterating events get one tick to observe terminal
      // state (the final values snapshot etc.) before the loading
      // indicator drops. Bail if a newer `running` arrived since this
      // terminal was scheduled (answered HITL interrupt, back-to-back
      // runs, or history replay of interrupted → running), or a newer
      // terminal whose own reset will settle the flag.
      setTimeout(() => {
        if (this.#isDisposed()) return;
        if (this.#handled > handled) return;
        const wasLoading = this.#store.getSnapshot().isLoading;
        this.#store.setState((s) =>
          s.isLoading ? { ...s, isLoading: false } : s
        );
        if (wasLoading) this.#onSettled?.();
      }, 0);
    }
  }
}
