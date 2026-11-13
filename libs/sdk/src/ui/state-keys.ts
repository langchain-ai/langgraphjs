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

/**
 * The root `values` keys shown: `stateKeys`, the messages key, and
 * `__interrupt__`, which a run's `values` events carry. `undefined` when
 * `stateKeys` is unset, so every key shows.
 */
function keptKeys(
  stateKeys: readonly string[] | undefined,
  messagesKey: string
): ReadonlySet<string> | undefined {
  if (stateKeys == null) return undefined;
  return new Set([...stateKeys, messagesKey, "__interrupt__"]);
}

/** The `select` of a thread load, or `undefined` to read the full state. */
export function stateKeysSelect(
  stateKeys: readonly string[] | undefined,
  messagesKey: string
): ThreadStateSelectField[] | undefined {
  if (stateKeys == null) return undefined;
  const keys = new Set([...stateKeys, messagesKey]);
  return [
    ...THREAD_STATE_FIELDS,
    ...[...keys].map((key): ThreadStateSelectField => `values.${key}`),
  ];
}

/** `values` with only the keys `stateKeys` shows. Unchanged when it is unset. */
export function pickStateKeys<V extends Record<string, unknown>>(
  values: V,
  stateKeys: readonly string[] | undefined,
  messagesKey: string
): V {
  const kept = keptKeys(stateKeys, messagesKey);
  if (kept == null) return values;
  const picked: Record<string, unknown> = {};
  for (const key of kept) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      picked[key] = values[key];
    }
  }
  return picked as V;
}

/** Thread states whose `values` keep only the keys `stateKeys` shows. */
export function pickStateKeysOfStates<V extends Record<string, unknown>>(
  states: ThreadState<V>[],
  stateKeys: readonly string[] | undefined,
  messagesKey: string
): ThreadState<V>[] {
  if (stateKeys == null) return states;
  return states.map((state) =>
    state.values == null
      ? state
      : {
          ...state,
          values: pickStateKeys(state.values, stateKeys, messagesKey),
        }
  );
}
