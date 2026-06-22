/**
 * Owns the run-submission lifecycle for a single
 * {@link StreamController}.
 *
 * # What this module is
 *
 * The {@link SubmitCoordinator} is the piece of the controller that
 * dispatches runs (`submit()`), enforces multitask strategies, queues
 * deferred submissions, races dispatch against terminal lifecycle
 * events, and surfaces errors back through the per-submit `onError`
 * callback and the root snapshot.
 *
 * Conceptually a submit looks like:
 *
 *   1. Optionally rebind to a different thread (`options.threadId`).
 *   2. Mint a thread id if one isn't bound yet.
 *   3. Wait for the controller's root pump to be ready (so the
 *      transport is subscribed before the run is dispatched —
 *      otherwise we could miss replayed events).
 *   4. Apply the {@link StreamSubmitOptions.multitaskStrategy} to
 *      decide whether to abort, enqueue, reject, or proceed.
 *   5. Race the dispatch promise (`thread.submitRun()`) against the next root
 *      terminal lifecycle event.
 *   6. Settle the resulting state (loading flag, error slot) and
 *      drain the next queued submission, if any.
 *
 * # Why it lives in its own class
 *
 * The submit lifecycle is the most state-heavy part of the
 * controller — six promises, an abort controller, a queue, a
 * terminal-vs-command race, and bidirectional callback wiring with
 * the controller. Splitting it out keeps `controller.ts` focused on
 * subscription / projection wiring while letting the submit logic
 * evolve independently.
 *
 * # Why we race "command" against "terminal"
 *
 * For fast runs, the server's terminal lifecycle event can arrive
 * *before* the dispatch HTTP response has resolved. Racing the two
 * lets us detect terminal early and not block waiting for a now-stale
 * dispatch response. The dispatch response is still consumed (via
 * `.then(notifyCreated).catch(reportError)`) so `onCreated` still
 * fires and dispatch errors still surface through `onError`.
 *
 * # Queue semantics (`multitaskStrategy: "enqueue"`)
 *
 * When a run is already in flight, an `"enqueue"` submit is recorded
 * into {@link queueStore} and the call returns immediately. After the
 * active run terminates, `#drainQueue` schedules the head of the
 * queue as a fresh submit on the next macrotask. Each drained
 * submission has its own `multitaskStrategy` cleared so it doesn't
 * recursively re-enqueue.
 *
 * @see StreamController - The owner; injects every collaborator dep.
 */
import { v7 as uuidv7 } from "@langchain/core/utils/uuid";
import type { ThreadStream } from "../client/stream/index.js";
import { StreamStore } from "./store.js";
import type { OptimisticHandle } from "./optimistic-input.js";
import type {
  RootSnapshot,
  RunExecutionReason,
  StreamControllerOptions,
  StreamSubmitOptions,
} from "./types.js";

/**
 * Result of awaiting the next root terminal lifecycle event. Mirrors
 * the three terminal lifecycle states the protocol surfaces, plus a
 * synthetic `"aborted"` for client-side cancellation.
 */
type TerminalResult = {
  event: "completed" | "failed" | "interrupted" | "aborted";
  error?: string;
};

function terminalReason(event: TerminalResult["event"]): RunExecutionReason {
  if (event === "completed") return "success";
  if (event === "failed") return "error";
  if (event === "interrupted") return "interrupt";
  return "stopped";
}

/**
 * Queued submission entry mirrored from the server-side run queue.
 *
 * Surfaces the deferred submission to UI consumers via
 * {@link StreamController.queueStore}.
 */
export interface SubmissionQueueEntry<
  StateType extends object = Record<string, unknown>,
> {
  /** Stable id minted on enqueue (uuidv7 — sortable by creation time). */
  readonly id: string;
  /** Original submit input, narrowed to the partial state shape. */
  readonly values: Partial<StateType> | null | undefined;
  /** Original submit options, minus the strategy slot which is reset on drain. */
  readonly options?: StreamSubmitOptions<StateType>;
  /** Wall-clock timestamp at enqueue. */
  readonly createdAt: Date;
}

/**
 * Read-only snapshot of the queue. The queue store hands this out
 * directly; consumers must not mutate the array.
 */
export type SubmissionQueueSnapshot<
  StateType extends object = Record<string, unknown>,
> = ReadonlyArray<SubmissionQueueEntry<StateType>>;

/**
 * Frozen empty queue value used as the initial / cleared snapshot.
 *
 * Reusing one frozen reference keeps store identity stable across
 * empty resets, so React's `useSyncExternalStore` doesn't think the
 * queue changed when it actually didn't.
 */
export const EMPTY_QUEUE: SubmissionQueueSnapshot<never> = Object.freeze([]);

/**
 * Coordinates one controller's run-submission lifecycle.
 *
 * The constructor takes a bag of callbacks rather than a reference to
 * the parent {@link StreamController} on purpose:
 *
 *   - It keeps the dependency surface explicit and testable — every
 *     piece of controller state the submit lifecycle touches is one
 *     of these closures.
 *   - It avoids a cyclic dependency between controller and coordinator.
 *   - Tests can construct one with stub callbacks and assert behavior
 *     without mocking the entire controller.
 *
 * @typeParam StateType         - Root state shape.
 * @typeParam InterruptType     - Root interrupt payload shape.
 * @typeParam ConfigurableType  - `config.configurable` shape accepted
 *   by submit (usually `Record<string, unknown>`).
 */
export class SubmitCoordinator<
  StateType extends object = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> {
  /** Controller-level options forwarded into `submitRun` / callbacks. */
  readonly #options: StreamControllerOptions<StateType>;
  /** Root snapshot store; written for `isLoading`, `error`, `interrupts`. */
  readonly #rootStore: StreamStore<RootSnapshot<StateType, InterruptType>>;
  /** Pending submissions awaiting the active run to terminate. */
  readonly #queueStore: StreamStore<SubmissionQueueSnapshot<StateType>>;
  /** Probes the controller's `disposed` flag from deferred work. */
  readonly #getDisposed: () => boolean;
  /** Reads the controller's currently-bound thread id. */
  readonly #getCurrentThreadId: () => string | null;
  /** Updates the controller's thread id (used when minting a new id). */
  readonly #setCurrentThreadId: (threadId: string | null) => void;
  /** Records a thread id we created client-side so hydrate can skip a 404 round-trip. */
  readonly #rememberSelfCreatedThreadId: (threadId: string) => void;
  /** Drops a thread id from the self-created set once it's committed server-side. */
  readonly #forgetSelfCreatedThreadId: (threadId: string) => void;
  /** Triggers a hydrate on the controller (used by `options.threadId` rebinds). */
  readonly #hydrate: (threadId?: string | null) => Promise<void>;
  /** Lazily creates / returns the active {@link ThreadStream}. */
  readonly #ensureThread: (
    threadId: string,
    deferRootPump?: boolean
  ) => ThreadStream;
  /** Starts the previously-deferred root pump after a self-created thread commits. */
  readonly #startDeferredRootPump: () => void;
  /** Abandons a deferred root pump after a self-created dispatch fails. */
  readonly #abandonDeferredRootPump: () => void;
  /** Resolves once the controller's root subscription pump is up. */
  readonly #waitForRootPumpReady: () => Promise<void> | undefined;
  /** Resolves on the next root terminal lifecycle (or on abort). */
  readonly #awaitNextTerminal: (signal: AbortSignal) => Promise<TerminalResult>;
  /**
   * Resolves on the resumed run's terminal, skipping stale `interrupted`
   * events from the run being resumed (see {@link dispatchResume}).
   */
  readonly #awaitResumedRunTerminal: (
    signal: AbortSignal
  ) => Promise<TerminalResult>;
  /** Called once at the start of every {@link submit} invocation. */
  readonly #onSubmitStart: () => void;
  /** Marks that a local run dispatch is now active. */
  readonly #onRunStart: () => void;
  /** Records a server-accepted local run id and fires `onCreated`. */
  readonly #onRunCreated: (runId: string) => void;
  /** Fires `onCompleted` for the local run lifecycle. */
  readonly #onRunCompleted: (
    reason: RunExecutionReason,
    runId?: string
  ) => void;
  /** Marks the local run dispatch lifecycle as settled. */
  readonly #onRunEnd: () => void;
  /**
   * Apply a submit input optimistically before dispatch. Returns the
   * id-injected payload to dispatch plus a handle for terminal
   * reconciliation, or `undefined` when optimistic UI is disabled / no
   * echo applies (dispatch the raw input).
   */
  readonly #beginOptimistic: (
    input: unknown
  ) => { dispatchInput: unknown; handle: OptimisticHandle } | undefined;
  /** Reconcile optimistic state when a run terminates. */
  readonly #settleOptimistic: (
    handle: OptimisticHandle,
    event: TerminalResult["event"]
  ) => void;

  /**
   * Active submission's abort controller. `undefined` between submits.
   *
   * Used both for `multitaskStrategy: "rollback"` (abort the previous
   * controller's signal) and `stop()` (abort the current one without
   * starting a new one).
   */
  #runAbort: AbortController | undefined;

  constructor(params: {
    options: StreamControllerOptions<StateType>;
    rootStore: StreamStore<RootSnapshot<StateType, InterruptType>>;
    queueStore: StreamStore<SubmissionQueueSnapshot<StateType>>;
    getDisposed: () => boolean;
    getCurrentThreadId: () => string | null;
    setCurrentThreadId: (threadId: string | null) => void;
    rememberSelfCreatedThreadId: (threadId: string) => void;
    forgetSelfCreatedThreadId: (threadId: string) => void;
    hydrate: (threadId?: string | null) => Promise<void>;
    ensureThread: (threadId: string, deferRootPump?: boolean) => ThreadStream;
    startDeferredRootPump: () => void;
    abandonDeferredRootPump: () => void;
    waitForRootPumpReady: () => Promise<void> | undefined;
    awaitNextTerminal: (signal: AbortSignal) => Promise<TerminalResult>;
    awaitResumedRunTerminal: (signal: AbortSignal) => Promise<TerminalResult>;
    onSubmitStart?: () => void;
    onRunStart?: () => void;
    onRunCreated?: (runId: string) => void;
    onRunCompleted?: (reason: RunExecutionReason, runId?: string) => void;
    onRunEnd?: () => void;
    beginOptimistic?: (
      input: unknown
    ) => { dispatchInput: unknown; handle: OptimisticHandle } | undefined;
    settleOptimistic?: (
      handle: OptimisticHandle,
      event: TerminalResult["event"]
    ) => void;
  }) {
    this.#options = params.options;
    this.#rootStore = params.rootStore;
    this.#queueStore = params.queueStore;
    this.#getDisposed = params.getDisposed;
    this.#getCurrentThreadId = params.getCurrentThreadId;
    this.#setCurrentThreadId = params.setCurrentThreadId;
    this.#rememberSelfCreatedThreadId = params.rememberSelfCreatedThreadId;
    this.#forgetSelfCreatedThreadId = params.forgetSelfCreatedThreadId;
    this.#hydrate = params.hydrate;
    this.#ensureThread = params.ensureThread;
    this.#startDeferredRootPump = params.startDeferredRootPump;
    this.#abandonDeferredRootPump = params.abandonDeferredRootPump;
    this.#waitForRootPumpReady = params.waitForRootPumpReady;
    this.#awaitNextTerminal = params.awaitNextTerminal;
    this.#awaitResumedRunTerminal = params.awaitResumedRunTerminal;
    this.#onSubmitStart = params.onSubmitStart ?? (() => undefined);
    this.#onRunStart = params.onRunStart ?? (() => undefined);
    this.#onRunCreated = params.onRunCreated ?? (() => undefined);
    this.#onRunCompleted = params.onRunCompleted ?? (() => undefined);
    this.#onRunEnd = params.onRunEnd ?? (() => undefined);
    this.#beginOptimistic = params.beginOptimistic ?? (() => undefined);
    this.#settleOptimistic = params.settleOptimistic ?? (() => undefined);
  }

  /**
   * Submit input to the active thread.
   *
   * Honours {@link StreamSubmitOptions.multitaskStrategy}:
   *
   *   - `"rollback"` (default) — aborts any in-flight run and
   *     dispatches immediately.
   *   - `"reject"`              — throws synchronously when a run is
   *     already in flight.
   *   - `"enqueue"`             — defers via {@link #enqueueSubmission};
   *     the call returns without dispatching.
   *   - `"interrupt"`           — falls through to the default path
   *
   * Errors are routed through both the per-submit `onError` callback
   * and `rootStore.error`. Aborts (controller dispose / rollback) are
   * silently dropped.
   *
   * To resume a pending interrupt, use {@link StreamController.respond}
   * instead of `submit()`.
   *
   * @param input   - Input payload for the run.
   * @param options - Per-submit options (config, metadata, callbacks,
   *   strategy, etc).
   */
  async submit(
    input: unknown,
    options?: StreamSubmitOptions<StateType, ConfigurableType>
  ): Promise<void> {
    if (this.#getDisposed()) return;
    this.#onSubmitStart();

    // Per-submit thread override: rebind first so the rest of the
    // submit operates against the new thread.
    const overrideThreadId = options?.threadId;
    if (
      overrideThreadId !== undefined &&
      overrideThreadId !== this.#getCurrentThreadId()
    ) {
      await this.#hydrate(overrideThreadId);
    }

    // Self-created thread id path: mint client-side so the controller
    // (and Suspense boundaries) get a stable id even before the run
    // is dispatched.
    const wasSelfCreated = this.#getCurrentThreadId() == null;
    if (wasSelfCreated) {
      const threadId = uuidv7();
      this.#setCurrentThreadId(threadId);
      this.#rememberSelfCreatedThreadId(threadId);
      this.#options.onThreadId?.(threadId);
      this.#rootStore.setState((s) => ({
        ...s,
        threadId,
      }));
    }

    const currentThreadId = this.#getCurrentThreadId();
    if (currentThreadId == null) return;
    // For client-self-created threads we defer the persistent root SSE
    // pump until after `submitRun` / `respondInput` commits the thread
    // server-side. Opening the pump's `subscription.subscribe` against
    // a not-yet-existent thread row produces a `404: Thread not found`
    // protocol error that strands lifecycle / messages events for the
    // first run. The deferred path starts the pump after dispatch
    // returns (see `#startDeferredRootPump` calls below).
    const thread = this.#ensureThread(currentThreadId, wasSelfCreated);
    const activeThreadId = currentThreadId;

    const strategy = options?.multitaskStrategy ?? "rollback";
    // `wasSelfCreated` short-circuit: when this submit just minted a
    // brand-new thread id (the user clicked "New Thread"), the
    // strategy check shouldn't see a run on the *previous* thread as
    // a reason to enqueue. The previous run is on a thread the user
    // navigated away from; abandoning its client-side abort tracking
    // is correct (the server-side run continues independently).
    // Without this, `enqueue` would trap the new submission and
    // `submitRun` never fires for the new thread — leaving a freshly-
    // minted thread id committed to the URL but never to the server.
    const hasActiveRun =
      !wasSelfCreated &&
      this.#runAbort != null &&
      !this.#runAbort.signal.aborted;
    if (hasActiveRun && strategy === "reject") {
      throw new Error(
        "submit() rejected: a run is already in flight and multitaskStrategy is 'reject'."
      );
    }
    if (hasActiveRun && strategy === "enqueue") {
      this.#enqueueSubmission(input, options);
      return;
    }

    // Rollback: abort the previous run before starting a new one.
    this.#runAbort?.abort();
    const abort = new AbortController();
    this.#runAbort = abort;

    // Claim the in-flight slot before awaiting the root pump so
    // concurrent `enqueue` submits in the same tick observe
    // `hasActiveRun` and land in {@link queueStore}.
    this.#rootStore.setState((s) => ({
      ...s,
      interrupts: [],
      interrupt: undefined,
      error: undefined,
      isLoading: true,
    }));

    // Declared before the try so the catch/finally can settle the
    // submit lifecycle (loading flag, abort slot, optimistic state)
    // even if optimistic preparation or the pump wait throws.
    let optimisticHandle: OptimisticHandle | undefined;
    let dispatchInput: unknown = input;
    let createdRunId: string | undefined;
    let pendingCompletionReason: RunExecutionReason | undefined;
    let completionNotified = false;
    let settleEvent: TerminalResult["event"] | undefined;
    const notifyCompletion = (reason: RunExecutionReason): void => {
      if (completionNotified) return;
      if (createdRunId == null) {
        pendingCompletionReason = reason;
        return;
      }
      completionNotified = true;
      this.#onRunCompleted(reason, createdRunId);
    };
    const reportError = (error: unknown): void => {
      if (abort.signal.aborted) return;
      this.#rootStore.setState((s) => ({ ...s, error }));
      try {
        options?.onError?.(error);
      } catch {
        /* caller-supplied callback errors must not crash the submit */
      }
    };

    try {
      // Apply the input optimistically *before* the first await so the
      // user's message (and any merged state) paints without waiting for
      // the server round-trip. Kept as the first statement in the try so
      // the synchronous paint still precedes the first `await`, while a
      // synchronous coercion failure (e.g. a malformed message entry)
      // settles the submit lifecycle through the catch/finally below —
      // exactly like a dispatch failure — instead of wedging `isLoading`
      // / `#runAbort` and stranding later enqueue/reject submits behind a
      // phantom in-flight run. Runs only on the dispatched path — an
      // `"enqueue"`d submission returns above and echoes when it drains,
      // keeping one optimistic batch bound to exactly one run lifecycle.
      // `dispatchInput` carries the minted ids the server must echo for
      // reconciliation, so the run is dispatched with it (not raw input).
      const prepared = this.#beginOptimistic(input);
      if (prepared != null) {
        optimisticHandle = prepared.handle;
        dispatchInput = prepared.dispatchInput;
      }

      // Wait for the root subscription to be live; otherwise the
      // dispatch could resolve before we're listening for events and
      // we'd miss the terminal that ends the run.
      await this.#waitForRootPumpReady();

      const boundConfig = bindThreadConfig(options?.config, currentThreadId);
      // Subscribe to the next terminal *before* dispatching so a fast
      // run's terminal can't race us.
      const terminalPromise = this.#awaitNextTerminal(abort.signal);
      this.#onRunStart();

      let terminalSettled = false;
      let terminal: TerminalResult | undefined;

      const commandPromise = thread.submitRun({
        input: dispatchInput ?? null,
        config: boundConfig,
        metadata: (options?.metadata ?? undefined) as Record<string, unknown>,
        forkFrom: options?.forkFrom,
        multitaskStrategy:
          options?.multitaskStrategy === "enqueue"
            ? "enqueue"
            : options?.multitaskStrategy,
      });
      // Start the deferred root pump *after* the dispatch HTTP
      // response lands — that's when the thread row exists server-
      // side. Doing it synchronously here would race the response
      // and the pump's `subscription.subscribe` would 404. Same
      // reason we drop the self-created flag only after dispatch:
      // future hydrates need the thread to exist before they fetch
      // state.
      //
      // Fire-and-forget: we don't want to gate Promise.race on this,
      // and `commandPromise.catch` is already handled below. A
      // dispatch failure means there's no thread to pump anyway.
      void commandPromise.then(
        () => {
          this.#startDeferredRootPump();
          this.#forgetSelfCreatedThreadId(activeThreadId);
        },
        () => {
          // Dispatch failed. Without abandoning, `#rootPumpDeferred`
          // stays armed and `selfCreatedThreadIds` still holds this
          // id — a retry submit would see `wasSelfCreated=false`
          // (currentThreadId is no longer null), `#ensureThread`
          // would early-return because `#thread != null`, and the
          // root pump would never start. Tear down so the next
          // submit re-runs `#ensureThread` from scratch.
          if (wasSelfCreated) {
            this.#abandonDeferredRootPump();
            this.#forgetSelfCreatedThreadId(activeThreadId);
          }
        }
      );
      const notifyCreated = (result: { run_id?: unknown }) => {
        if (typeof result.run_id !== "string") return;
        createdRunId = result.run_id;
        this.#onRunCreated(createdRunId);
        if (pendingCompletionReason != null) {
          notifyCompletion(pendingCompletionReason);
        }
      };
      const first = await Promise.race([
        terminalPromise.then((value) => ({
          type: "terminal" as const,
          value,
        })),
        commandPromise.then(
          (result) => ({ type: "command" as const, result }),
          (error) => ({ type: "error" as const, error })
        ),
      ]);
      if (first.type === "error") throw first.error;
      if (first.type === "command") {
        notifyCreated(first.result);
      } else {
        // Terminal landed first (very fast runs). Wait for the
        // dispatch response in the background so onCreated fires
        // and dispatch errors still surface.
        terminal = first.value;
        terminalSettled = true;
        void commandPromise.then(notifyCreated).catch((error) => {
          if (!terminalSettled) reportError(error);
        });
      }

      terminal ??= await terminalPromise;
      terminalSettled = true;
      settleEvent = terminal.event;
      if (terminal.event === "failed" && !abort.signal.aborted) {
        const runError = new Error(
          terminal.error ?? "Run failed with no error message"
        );
        this.#rootStore.setState((s) => ({ ...s, error: runError }));
        try {
          options?.onError?.(runError);
        } catch {
          /* caller-supplied callback errors must not crash the submit */
        }
      }
      notifyCompletion(terminalReason(terminal.event));
    } catch (error) {
      if (!abort.signal.aborted) settleEvent = "failed";
      reportError(error);
    } finally {
      // Always settle loading and clear our slot of the abort
      // controller. Schedule queue drain on the next macrotask so any
      // late state updates from this run finish flushing first.
      this.#rootStore.setState((s) => ({ ...s, isLoading: false }));
      if (this.#runAbort === abort) this.#runAbort = undefined;
      // Reconcile optimistic state: flip pending messages to sent/failed
      // and roll back un-echoed non-message keys. `aborted` covers a
      // rollback-resubmit or `stop()` cancelling this run.
      if (optimisticHandle != null) {
        this.#settleOptimistic(
          optimisticHandle,
          abort.signal.aborted ? "aborted" : (settleEvent ?? "failed")
        );
      }
      this.#onRunEnd();
      setTimeout(() => this.#drainQueue(), 0);
    }
  }

  /**
   * Surface a *resumed* run's failure the same way {@link submit} surfaces
   * a fresh run's failure — by writing it to the reactive
   * {@link RootSnapshot.error} slot.
   *
   * `respond()` / `respondAll()` dispatch their `input.respond` command on
   * the controller directly (they target a specific interrupt, so they
   * cannot go through {@link submit}, which only does `run.start`). The
   * resumed run therefore never passed through the submit lifecycle that
   * populates `rootStore.error` — only the persistent lifecycle listener
   * observed it, and that listener drives `isLoading` alone. Without this,
   * a resumed run that fails (e.g. a missing model key surfaced after the
   * user approves an interrupt) would flip `isLoading` back to `false`
   * with `error` left untouched, so `stream.error`-driven UIs (error
   * banners, API-key retry prompts) would silently miss it.
   *
   * The `dispatch` thunk is awaited, so a dispatch failure rejects the
   * caller's `respond()` *and* lands in `rootStore.error`. The resumed
   * run's terminal is watched in the **background** so the returned promise
   * still settles on dispatch — preserving the resume command's
   * resolve-on-dispatch contract (and avoiding a hang when no terminal is
   * ever emitted, e.g. in unit tests).
   *
   * Reuses the shared {@link #runAbort} slot, so `stop()`, `dispose()`, and
   * a rollback `submit()` all cancel the terminal watch (no spurious error
   * on user-initiated cancel) and treat the resumed run as the active run.
   *
   * The terminal watch uses {@link #awaitResumedRunTerminal}, which skips
   * stale `interrupted` terminals from the run being resumed (they can reach
   * the pump after `input.requested` but before `respondInput` calls
   * `#prepareForNextRun`) and only accepts a later `interrupted` once a
   * root `running` lifecycle for the resumed run has been observed.
   *
   * @param dispatch - Sends the `input.respond` command (and marks the
   *   targeted interrupt resolved). Invoked after the terminal watch is
   *   armed.
   * @param optimisticHandle - Optional handle from an optimistic `update`
   *   applied before dispatch (HITL "push card into state + resume"). Settled
   *   on the resumed run's terminal — pending messages flip to `sent` and
   *   un-echoed non-message keys roll back on failure — exactly like the
   *   `submit()` optimistic lifecycle. A dispatch failure settles it `failed`.
   */
  async dispatchResume(
    dispatch: () => Promise<void>,
    optimisticHandle?: OptimisticHandle
  ): Promise<void> {
    if (this.#getDisposed()) return;

    // Rollback any run still tracked as active (mirrors submit()), then
    // claim the in-flight slot so stop()/dispose()/a concurrent submit
    // cancels the terminal watch armed below.
    this.#runAbort?.abort();
    const abort = new AbortController();
    this.#runAbort = abort;

    // Optimistically clear a stale error from a previous run, matching
    // submit()'s reset, so the resume starts from a clean error slot.
    this.#rootStore.setState((s) =>
      s.error === undefined ? s : { ...s, error: undefined }
    );

    const reportError = (error: unknown): void => {
      if (abort.signal.aborted) return;
      this.#rootStore.setState((s) => ({ ...s, error }));
    };

    // Settle the optimistic `update` exactly once, whether the resumed run
    // terminates (success/failure/interrupt) or the dispatch itself fails.
    let optimisticSettled = false;
    const settleOptimisticOnce = (event: TerminalResult["event"]): void => {
      if (optimisticSettled || optimisticHandle == null) return;
      optimisticSettled = true;
      this.#settleOptimistic(optimisticHandle, event);
    };

    // Subscribe to the resumed run's terminal *before* dispatching so a fast
    // `failed` can't race us. Unlike `#awaitNextTerminal`, the resume watcher
    // ignores stale `interrupted` events until root `running` is seen.
    // Watched in the background — we never gate the returned promise on the
    // resumed run's terminal.
    const terminalPromise = this.#awaitResumedRunTerminal(abort.signal);
    void terminalPromise.then((terminal) => {
      if (this.#runAbort === abort) this.#runAbort = undefined;
      if (terminal.event === "failed" && !abort.signal.aborted) {
        reportError(
          new Error(terminal.error ?? "Run failed with no error message")
        );
      }
      settleOptimisticOnce(abort.signal.aborted ? "aborted" : terminal.event);
      // Drain any submission enqueued while the resumed run was active.
      setTimeout(() => this.#drainQueue(), 0);
    });

    try {
      await dispatch();
    } catch (error) {
      // The `input.respond` send itself failed, before any run started.
      reportError(error);
      settleOptimisticOnce("failed");
      if (this.#runAbort === abort) this.#runAbort = undefined;
      throw error;
    }
  }

  /**
   * Abort the current run (if any) and force `isLoading=false`.
   *
   * Client-side only — server-side cancel is handled by
   * {@link StreamController.stop} before this is invoked.
   */
  async stop(): Promise<void> {
    this.abortActiveRun();
    this.#rootStore.setState((s) => ({ ...s, isLoading: false }));
  }

  /**
   * Abort the current run without forcing the loading flag down.
   *
   * Used by {@link StreamController.dispose}: disposal already tears
   * down the root store, so flipping `isLoading` here is unnecessary
   * and would race the dispose path.
   */
  abortActiveRun(): void {
    this.#runAbort?.abort();
    this.#runAbort = undefined;
  }

  /**
   * Cancel a queued submission by id.
   *
   * @param id - Client-side queue entry id to remove.
   * @returns `true` when the entry was found and dropped, `false` otherwise.
   */
  async cancelQueued(id: string): Promise<boolean> {
    const current = this.#queueStore.getSnapshot();
    const next = current.filter((entry) => entry.id !== id);
    if (next.length === current.length) return false;
    this.#queueStore.setState(() => next);
    return true;
  }

  /**
   * Drop every queued submission. Server-side cancel arrives with A0.3.
   */
  async clearQueue(): Promise<void> {
    this.#queueStore.setState(
      () => EMPTY_QUEUE as SubmissionQueueSnapshot<StateType>
    );
  }

  /**
   * Append a submission to the queue without dispatching.
   *
   * The drained submission is later run via {@link #drainQueue} after
   * the active run terminates.
   */
  #enqueueSubmission(
    input: unknown,
    options?: StreamSubmitOptions<StateType, ConfigurableType>
  ): void {
    const entry: SubmissionQueueEntry<StateType> = {
      id: uuidv7(),
      values: (input ?? undefined) as Partial<StateType> | null | undefined,
      options: options as StreamSubmitOptions<StateType> | undefined,
      createdAt: new Date(),
    };
    this.#queueStore.setState((current) => [...current, entry]);
  }

  /**
   * Drain the head of the queue if no run is active.
   *
   * Called from the `finally` block of `submit()` on the next
   * macrotask (so the just-finished run's state flushes first).
   * Strips the strategy off the dequeued options to prevent infinite
   * re-enqueueing.
   */
  #drainQueue(): void {
    if (this.#getDisposed()) return;
    if (this.#runAbort != null && !this.#runAbort.signal.aborted) return;
    const current = this.#queueStore.getSnapshot();
    if (current.length === 0) return;
    const [next, ...rest] = current;
    this.#queueStore.setState(() => rest);
    const nextOptions: StreamSubmitOptions<StateType, ConfigurableType> = {
      ...((next.options ?? {}) as StreamSubmitOptions<
        StateType,
        ConfigurableType
      >),
      multitaskStrategy: undefined,
    };
    void this.submit(next.values, nextOptions).catch(() => {
      /* submit() already routes errors through the per-submit onError
       * hook and the root store; swallow here so a failing drain does
       * not surface as an unhandled rejection. */
    });
  }
}

/**
 * Merge `thread_id` into a user-supplied `config.configurable` blob.
 *
 * The platform expects `config.configurable.thread_id` on every run
 * dispatch; we set it last so user-supplied values can't accidentally
 * override the active thread id (which would route the run to a
 * different thread).
 */
function bindThreadConfig(
  config: unknown,
  threadId: string
): Record<string, unknown> {
  const base =
    config != null && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {};
  const configurable =
    base.configurable != null && typeof base.configurable === "object"
      ? (base.configurable as Record<string, unknown>)
      : {};
  return {
    ...base,
    configurable: {
      ...configurable,
      thread_id: threadId,
    },
  };
}
