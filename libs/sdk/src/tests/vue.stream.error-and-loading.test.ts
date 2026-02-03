import { describe, expect, test, vi } from "vitest";
import { effectScope } from "vue";
import { useStream } from "../vue/index.js";
import { StreamError } from "../ui/errors.js";

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

function abortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function abortSignalPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), {
      once: true,
    });
  });
}

describe("vue/useStream (error + loading + stop)", () => {
  test("custom: error.value updates when transport throws", async () => {
    type State = { messages: string[] };

    const onError = vi.fn();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const scope = effectScope();
    const result = scope.run(() => {
      const stream = useStream<State>({
        throttle: false,
        onError,
        transport: {
          async stream() {
            throw new Error("boom");
          },
        },
      });
      return { stream };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");
    expect(result.stream.error.value).toBeUndefined();

    await result.stream.submit({});
    await waitFor(() => result.stream.isLoading.value === false);
    await waitFor(() => result.stream.error.value instanceof Error);

    expect(result.stream.error.value).toBeInstanceOf(Error);
    expect((result.stream.error.value as Error).message).toContain("boom");
    expect(result.stream.isLoading.value).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);

    scope.stop();
    errorSpy.mockRestore();
  });

  test("custom: isLoading lifecycle + explicit stop() aborts mid-stream", async () => {
    type State = { messages: string[] };

    let seenSignal: AbortSignal | undefined;
    const onStop = vi.fn(({ mutate }: any) => {
      mutate(() => ({ messages: ["stopped"] }));
    });

    const scope = effectScope();
    const result = scope.run(() => {
      const stream = useStream<State>({
        throttle: false,
        onStop,
        transport: {
          async stream({ signal }) {
            seenSignal = signal;
            async function* gen() {
              yield { event: "values", data: { messages: ["a"] } };
              await abortSignalPromise(signal);
            }
            return gen();
          },
        },
      });
      return { stream };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");

    expect(result.stream.isLoading.value).toBe(false);
    const submitPromise = result.stream.submit({});

    await waitFor(() => result.stream.isLoading.value === true);
    expect(result.stream.values.value.messages[0]).toBe("a");

    await result.stream.stop();
    expect(seenSignal?.aborted).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(result.stream.values.value.messages?.[0]).toBe("stopped");

    await waitFor(() => result.stream.isLoading.value === false);
    await submitPromise;

    scope.stop();
  });

  test("custom: multiple sequential submits queue and final state reflects second run", async () => {
    type State = { messages: string[] };

    let callCount = 0;
    let firstSignal: AbortSignal | undefined;

    const scope = effectScope();
    const result = scope.run(() => {
      const stream = useStream<State>({
        throttle: false,
        transport: {
          async stream({ signal, input }) {
            callCount += 1;
            const runId = (input as any)?.run ?? callCount; // eslint-disable-line @typescript-eslint/no-explicit-any
            if (callCount === 1) firstSignal = signal;

            async function* gen() {
              yield { event: "values", data: { messages: [`run-${runId}`] } };
              if (callCount === 1) {
                // block until aborted so run #2 is queued
                await abortSignalPromise(signal);
              }
            }
            return gen();
          },
        },
      });
      return { stream };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");

    const p1 = result.stream.submit({ run: 1 } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    await waitFor(() => result.stream.isLoading.value === true);
    await waitFor(() => result.stream.values.value.messages?.[0] === "run-1");

    const p2 = result.stream.submit({ run: 2 } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    // Abort run #1 so the queued run #2 can start.
    await result.stream.stop();
    expect(firstSignal?.aborted).toBe(true);

    await p1;
    await waitFor(() => result.stream.values.value.messages?.[0] === "run-2");
    await p2;

    scope.stop();
  });

  test("custom: optimisticValues apply before first streamed values", async () => {
    type State = { messages: string[] };

    const scope = effectScope();
    const result = scope.run(() => {
      const stream = useStream<State>({
        throttle: false,
        transport: {
          async stream() {
            async function* gen() {
              // delay first yield so we can observe optimistic state
              await new Promise((r) => {
                setTimeout(r, 25);
              });
              yield { event: "values", data: { messages: ["streamed"] } };
            }
            return gen();
          },
        },
      });
      return { stream };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");

    await result.stream.submit(null, {
      optimisticValues: { messages: ["optimistic"] },
    });

    // should see optimistic state before stream yields
    expect(result.stream.values.value.messages?.[0]).toBe("optimistic");

    await waitFor(
      () => result.stream.values.value.messages?.[0] === "streamed"
    );

    scope.stop();
  });

  test("LGP: optimisticValues apply before first streamed values", async () => {
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
              await new Promise((r) => {
                setTimeout(r, 25);
              });
              yield { event: "values", data: { messages: ["streamed"] } };
            },
            async *joinStream() {
              // no-op
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

    await result.stream.submit(null, {
      optimisticValues: { messages: ["optimistic"] },
    });
    expect(result.stream.values.value.messages?.[0]).toBe("optimistic");

    await waitFor(
      () => result.stream.values.value.messages?.[0] === "streamed"
    );

    scope.stop();
  });

  test("LGP: isLoading lifecycle + explicit stop() aborts mid-stream", async () => {
    type State = { messages: string[] };

    let seenSignal: AbortSignal | undefined;

    const fakeClient = {
      runs: {
        stream: (_threadId: string, _assistantId: string, opts: any) => {
          seenSignal = opts.signal as AbortSignal;
          async function* gen() {
            yield { event: "values", data: { messages: ["lgp-a"] } };
            await abortSignalPromise(opts.signal);
          }
          return gen();
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
        client: fakeClient as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        throttle: false,
      });
      return { stream };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");

    expect(result.stream.isLoading.value).toBe(false);
    const submitPromise = result.stream.submit({});

    await waitFor(() => result.stream.isLoading.value === true);
    await waitFor(() => result.stream.values.value.messages?.[0] === "lgp-a");

    await result.stream.stop();
    expect(seenSignal?.aborted).toBe(true);

    await waitFor(() => result.stream.isLoading.value === false);
    await submitPromise;

    scope.stop();
  });

  test("LGP: error precedence streamError > historyError > history.error", async () => {
    type State = { messages: string[] };

    const historyErrorState = {
      values: { messages: [] },
      next: [],
      checkpoint: {
        thread_id: "t1",
        checkpoint_ns: "",
        checkpoint_id: "c1",
        checkpoint_map: null,
      },
      metadata: {},
      created_at: null,
      parent_checkpoint: null,
      tasks: [
        {
          id: "task-1",
          name: "task",
          error: JSON.stringify({
            message: "history-task-error",
            name: "TaskError",
          }),
          interrupts: [],
          checkpoint: null,
          state: null,
        },
      ],
    };

    // Case A: only history.error
    {
      const scope = effectScope();
      const result = scope.run(() => {
        const stream = useStream<State>({
          assistantId: "a1",
          threadId: "t1",
          fetchStateHistory: false,
          thread: {
            data: [],
            error: "history.error",
            isLoading: false,
            mutate: async () => [],
          },
          client: {
            runs: {
              async *stream() {
                // no stream error emitted
              },
              async *joinStream() {
                // no-op
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
      expect(result.stream.error.value).toBe("history.error");
      scope.stop();
    }

    // Case B: historyError overrides history.error
    {
      const scope = effectScope();
      const result = scope.run(() => {
        const stream = useStream<State>({
          assistantId: "a1",
          threadId: "t1",
          fetchStateHistory: false,
          thread: {
            data: [historyErrorState] as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            error: "history.error",
            isLoading: false,
            mutate: async () => [],
          },
          client: {
            runs: {
              async *stream() {
                // no stream error emitted
              },
              async *joinStream() {
                // no-op
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
      expect(result.stream.error.value).toBeInstanceOf(StreamError);
      expect((result.stream.error.value as Error).message).toBe(
        "history-task-error"
      );
      scope.stop();
    }

    // Case C: streamError overrides historyError
    {
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const onError = vi.fn();
      const scope = effectScope();
      const result = scope.run(() => {
        const stream = useStream<State>({
          assistantId: "a1",
          threadId: "t1",
          fetchStateHistory: false,
          onError,
          thread: {
            data: [historyErrorState] as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            error: "history.error",
            isLoading: false,
            mutate: async () => [],
          },
          client: {
            runs: {
              async *stream() {
                yield { event: "error", data: { message: "stream-error" } };
              },
              async *joinStream() {
                // no-op
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

      await result.stream.submit({});
      await waitFor(
        () => (result.stream.error.value as any)?.message === "stream-error"
      ); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(result.stream.error.value).toBeInstanceOf(StreamError);
      expect((result.stream.error.value as Error).message).toBe("stream-error");
      expect(onError).toHaveBeenCalledTimes(1);

      scope.stop();
      errorSpy.mockRestore();
    }
  });

  test("LGP: history and experimental_branchTree throw when fetchStateHistory is false", async () => {
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
            async *joinStream() {
              // no-op
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

    expect(() => result.stream.history.value).toThrow();
    expect(() => result.stream.experimental_branchTree.value).toThrow();

    scope.stop();
  });
});
