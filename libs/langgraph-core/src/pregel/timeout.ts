import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { PendingWrite } from "@langchain/langgraph-checkpoint";
import { CONFIG_KEY_CALL, CONFIG_KEY_SEND } from "../constants.js";
import { NodeTimeoutError } from "../errors.js";
import { LangGraphRunnableConfig } from "./runnable_types.js";
import { PregelExecutableTask } from "./types.js";
import {
  combineAbortSignals,
  patchConfigurable,
  TimeoutPolicy,
} from "./utils/index.js";

/**
 * Tracks the live progress state of a single timed node attempt.
 *
 * The scope guards observable-progress channels (writes, child-task
 * scheduling, the custom stream writer, callbacks) so that:
 *
 * 1. `idleTimeout` is refreshed whenever the node makes progress, and
 * 2. once the attempt is `close()`d after a timeout fires, late writes/calls
 *    from the still-running background task are dropped (Python parity:
 *    buffered writes from the failed attempt must not leak into the
 *    checkpoint).
 *
 * @internal
 */
class TimedAttemptScope {
  active = true;

  lastProgress = Date.now();

  private refreshOn: "auto" | "heartbeat";

  constructor(refreshOn: "auto" | "heartbeat") {
    this.refreshOn = refreshOn;
  }

  /** Record progress now. Always honored (used by `runtime.heartbeat()`). */
  touch(): void {
    this.lastProgress = Date.now();
  }

  /**
   * Record progress for an automatic signal (write/call/stream/callback).
   * No-op when `refreshOn === "heartbeat"`, where only explicit heartbeats
   * count as progress.
   */
  autoTouch(): void {
    if (this.refreshOn === "auto") {
      this.lastProgress = Date.now();
    }
  }

  close(): void {
    this.active = false;
  }
}

/**
 * Callback handler that refreshes a {@link TimedAttemptScope} on any LangChain
 * callback event emitted under the node's run. Because it is attached via
 * `config.callbacks`, it only observes events from runs descended from this
 * node's attempt, not from sibling nodes.
 *
 * @internal
 */
class IdleProgressCallbackHandler extends BaseCallbackHandler {
  name = "IdleProgressCallbackHandler";

  awaitHandlers = false;

  #scope: TimedAttemptScope;

  constructor(scope: TimedAttemptScope) {
    super();
    this.#scope = scope;
  }

  #touch = () => {
    this.#scope.autoTouch();
  };

  handleLLMStart = this.#touch;

  handleChatModelStart = this.#touch;

  handleLLMNewToken = this.#touch;

  handleLLMEnd = this.#touch;

  handleLLMError = this.#touch;

  handleChainStart = this.#touch;

  handleChainEnd = this.#touch;

  handleChainError = this.#touch;

  handleToolStart = this.#touch;

  handleToolEnd = this.#touch;

  handleToolError = this.#touch;

  handleText = this.#touch;

  handleRetrieverStart = this.#touch;

  handleRetrieverEnd = this.#touch;

  handleRetrieverError = this.#touch;

  handleCustomEvent = this.#touch;
}

/**
 * Wrap the node attempt config so observable-progress signals refresh the idle
 * clock and are dropped once the scope is closed. Also injects
 * {@link LangGraphRunnableConfig.heartbeat}.
 */
function wrapConfig(
  config: LangGraphRunnableConfig,
  scope: TimedAttemptScope,
  policy: TimeoutPolicy,
  taskName: string
): LangGraphRunnableConfig {
  const configurable = config.configurable ?? {};
  const patch: Record<string, unknown> = {};

  const send = configurable[CONFIG_KEY_SEND];
  if (typeof send === "function") {
    patch[CONFIG_KEY_SEND] = (writes: PendingWrite[]) => {
      if (!scope.active) return undefined;
      if (writes && writes.length) scope.autoTouch();
      return send(writes);
    };
  }

  const callFn = configurable[CONFIG_KEY_CALL];
  if (typeof callFn === "function") {
    patch[CONFIG_KEY_CALL] = (...args: unknown[]) => {
      if (!scope.active) {
        throw new Error(
          `Node "${taskName}" attempt was cancelled after its timeout fired`
        );
      }
      scope.autoTouch();
      return (callFn as (...a: unknown[]) => unknown)(...args);
    };
  }

  const out: LangGraphRunnableConfig =
    Object.keys(patch).length > 0 ? patchConfigurable(config, patch) : config;
  const wrapped: LangGraphRunnableConfig = { ...out };

  // `heartbeat` always resets the idle clock, even under `refreshOn:
  // "heartbeat"`. It is a no-op when no idle timeout is configured.
  wrapped.heartbeat = () => {
    if (policy.idleTimeout !== undefined) scope.touch();
  };

  if (typeof wrapped.writer === "function") {
    const writer = wrapped.writer;
    wrapped.writer = ((chunk: unknown) => {
      if (!scope.active) return undefined;
      scope.autoTouch();
      return (writer as (c: unknown) => unknown)(chunk);
    }) as typeof wrapped.writer;
  }

  if (
    (policy.refreshOn ?? "auto") === "auto" &&
    policy.idleTimeout !== undefined
  ) {
    const handler = new IdleProgressCallbackHandler(scope);
    const cb = wrapped.callbacks;
    if (cb === undefined) {
      wrapped.callbacks = [handler];
    } else if (Array.isArray(cb)) {
      wrapped.callbacks = [...cb, handler];
    } else {
      const copied = cb.copy();
      copied.addHandler(handler, true);
      wrapped.callbacks = copied;
    }
  }

  return wrapped;
}

type AttemptOutcome<T> =
  | { type: "ok"; value: T }
  | { type: "err"; error: unknown }
  | { type: "timeout"; kind: "run" | "idle" };

/**
 * Run a single node attempt under a {@link TimeoutPolicy}.
 *
 * Races the node invocation against per-attempt run/idle watchdogs. On
 * successful completion (or node error), returns/rethrows normally. When a
 * watchdog fires first, the scope is closed, the task's buffered writes are
 * dropped, the attempt's {@link AbortSignal} is aborted, and a
 * {@link NodeTimeoutError} is thrown.
 *
 * @internal
 */
export async function runAttemptWithTimeout<T>(
  task: PregelExecutableTask<string, string>,
  config: LangGraphRunnableConfig,
  policy: TimeoutPolicy,
  invoke: (scopedConfig: LangGraphRunnableConfig) => Promise<T>
): Promise<T> {
  const refreshOn = policy.refreshOn ?? "auto";
  const scope = new TimedAttemptScope(refreshOn);

  const timeoutController = new AbortController();
  const { signal: composedSignal, dispose } = combineAbortSignals(
    config.signal,
    timeoutController.signal
  );

  const scopedConfig = wrapConfig(
    { ...config, signal: composedSignal },
    scope,
    policy,
    String(task.name)
  );

  const start = Date.now();
  const bg = invoke(scopedConfig);

  // Normalize the node result into an outcome. Catching the rejection here
  // (rather than via a separate `bg.catch`) keeps `bg` handled even when a
  // watchdog wins the race below, so its late settlement can never surface as
  // an unhandled rejection.
  const nodeOutcome: Promise<AttemptOutcome<T>> = bg.then(
    (value) => ({ type: "ok", value }),
    (error) => ({ type: "err", error })
  );

  let runTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    if (runTimer !== undefined) clearTimeout(runTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  };

  // The watchdog never rejects: it either resolves with a timeout outcome or
  // stays pending forever (and is dropped) when the node wins the race. The
  // idle timer re-arms itself off `scope.lastProgress`, so it can't be a single
  // fixed `setTimeout`.
  const watchdog = new Promise<AttemptOutcome<T>>((resolve) => {
    if (policy.runTimeout !== undefined) {
      runTimer = setTimeout(
        () => resolve({ type: "timeout", kind: "run" }),
        policy.runTimeout
      );
    }

    if (policy.idleTimeout !== undefined) {
      const idleMs = policy.idleTimeout;
      const checkIdle = () => {
        const remaining = scope.lastProgress + idleMs - Date.now();
        if (remaining <= 0) {
          resolve({ type: "timeout", kind: "idle" });
        } else {
          idleTimer = setTimeout(checkIdle, remaining);
        }
      };
      idleTimer = setTimeout(checkIdle, idleMs);
    }
  });

  let outcome: AttemptOutcome<T>;
  try {
    outcome = await Promise.race([nodeOutcome, watchdog]);
  } finally {
    clearTimers();
  }

  // Watchdog timers are macrotasks and cannot fire while a synchronous
  // (CPU-bound) node blocks the event loop. Such a node — or one with a long
  // synchronous prefix — can therefore settle the race as "ok"/"err" before an
  // already-expired timer ever runs, bypassing the documented hard wall-clock
  // cap. Re-check the budget against wall-clock time here so the caps hold for
  // synchronous nodes too. (For genuinely async work the watchdog already
  // wins the race, so this only catches what timers structurally cannot.)
  if (outcome.type !== "timeout") {
    const now = Date.now();
    if (policy.runTimeout !== undefined && now - start >= policy.runTimeout) {
      outcome = { type: "timeout", kind: "run" };
    } else if (
      policy.idleTimeout !== undefined &&
      now - scope.lastProgress >= policy.idleTimeout
    ) {
      outcome = { type: "timeout", kind: "idle" };
    }
  }

  if (outcome.type === "ok") {
    dispose?.();
    return outcome.value;
  }
  if (outcome.type === "err") {
    dispose?.();
    throw outcome.error;
  }

  // A watchdog fired: close the scope (drop late writes/calls), discard the
  // attempt's buffered writes, abort the node, and surface a NodeTimeoutError.
  const elapsed = Date.now() - start;
  scope.close();
  task.writes.splice(0, task.writes.length);
  // Abort BEFORE disposing the combined signal so the abort actually
  // propagates to the node's signal (dispose removes the relay listeners).
  timeoutController.abort();
  dispose?.();

  throw new NodeTimeoutError({
    node: String(task.name),
    elapsed,
    kind: outcome.kind,
    runTimeout: policy.runTimeout,
    idleTimeout: policy.idleTimeout,
  });
}
