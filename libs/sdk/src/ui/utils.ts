import type { Client } from "../client.js";
import type { RunsStreamPayload } from "../types.js";
import type { StreamMode } from "../types.stream.js";

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

/**
 * Streams a run as `client.runs.stream` does. When `stopSignal` aborts before
 * the response, the run is cancelled on the server instead of reported
 * through `onRunCreated`: a run created with `on_disconnect: "continue"`
 * outlives its request, and only the response carries its id, so the request
 * stays open until the id arrives. The stream itself still ends as soon as
 * `signal` aborts.
 */
export async function* streamRun(
  client: Client,
  threadId: string,
  assistantId: string,
  {
    stopSignal,
    ...payload
  }: RunsStreamPayload<StreamMode[], boolean> & {
    signal: AbortSignal;
    stopSignal?: AbortSignal;
  }
): AsyncGenerator<unknown> {
  if (stopSignal == null) {
    return yield* client.runs.stream(threadId, assistantId, payload);
  }
  const { signal } = payload;
  if (signal.aborted) return;

  const request = new AbortController();
  let runId: string | undefined;
  const run = client.runs.stream(threadId, assistantId, {
    ...payload,
    signal: request.signal,
    onRunCreated(params) {
      runId = params.run_id;
      if (stopSignal.aborted) {
        void client.runs.cancel(threadId, runId);
        request.abort();
      } else {
        payload.onRunCreated?.(params);
      }
    },
  });
  const close = () => {
    request.abort();
    void run.return(undefined);
  };

  const firstEvent = run.next();
  const first = await Promise.race([
    firstEvent,
    new Promise<undefined>((resolve) => {
      signal.addEventListener("abort", () => resolve(undefined), {
        once: true,
      });
    }),
  ]);
  if (first === undefined || signal.aborted) {
    if (runId === undefined && stopSignal.aborted) {
      void firstEvent.then(close, close);
    } else {
      close();
    }
    return;
  }
  if (first.done) return;

  signal.addEventListener("abort", close, { once: true });
  yield first.value;
  yield* run;
}
