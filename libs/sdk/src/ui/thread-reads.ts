import type { ThreadState } from "../schema.js";

// When to read a thread's state again and what to show from it. The
// `useStream` hook and `StreamOrchestrator` both decide here and only do the
// I/O themselves.

/** Options for one read of a thread's history. */
export type HistoryReadOptions = {
  /** A failed read records no error and calls no `onError`. */
  quiet?: boolean;
};

/** Whether the state has nodes still to run, as at a breakpoint. */
export function hasPendingNodes(state: ThreadState | undefined): boolean {
  return (state?.next?.length ?? 0) > 0;
}

/** Whether a task in the state waits on an interrupt. */
export function hasTaskInterrupts(state: ThreadState | undefined): boolean {
  return (
    state?.tasks?.some((task) => (task.interrupts?.length ?? 0) > 0) ?? false
  );
}

/** Whether a task in the state failed. */
export function hasTaskErrors(state: ThreadState | undefined): boolean {
  return state?.tasks?.some((task) => task.error != null) ?? false;
}

/**
 * The read to make after a run succeeds, or `undefined` for none.
 *
 * With `refetch` the caller needs the head anyway. Otherwise only the shown
 * head's interrupts, pending nodes and task errors call for a read, since the
 * run may have answered or cleared them and they come from the head. That read
 * only refreshes what is shown, so a failure is quiet.
 */
export function planReadAfterRun(
  shownHead: ThreadState | undefined,
  refetch: boolean
): { quiet: boolean } | undefined {
  if (refetch) return { quiet: false };
  if (
    hasPendingNodes(shownHead) ||
    hasTaskInterrupts(shownHead) ||
    hasTaskErrors(shownHead)
  ) {
    return { quiet: true };
  }
  return undefined;
}
