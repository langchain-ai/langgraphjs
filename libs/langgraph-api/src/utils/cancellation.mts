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

/** The cancel action a signal was aborted with, if it was a deliberate cancel. */
export const getCancelAction = (
  signal: AbortSignal
): CancelAction | undefined =>
  signal.aborted && signal.reason instanceof RunCancellation
    ? signal.reason.action
    : undefined;
