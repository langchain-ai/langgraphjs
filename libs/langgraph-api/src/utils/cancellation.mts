export type CancelAction = "rollback" | "interrupt";

/**
 * Abort reason for a run that is stopped on purpose (user stop, supersede or
 * rollback). Its `name` is the marker `@langchain/core`'s tracer recognizes, so
 * the run is traced as `cancelled` rather than as an error. Matched by name, so
 * this needs no new `@langchain/core` version.
 */
export class RunCancellation extends Error {
  override readonly name = "ExpectedCancellation";

  constructor(readonly action: CancelAction) {
    super(`Run cancelled: ${action}`);
  }
}

const isCancelAction = (value: unknown): value is CancelAction =>
  value === "interrupt" || value === "rollback";

/**
 * The cancel action a signal was aborted with, if it was a deliberate cancel.
 *
 * Also accepts the legacy bare `"interrupt"` / `"rollback"` string reasons, and
 * any marker error (by `name`) carrying an `action`, so custom `Ops`
 * implementations keep working without importing this module.
 */
export const getCancelAction = (
  signal: AbortSignal
): CancelAction | undefined => {
  if (!signal.aborted) return undefined;
  const { reason } = signal;
  if (isCancelAction(reason)) return reason;
  if (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: unknown }).name === "ExpectedCancellation" &&
    isCancelAction((reason as { action?: unknown }).action)
  ) {
    return (reason as { action: CancelAction }).action;
  }
  return undefined;
};
