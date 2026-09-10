/** Coordinates local dispatch and the server-backed submission queue. */
import { v7 as uuidv7 } from "@langchain/core/utils/uuid";
import type { ThreadStream } from "../client/stream/index.js";
import { ServerQueue } from "./server-queue.js";
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
  /** Stable UI id; retained when the server accepts a local submission. */
  readonly id: string;
  /** Server run id; absent while acceptance is pending. */
  readonly runId?: string;
  /** Original submit input, narrowed to the partial state shape. */
  readonly values: Partial<StateType> | null | undefined;
  /** Local submit options, or the available stored options after hydration. */
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
  /** Probes the controller's `disposed` flag from deferred work. */
  readonly #getDisposed: () => boolean;
  /** Reads the controller's currently-bound thread id. */
  readonly #getCurrentThreadId: () => string | null;
  /** Updates the controller's thread id (used when minting a new id). */
  readonly #setCurrentThreadId: (threadId: string | null) => void;
  /** Records a thread id we created client-side so hydrate can skip a 404 round-trip. */
  readonly #rememberSelfCreatedThreadId: (threadId: string) => void;
  /** True when the id is pending server-side create (minted or hydrate 404). */
  readonly #isSelfCreatedThreadId: (threadId: string) => boolean;
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
  readonly #serverQueue: ServerQueue<StateType>;
  #generation = 0;
  readonly #canClearLoading: () => boolean;

  constructor(params: {
    options: StreamControllerOptions<StateType>;
    rootStore: StreamStore<RootSnapshot<StateType, InterruptType>>;
    queueStore: StreamStore<SubmissionQueueSnapshot<StateType>>;
    getDisposed: () => boolean;
    getCurrentThreadId: () => string | null;
    setCurrentThreadId: (threadId: string | null) => void;
    rememberSelfCreatedThreadId: (threadId: string) => void;
    isSelfCreatedThreadId: (threadId: string) => boolean;
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
    canClearLoading?: () => boolean;
    beginOptimistic?: (
      input: unknown
    ) => { dispatchInput: unknown; handle: OptimisticHandle } | undefined;
    settleOptimistic?: (
      handle: OptimisticHandle,
      event: TerminalResult["event"]
    ) => void;
  }) {
    this.#options = params.options;
    this.#canClearLoading = params.canClearLoading ?? (() => true);
    this.#serverQueue = new ServerQueue(
      params.options,
      params.queueStore,
      (error) => {
        this.#rootStore.setState((state) => ({ ...state, error }));
      },
      () => {
        if (!this.#runAbort) {
          this.#rootStore.setState((state) => ({
            ...state,
            isLoading: this.#serverQueue.activeRunId != null,
          }));
        }
      }
    );
    this.#rootStore = params.rootStore;
    this.#getDisposed = params.getDisposed;
    this.#getCurrentThreadId = params.getCurrentThreadId;
    this.#setCurrentThreadId = params.setCurrentThreadId;
    this.#rememberSelfCreatedThreadId = params.rememberSelfCreatedThreadId;
    this.#isSelfCreatedThreadId = params.isSelfCreatedThreadId;
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
   *   - `"enqueue"`             — sends immediately and resolves on acceptance.
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
    // For threads that don't exist server-side yet (just minted here,
    // or an externally-minted id that hydrate marked missing via 404)
    // we defer the persistent root SSE pump until after `submitRun` /
    // `respondInput` commits the thread. Opening the pump's
    // `subscription.subscribe` against a not-yet-existent thread row
    // either 404s or — on langgraph_api's in-mem runtime — joins a
    // dead subscription that delivers 0 bytes until idle reconnect.
    // The deferred path starts the pump after dispatch returns (see
    // `#startDeferredRootPump` calls below).
    const pendingServerCreate =
      wasSelfCreated || this.#isSelfCreatedThreadId(currentThreadId);
    const thread = this.#ensureThread(currentThreadId, pendingServerCreate);
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
    if (strategy === "enqueue") {
      const generation = this.#generation;
      try {
        await this.#serverQueue.enqueue(
          currentThreadId,
          input,
          options as StreamSubmitOptions<StateType>,
          (params) => thread.submitRun(params)
        );
      } catch (error) {
        if (pendingServerCreate && generation === this.#generation) {
          this.#abandonDeferredRootPump();
        }
        throw error;
      }
      if (generation === this.#generation && !this.#getDisposed()) {
        this.#startDeferredRootPump();
        this.#forgetSelfCreatedThreadId(activeThreadId);
      }
      return;
    }

    // Only once this submit will actually dispatch a command. Enqueue /
    // reject return above so they cannot reset the in-flight run's
    // interrupt replay barrier or drop events buffered for it.
    this.#onSubmitStart();

    // Rollback: abort the previous run before starting a new one.
    this.#runAbort?.abort();
    const abort = new AbortController();
    const generation = this.#generation;
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
    let observedTerminal = false;
    const notifyCompletion = (reason: RunExecutionReason): void => {
      if (
        completionNotified ||
        generation !== this.#generation ||
        this.#getDisposed()
      )
        return;
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
      // / `#runAbort`.
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
        multitaskStrategy: options?.multitaskStrategy,
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
          if (generation !== this.#generation || this.#getDisposed()) return;
          this.#startDeferredRootPump();
          this.#forgetSelfCreatedThreadId(activeThreadId);
        },
        () => {
          // Dispatch failed. Without abandoning, `#rootPumpDeferred`
          // stays armed and `selfCreatedThreadIds` still holds this
          // id — a retry submit would see `pendingServerCreate=true`
          // again but `#ensureThread` would early-return because
          // `#thread != null`, and the root pump would never start.
          // Tear down so the next submit re-runs `#ensureThread`
          // from scratch. Keep the self-created mark so the retry
          // still defers the pump (the server row was never created).
          if (pendingServerCreate && generation === this.#generation) {
            this.#abandonDeferredRootPump();
          }
        }
      );
      const notifyCreated = (result: { run_id?: unknown }) => {
        if (
          generation !== this.#generation ||
          this.#getDisposed() ||
          typeof result.run_id !== "string"
        )
          return;
        createdRunId = result.run_id;
        this.#serverQueue.claimLocalRun(activeThreadId, createdRunId);
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
      observedTerminal = true;
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
      if (generation === this.#generation) {
        if (this.#runAbort === abort) {
          if (this.#canClearLoading() || !observedTerminal) {
            this.#rootStore.setState((s) => ({
              ...s,
              isLoading: this.#serverQueue.activeRunId != null,
            }));
          }
          this.#runAbort = undefined;
        }
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
      }
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

    // Same allowlist clear as submit(): a resumed run can pause on a
    // *new* interrupt id. Without this, the hydrate-window allowlist
    // still contains only the interrupt being answered and
    // `#recordRootInterrupt` drops the follow-on `input.requested`.
    this.#onSubmitStart();

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
    const generation = this.#generation;
    const terminalPromise = this.#awaitResumedRunTerminal(abort.signal);
    void terminalPromise.then((terminal) => {
      if (generation !== this.#generation) return;
      if (this.#runAbort === abort) this.#runAbort = undefined;
      if (terminal.event === "failed" && !abort.signal.aborted) {
        reportError(
          new Error(terminal.error ?? "Run failed with no error message")
        );
      }
      settleOptimisticOnce(abort.signal.aborted ? "aborted" : terminal.event);
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

  get queuedActiveRunId(): string | undefined {
    return this.#serverQueue.activeRunId;
  }

  async cancelRunning(): Promise<void> {
    const threadId = this.#getCurrentThreadId();
    if (threadId) await this.#serverQueue.cancelRunning(threadId);
  }

  async hydrateQueue(threadId: string): Promise<void> {
    await this.#serverQueue.refresh(threadId);
  }

  detach(): void {
    this.#generation += 1;
    this.abortActiveRun();
    this.#serverQueue.detach();
  }

  async cancelQueued(id: string): Promise<boolean> {
    return this.#serverQueue.cancel(id);
  }

  async clearQueue(): Promise<void> {
    await this.#serverQueue.clear();
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
