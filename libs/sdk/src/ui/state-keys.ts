import type { ThreadState, ThreadStateSelectField } from "../schema.js";

// `stateKeys`: the root `values` keys a UI reads. The thread load asks the
// server for only those, and every root `values` the engine shows keeps only
// those, so a server that ignores `select` shows the same.

/**
 * The thread-state fields other than `values`, which the engine reads itself:
 * `checkpoint` and `parent_checkpoint` place the head and its branches,
 * `next` and `tasks` hold breakpoints, interrupts and task errors, and
 * `metadata` and `created_at` come with the head an app's `onFinish` gets.
 */
const THREAD_STATE_FIELDS: readonly ThreadStateSelectField[] = [
  "next",
  "tasks",
  "checkpoint",
  "parent_checkpoint",
  "created_at",
  "metadata",
];

/** What `stateKeys` loads and shows. Built once, when an engine is created. */
export interface StateKeys {
  /**
   * The root `values` keys shown: `stateKeys`, the messages key, and
   * `__interrupt__`, which a run's `values` events carry.
   */
  readonly kept: ReadonlySet<string>;
  /** The `select` of a thread load. */
  readonly select: ThreadStateSelectField[];
}

/** `stateKeys` with the messages key, or `undefined` when it is unset. */
export function stateKeysOf(
  stateKeys: readonly string[] | undefined,
  messagesKey: string
): StateKeys | undefined {
  if (stateKeys == null) return undefined;
  const keys = new Set([...stateKeys, messagesKey]);
  return {
    kept: new Set([...keys, "__interrupt__"]),
    select: [
      ...THREAD_STATE_FIELDS,
      ...[...keys].map((key): ThreadStateSelectField => `values.${key}`),
    ],
  };
}

/** `values` with only the `kept` keys. Unchanged without `kept`. */
export function pickKeys<V extends Record<string, unknown>>(
  values: V,
  kept: ReadonlySet<string> | undefined
): V {
  if (kept == null) return values;
  const picked: Record<string, unknown> = {};
  for (const key of kept) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      picked[key] = values[key];
    }
  }
  return picked as V;
}

/** Thread states whose `values` keep only the `kept` keys. */
export function pickKeysOfStates<V extends Record<string, unknown>>(
  states: ThreadState<V>[],
  kept: ReadonlySet<string> | undefined
): ThreadState<V>[] {
  if (kept == null) return states;
  return states.map((state) =>
    state.values == null
      ? state
      : { ...state, values: pickKeys(state.values, kept) }
  );
}
