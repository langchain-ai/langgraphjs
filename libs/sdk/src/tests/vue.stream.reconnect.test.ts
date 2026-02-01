import { describe, expect, test } from "vitest";
import { effectScope, reactive } from "vue";
import { useStream } from "../vue/index.js";

async function waitFor(
  condition: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 1000;
  const intervalMs = options?.intervalMs ?? 5;
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (condition()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, intervalMs);
    });
  }
}

function createMemoryStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
  };
}

describe("vue/useStream reconnectOnMount", () => {
  test("auto-joins stored runId once per thread, and reconnects after thread switch", async () => {
    type State = { messages: string[] };

    const storage = createMemoryStorage({
      "lg:stream:t1": "run-1",
    });

    const originalWindow = (globalThis as any).window; // eslint-disable-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = { sessionStorage: storage }; // eslint-disable-line @typescript-eslint/no-explicit-any

    const joinCalls: Array<{ threadId: string; runId: string }> = [];

    const opts = reactive<any>({
      assistantId: "a1",
      threadId: "t1",
      fetchStateHistory: false,
      reconnectOnMount: true,
      thread: {
        data: [],
        error: undefined,
        isLoading: false,
        mutate: async () => [],
      },
      client: {
        runs: {
          async *stream() {
            // no-op
          },
          async *joinStream(threadId: string, runId: string) {
            joinCalls.push({ threadId, runId });
            yield { event: "values", data: { messages: [`joined:${runId}`] } };
          },
          cancel: async () => undefined,
        },
        threads: { create: async () => ({ thread_id: "t-created" }) },
      },
      throttle: false,
    });

    const scope = effectScope();
    const result = scope.run(() => {
      const stream = useStream<State>(opts);
      return { stream };
    });
    if (!result) throw new Error("Failed to create Vue effect scope.");

    // should auto-join run-1 for t1
    await waitFor(
      () => result.stream.values.value.messages?.[0] === "joined:run-1"
    );
    expect(joinCalls).toEqual([{ threadId: "t1", runId: "run-1" }]);

    // should not re-join again without thread switch
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(joinCalls).toHaveLength(1);

    // Switch threads, prepopulate new run, expect reconnect again.
    storage.setItem("lg:stream:t2", "run-2");
    opts.threadId = "t2";

    await waitFor(
      () => result.stream.values.value.messages?.[0] === "joined:run-2"
    );
    expect(joinCalls).toEqual([
      { threadId: "t1", runId: "run-1" },
      { threadId: "t2", runId: "run-2" },
    ]);

    scope.stop();
    (globalThis as any).window = originalWindow; // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});
