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
 *   5. Race the dispatch promise (`thread.submitRun()` or
 *      `thread.respondInput()` for resumes) against the next root
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
import { v7 as uuidv7 } from "uuid";
import type { ThreadStream } from "../client/stream/index.js";
import { StreamStore } from "./store.js";
import type {
  RootSnapshot,
  StreamControllerOptions,
  StreamSubmitOptions,
} from "./types.js";

/**
 * Pointer to a pending root protocol interrupt. Used to target
 * `respondInput` for resume submissions.
 */
interface ResolvedInterrupt {
  interruptId: string;
  namespace: string[];
}

/**
 * Result of awaiting the next root terminal lifecycle event. Mirrors
 * the four terminal lifecycle states the protocol surfaces, plus a
 * synthetic `"aborted"` for client-side cancellation.
 */
type TerminalResult = {
  event: "completed" | "failed" | "interrupted" | "aborted";
  error?: string;
};

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
  /** Triggers a hydrate on the controller (used by `options.threadId` rebinds). */
  readonly #hydrate: (threadId?: string | null) => Promise<void>;
  /** Lazily creates / returns the active {@link ThreadStream}. */
  readonly #ensureThread: (threadId: string) => ThreadStream;
  /** Resolves once the controller's root subscription pump is up. */
  readonly #waitForRootPumpReady: () => Promise<void> | undefined;
  /** Resolves on the next root terminal lifecycle (or on abort). */
  readonly #awaitNextTerminal: (signal: AbortSignal) => Promise<TerminalResult>;
  /** Returns the most recent unresolved root interrupt, for resumes. */
  readonly #latestUnresolvedInterrupt: () => ResolvedInterrupt | null;
  /** Marks an interrupt id as resolved so it isn't re-targeted. */
  readonly #markInterruptResolved: (interruptId: string) => void;

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
    hydrate: (threadId?: string | null) => Promise<void>;
    ensureThread: (threadId: string) => ThreadStream;
    waitForRootPumpReady: () => Promise<void> | undefined;
    awaitNextTerminal: (signal: AbortSignal) => Promise<TerminalResult>;
    latestUnresolvedInterrupt: () => ResolvedInterrupt | null;
    markInterruptResolved: (interruptId: string) => void;
  }) {
    this.#options = params.options;
    this.#rootStore = params.rootStore;
    this.#queueStore = params.queueStore;
    this.#getDisposed = params.getDisposed;
    this.#getCurrentThreadId = params.getCurrentThreadId;
    this.#setCurrentThreadId = params.setCurrentThreadId;
    this.#rememberSelfCreatedThreadId = params.rememberSelfCreatedThreadId;
    this.#hydrate = params.hydrate;
    this.#ensureThread = params.ensureThread;
    this.#waitForRootPumpReady = params.waitForRootPumpReady;
    this.#awaitNextTerminal = params.awaitNextTerminal;
    this.#latestUnresolvedInterrupt = params.latestUnresolvedInterrupt;
    this.#markInterruptResolved = params.markInterruptResolved;
  }

  /**
   * Submit input or a resume command to the active thread.
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
   *     (server-side cancellation lands with roadmap A0.3).
   *
   * Errors are routed through both the per-submit `onError` callback
   * and `rootStore.error`. Aborts (controller dispose / rollback) are
   * silently dropped.
   *
   * @param input   - Input payload, or `null`/`undefined` for no input
   *   (typical for resume commands).
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
    if (this.#getCurrentThreadId() == null) {
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
    const thread = this.#ensureThread(currentThreadId);
    const activeThreadId = currentThreadId;
    // Wait for the root subscription to be live; otherwise the
    // dispatch could resolve before we're listening for events and
    // we'd miss the terminal that ends the run.
    await this.#waitForRootPumpReady();

    const strategy = options?.multitaskStrategy ?? "rollback";
    const hasActiveRun =
      this.#runAbort != null && !this.#runAbort.signal.aborted;
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

    const resumeCommand = options?.command?.resume;
    const isResume = resumeCommand !== undefined;

    // Optimistically clear interrupts/error and flip loading. The
    // root pump's lifecycle listener will re-flip these as the run
    // terminates.
    this.#rootStore.setState((s) => ({
      ...s,
      interrupts: [],
      interrupt: undefined,
      error: undefined,
      isLoading: true,
    }));

    const boundConfig = bindThreadConfig(options?.config, currentThreadId);
    // Subscribe to the next terminal *before* dispatching so a fast
    // run's terminal can't race us.
    const terminalPromise = this.#awaitNextTerminal(abort.signal);

    let terminalSettled = false;
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
      let terminal: TerminalResult | undefined;

      if (isResume) {
        const target = this.#latestUnresolvedInterrupt();
        if (target == null) {
          throw new Error(
            "submit({ command: { resume } }) called but no pending protocol interrupt is available."
          );
        }
        const commandPromise = thread.respondInput({
          namespace: target.namespace,
          interrupt_id: target.interruptId,
          response: resumeCommand,
        });
        // Mark resolved synchronously: even if the response races and
        // the command settles after the terminal, we don't want to
        // re-target this same interrupt on the next submit.
        this.#markInterruptResolved(target.interruptId);
        const first = await Promise.race([
          terminalPromise.then((value) => ({
            type: "terminal" as const,
            value,
          })),
          commandPromise.then(
            () => ({ type: "command" as const }),
            (error) => ({ type: "error" as const, error })
          ),
        ]);
        if (first.type === "error") throw first.error;
        if (first.type === "terminal") {
          terminal = first.value;
          terminalSettled = true;
          // Stale command response — surface as error only if it
          // arrives with a real failure (not just our own abort).
          void commandPromise.catch((error) => {
            if (!terminalSettled) reportError(error);
          });
        }
      } else {
        const commandPromise = thread.submitRun({
          input: input ?? null,
          config: boundConfig,
          metadata: (options?.metadata ?? undefined) as Record<string, unknown>,
          forkFrom: options?.forkFrom,
          multitaskStrategy:
            options?.multitaskStrategy === "enqueue"
              ? "enqueue"
              : options?.multitaskStrategy,
        });
        const notifyCreated = (result: { run_id?: unknown }) => {
          this.#options.onCreated?.({
            run_id: result.run_id as string,
            thread_id: activeThreadId,
          });
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
      }

      terminal ??= await terminalPromise;
      terminalSettled = true;
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
    } catch (error) {
      reportError(error);
    } finally {
      // Always settle loading and clear our slot of the abort
      // controller. Schedule queue drain on the next macrotask so any
      // late state updates from this run finish flushing first.
      this.#rootStore.setState((s) => ({ ...s, isLoading: false }));
      if (this.#runAbort === abort) this.#runAbort = undefined;
      setTimeout(() => this.#drainQueue(), 0);
    }
  }

  /**
   * Abort the current run (if any) and force `isLoading=false`.
   *
   * Does NOT issue a server-side cancel — that lands with roadmap
   * A0.3. Today this is a client-side stop only: subsequent events
   * for the aborted run are ignored by the controller's pump because
   * the abort signal is the same one `#awaitNextTerminal` is wired
   * to.
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
