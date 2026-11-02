import type { ThreadState, ThreadTask } from "../schema.js";

// When to read a thread's state again and what to show from it. The
// `useStream` hook and `StreamOrchestrator` both decide here and only do the
// I/O themselves.

/** Options for one read of a thread's history. */
export type HistoryReadOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** A failed read records no error and calls no `onError`. */
  quiet?: boolean;
  /** Changes the states read before they are shown. */
  map?: (states: ThreadState<StateType>[]) => ThreadState<StateType>[];
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

/**
 * The read to make after `stop()` cut a run off, or `undefined` for none.
 *
 * The read gets what the server kept, through the history when it is
 * enabled. With a `thread` of its own and no history, the hook shows that
 * thread's data, which server values would outrank. Without history the read
 * only refreshes what is shown, so a failure is quiet.
 */
export function planStopRead(stop: {
  history: boolean;
  userThread?: boolean;
}): { quiet: boolean } | undefined {
  if (stop.history) return { quiet: false };
  if (stop.userThread) return undefined;
  return { quiet: true };
}

/**
 * The states read after a stop, without what the stop left in the head.
 *
 * The tasks a stop cancels read as failed and their step stays in `next`, so
 * the head would show the cancellation as an error, or the node it cut off as
 * a breakpoint. When the head has such tasks, their errors and `next` are
 * dropped, so a stop shows neither. Errors the shown head already had stay.
 */
export function applyStopRead<S extends ThreadState>(
  states: S[],
  shownHead: ThreadState | undefined
): S[] {
  const [head, ...older] = states;
  if (head == null) return states;
  const shown = new Map(shownHead?.tasks?.map((task) => [task.id, task.error]));
  const cancelled = (task: ThreadTask) =>
    task.error != null && shown.get(task.id) !== task.error;
  if (!head.tasks?.some(cancelled)) return states;
  return [
    {
      ...head,
      next: [],
      tasks: head.tasks.map((task) =>
        cancelled(task) ? { ...task, error: null } : task
      ),
    },
    ...older,
  ];
}
