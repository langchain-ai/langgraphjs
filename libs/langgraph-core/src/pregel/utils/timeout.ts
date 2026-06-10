/**
 * Configuration for timing out node attempts.
 *
 * A timeout applies to a single attempt of a node/task. When a node has a
 * {@link RetryPolicy}, the timer resets for each retry attempt.
 *
 * Timeouts are expressed in **milliseconds**, matching other LangGraph.js
 * durations (e.g. {@link RetryPolicy} intervals and `stepTimeout`).
 *
 * @remarks
 * Cooperative cancellation: timeouts rely on aborting the node's
 * {@link AbortSignal} and dropping its buffered writes. A node that ignores its
 * `signal` and performs blocking work cannot be interrupted mid-operation, but
 * its writes are still discarded and `NodeTimeoutError` is raised.
 */
export type TimeoutPolicy = {
  /**
   * Hard wall-clock cap (in milliseconds) for a single node attempt.
   *
   * This timeout is never refreshed by progress signals or
   * `runtime.heartbeat()`.
   */
  runTimeout?: number;

  /**
   * Maximum time (in milliseconds) a single node attempt may go without
   * observable progress before timing out.
   *
   * Refreshed by writes, custom stream writer calls, child-task scheduling,
   * LangChain callback events emitted under the node's run, and explicit
   * `runtime.heartbeat()` calls (see {@link TimeoutPolicy.refreshOn}).
   */
  idleTimeout?: number;

  /**
   * Which signals refresh {@link TimeoutPolicy.idleTimeout}.
   *
   * - `"auto"` (default): refreshes on standard graph progress signals and
   *   explicit heartbeats.
   * - `"heartbeat"`: refreshes only on explicit `runtime.heartbeat()` calls.
   */
  refreshOn?: "auto" | "heartbeat";
};

function _coerceTimeoutMs(
  value: number | undefined,
  field: string
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new Error(`${field} must be greater than 0`);
  }
  return value;
}

/**
 * Normalize a timeout value into a {@link TimeoutPolicy} with positive
 * millisecond fields, or `undefined` if no timeout is configured.
 *
 * A bare number (or `undefined`) is treated as a hard {@link
 * TimeoutPolicy.runTimeout}. Throws if any configured timeout is not greater
 * than 0, or if `refreshOn` is not `"auto"` or `"heartbeat"`.
 *
 * @internal
 */
export function coerceTimeoutPolicy(
  value?: number | TimeoutPolicy
): TimeoutPolicy | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const policy: TimeoutPolicy =
    typeof value === "number" ? { runTimeout: value } : value;

  const refreshOn = policy.refreshOn ?? "auto";
  if (refreshOn !== "auto" && refreshOn !== "heartbeat") {
    throw new Error('refreshOn must be "auto" or "heartbeat"');
  }

  const runTimeout = _coerceTimeoutMs(policy.runTimeout, "runTimeout");
  const idleTimeout = _coerceTimeoutMs(policy.idleTimeout, "idleTimeout");

  if (runTimeout === undefined && idleTimeout === undefined) {
    return undefined;
  }

  return { runTimeout, idleTimeout, refreshOn };
}
