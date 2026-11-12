import type { Client } from "@langchain/langgraph-sdk";

type Values = Record<string, unknown>;

/** A run of the fake server, which a test drives. */
export interface FakeRun {
  readonly runId: string;
  readonly threadId: string;
  readonly payload: Record<string, unknown>;
  send(event: string, data: unknown): void;
  /** Saves `values` as the thread's state, sends them, and ends the stream. */
  finish(values?: Values): void;
}

const notFound = () => Object.assign(new Error("HTTP 404"), { status: 404 });

/**
 * A `Client` over in-memory threads, recording each request in `calls` as
 * `"<method> <thread id>"`.
 */
export function fakeServer(threads: Record<string, Values> = {}) {
  const state = new Map(Object.entries(threads));
  const history = new Map<string, Values>();
  const runs: FakeRun[] = [];
  const calls: string[] = [];
  let ids = 0;

  const threadState = (threadId: string) => ({
    values: state.get(threadId),
    next: [],
    tasks: [],
    checkpoint: {
      thread_id: threadId,
      checkpoint_ns: "",
      checkpoint_id: `${threadId}-cp`,
      checkpoint_map: null,
    },
    metadata: {},
    created_at: null,
    parent_checkpoint: null,
  });

  function startRun(threadId: string, payload: Record<string, unknown>) {
    const runId = `run-${(ids += 1)}`;
    const queued: Array<{ event: string; data: unknown }> = [];
    let wake = () => {};
    let done = false;
    const signal = payload.signal as AbortSignal | undefined;
    signal?.addEventListener("abort", () => {
      done = true;
      wake();
    });
    const run: FakeRun = {
      runId,
      threadId,
      payload,
      send(event, data) {
        queued.push({ event, data });
        wake();
      },
      finish(values) {
        if (values != null) {
          state.set(threadId, values);
          queued.push({ event: "values", data: values });
        }
        done = true;
        wake();
      },
    };
    runs.push(run);
    const onRunCreated = payload.onRunCreated as
      | ((run: { run_id: string; thread_id: string }) => void)
      | undefined;
    return (async function* () {
      onRunCreated?.({ run_id: runId, thread_id: threadId });
      yield { event: "metadata", data: { run_id: runId } };
      while (true) {
        while (queued.length > 0) yield queued.shift()!;
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })();
  }

  const client = {
    threads: {
      async create({ threadId }: { threadId?: string } = {}) {
        const id = threadId ?? `thread-${(ids += 1)}`;
        calls.push(`create ${id}`);
        if (!state.has(id)) state.set(id, {});
        return { thread_id: id };
      },
      async getState(threadId: string) {
        calls.push(`getState ${threadId}`);
        if (!state.has(threadId)) throw notFound();
        return threadState(threadId);
      },
      async getHistory(
        threadId: string,
        options?: { checkpoint?: { checkpoint_ns?: string } }
      ) {
        const namespace = options?.checkpoint?.checkpoint_ns;
        calls.push(`getHistory ${threadId}${namespace ? ` ${namespace}` : ""}`);
        const values = namespace == null ? undefined : history.get(namespace);
        return values == null ? [] : [{ ...threadState(threadId), values }];
      },
      // No thread stream, as on the JS dev server.
      joinStream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(notFound()),
        }),
      }),
    },
    runs: {
      stream: (
        threadId: string,
        _assistantId: string,
        payload: Record<string, unknown>
      ) => startRun(threadId, payload),
      joinStream: () => (async function* () {})(),
      async create(threadId: string) {
        calls.push(`create run ${threadId}`);
        return {
          run_id: `run-${(ids += 1)}`,
          created_at: new Date().toISOString(),
        };
      },
      list: async () => [],
      get: async () => ({ status: "success" }),
      async cancel(_threadId: string, runId: string) {
        calls.push(`cancel ${runId}`);
      },
    },
    info: async () => ({ flags: { stream_lifecycle: true } }),
  };

  return {
    client: client as unknown as Client,
    calls,
    runs,
    /** Values a subgraph's history read returns, by namespace. */
    history,
  };
}
