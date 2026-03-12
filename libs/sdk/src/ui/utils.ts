import type { StreamMode } from "../types.stream.js";

export function unique<T>(array: T[]) {
  return [...new Set(array)] as T[];
}

export function withCompactStreamMode(
  streamMode?: StreamMode | StreamMode[]
) {
  return unique([
    ...(streamMode == null
      ? []
      : Array.isArray(streamMode)
        ? streamMode
        : [streamMode]),
    "compact" as StreamMode,
  ]);
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
