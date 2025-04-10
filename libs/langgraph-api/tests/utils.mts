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

export async function truncate(
  apiUrl: string,
  options:
    | {
        runs?: boolean;
        threads?: boolean;
        assistants?: boolean;
        store?: boolean;
        checkpoint?: boolean;
      }
    | "all",
) {
  const flags =
    options === "all"
      ? {
          runs: true,
          threads: true,
          assistants: true,
          store: true,
          checkpoint: true,
        }
      : options;

  await fetch(`${apiUrl}/internal/truncate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(flags),
  });
}
