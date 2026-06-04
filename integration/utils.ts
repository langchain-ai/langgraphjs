export async function gatherIterator<T>(
  i: AsyncIterable<T> | Promise<AsyncIterable<T>>
): Promise<Array<T>> {
  const out: T[] = [];
  for await (const item of await i) out.push(item);
  return out;
}

export function findLast<T, S extends T>(
  lst: Array<T>,
  predicate: (item: T) => item is S
): S | undefined {
  for (let i = lst.length - 1; i >= 0; i--) {
    if (predicate(lst[i])) return lst[i] as S;
  }
  return undefined;
}

const TERMINAL_STATUSES = new Set(["success", "error", "interrupted"]);

export async function pollRun(
  client: { runs: { get: (threadId: string, runId: string) => Promise<any> } },
  threadId: string,
  runId: string,
  untilStatus: string = "success",
  timeout: number = 10000
): Promise<any> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const run = await client.runs.get(threadId, runId);
    if (run.status === untilStatus || TERMINAL_STATUSES.has(run.status))
      return run;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Run did not reach "${untilStatus}" within ${timeout}ms`);
}
