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

describe("vue/useStream (LGP)", () => {
  test("dispatcher uses LGP path when transport is absent", async () => {
    type State = { messages: string[] };

    const scope = effectScope();

    const result = scope.run(() => {
      // Provide a fake client + external thread state to avoid network/history logic.
      const fakeClient = {
        runs: {
          async *stream() {
            yield { event: "values", data: { messages: ["lgp"] } };
          },
          async *joinStream() {
            yield { event: "values", data: { messages: ["join"] } };
          },
          cancel: async () => undefined,
        },
        threads: {
          create: async () => ({ thread_id: "t-created" }),
        },
      };

      const stream = useStream<State>({
        assistantId: "a1",
        // ensure we don't attempt to create a thread
        threadId: "t1",
        // avoid built-in history fetch
        fetchStateHistory: false,
        thread: {
          data: [],
          error: undefined,
          isLoading: false,
          mutate: async () => [],
        },
        client: fakeClient as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        throttle: false,
      });

      return { stream };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");

    const submitPromise = result.stream.submit({});

    await waitFor(() => result.stream.values.value.messages?.[0] === "lgp");

    await submitPromise;
    scope.stop();
  });

  test("changing reactive threadId clears stream values", async () => {
    type State = { messages: string[] };

    const scope = effectScope();

    const options = reactive<any>({
      assistantId: "a1",
      threadId: "t1",
      fetchStateHistory: false,
      thread: {
        data: [],
        error: undefined,
        isLoading: false,
        mutate: async () => [],
      },
      client: {
        runs: {
          async *stream() {
            yield { event: "values", data: { messages: ["before-clear"] } };
          },
          async *joinStream() {
            yield { event: "values", data: { messages: ["join"] } };
          },
          cancel: async () => undefined,
        },
        threads: {
          create: async () => ({ thread_id: "t-created" }),
        },
      },
      throttle: false,
    });

    const result = scope.run(() => {
      const stream = useStream<State>(options);
      return { stream };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");

    const submitPromise = result.stream.submit({});
    await waitFor(
      () => result.stream.values.value.messages?.[0] === "before-clear"
    );
    await submitPromise;

    // Changing the threadId should clear the stream state.
    options.threadId = "t2";

    await waitFor(
      () => (result.stream.values.value.messages?.length ?? 0) === 0
    );

    scope.stop();
  });

  test("joinStream updates values from join generator", async () => {
    type State = { messages: string[] };

    const scope = effectScope();
    const result = scope.run(() => {
      const stream = useStream<State>({
        assistantId: "a1",
        threadId: "t1",
        fetchStateHistory: false,
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
            async *joinStream(_threadId: string, _runId: string) {
              yield { event: "values", data: { messages: ["joined"] } };
            },
            cancel: async () => undefined,
          },
          threads: { create: async () => ({ thread_id: "t-created" }) },
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        throttle: false,
      });
      return { stream };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");

    await result.stream.joinStream("run-1");
    await waitFor(() => result.stream.values.value.messages?.[0] === "joined");
    expect(result.stream.values.value.messages?.[0]).toBe("joined");

    scope.stop();
  });
});
