export async function gatherIterator<T>(
  i: AsyncIterable<T> | Promise<AsyncIterable<T>>,
): Promise<Array<T>> {
  const out: T[] = [];
  for await (const item of await i) out.push(item);
  return out;
}

export function findLast<T, S extends T>(
  lst: Array<T>,
  predicate: (item: T) => item is S,
): S | undefined {
  for (let i = lst.length - 1; i >= 0; i--) {
    if (predicate(lst[i])) return lst[i] as S;
  }
  return undefined;
}
