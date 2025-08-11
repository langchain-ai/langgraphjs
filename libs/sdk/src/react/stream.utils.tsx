/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

export function unique<T>(array: T[]) {
  return [...new Set(array)] as T[];
}
export function findLastIndex<T>(array: T[], predicate: (item: T) => boolean) {
  for (let i = array.length - 1; i >= 0; i -= 1) {
    if (predicate(array[i])) return i;
  }
  return -1;
}
