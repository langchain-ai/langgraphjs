/**
 * Returns true when `onFinish` declares at least one parameter and therefore
 * needs the server-fetched thread head. A zero-arity `onFinish` is treated as
 * side-effect-only and does not trigger a post-stream `getHistory` when
 * branching history is not enabled.
 *
 * Note: functions with only default parameters report `.length === 0` in
 * JavaScript; if you need the thread state, declare at least one non-default
 * parameter (e.g. `(state)` or `(_state, run)`).
 */
export function onFinishRequiresThreadState(onFinish: unknown): boolean {
  if (typeof onFinish !== "function") return false;
  return onFinish.length > 0;
}

export function unique<T>(array: T[]) {
  return [...new Set(array)] as T[];
}

export function findLast<T>(array: T[], predicate: (item: T) => boolean) {
  for (let i = array.length - 1; i >= 0; i -= 1) {
    if (predicate(array[i])) return array[i];
  }
  return undefined;
}

export async function* filterStream<T, TReturn>(
  stream: AsyncGenerator<T, TReturn>,
  filter: (event: T) => boolean
): AsyncGenerator<T, TReturn> {
  while (true) {
    const { value, done } = await stream.next();
    if (done) return value as TReturn;
    if (filter(value)) yield value as T;
  }
}
