/**
 * Strategies for handling a new run on a thread that already has one in
 * flight. Single source of truth for both the type and runtime validation.
 */
export const MULTITASK_STRATEGIES = [
  "reject",
  "rollback",
  "interrupt",
  "enqueue",
] as const;

/** Actions accepted when cancelling an in-flight run. */
export const CANCEL_ACTIONS = ["interrupt", "rollback"] as const;
