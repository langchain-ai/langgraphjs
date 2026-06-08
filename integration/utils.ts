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

/**
 * Helper to parse SSE chunks from a raw ReadableStream.
 * Returns an array of { event, data } objects.
 */
export async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  {
    timeout = 15_000,
    stopWhen,
  }: {
    timeout?: number;
    stopWhen?: (events: Array<{ event: string; data: any }>) => boolean;
  } = {}
): Promise<Array<{ event: string; data: any }>> {
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: any }> = [];
  let buffer = "";
  let currentEvent = "";
  let currentData = "";

  const deadline = Date.now() + timeout;

  function pushEvent() {
    if (currentEvent || currentData) {
      let parsed: any = currentData;
      try {
        parsed = JSON.parse(currentData);
      } catch {
        // keep as string
      }
      events.push({ event: currentEvent, data: parsed });
      currentEvent = "";
      currentData = "";
    }
  }

  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>(
      (resolve) => {
        timer = setTimeout(
          () => resolve({ done: true, value: undefined }),
          Math.max(deadline - Date.now(), 0)
        );
      }
    );

    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    clearTimeout(timer);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Normalize \r\n → \n (server sends \r\n per SSE spec)
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Parse SSE frames from buffer
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData = line.slice(5).trim();
      } else if (line === "") {
        pushEvent();
      }
    }

    if (stopWhen && stopWhen(events)) break;
  }

  // Flush any partially accumulated SSE message
  pushEvent();

  reader.cancel().catch(() => {});
  return events;
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
