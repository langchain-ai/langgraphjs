import { describe, expect, test } from "vitest";
import { effectScope } from "vue";
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

describe("vue/useStream interrupt computed", () => {
  test("custom: interrupt branching (empty/one/many)", async () => {
    type State = { messages: string[]; __interrupt__?: unknown[] };

    const scope = effectScope();
    const result = scope.run(() => {
      const stream = useStream<State>({
        throttle: false,
        transport: {
          async stream() {
            async function* gen() {
              yield {
                event: "values",
                data: { messages: [], __interrupt__: [] },
              };
              yield {
                event: "values",
                data: {
                  messages: [],
                  __interrupt__: [{ when: "during", value: { q: "one" } }],
                },
              };
              yield {
                event: "values",
                data: {
                  messages: [],
                  __interrupt__: [
                    { when: "during", value: { q: "a" } },
                    { when: "during", value: { q: "b" } },
                  ],
                },
              };
            }
            return gen();
          },
        },
      });
      return { stream };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");

    await result.stream.submit({});

    // After the last values event, interrupt should be the array.
    await waitFor(() => Array.isArray(result.stream.interrupt.value));
    expect(result.stream.interrupt.value).toHaveLength(2);

    scope.stop();
  });

  test("LGP: interrupt branching (empty/one/many)", async () => {
    type State = { messages: string[]; __interrupt__?: unknown[] };

    const fakeClient = {
      runs: {
        async *stream() {
          yield { event: "values", data: { messages: [], __interrupt__: [] } };
          yield {
            event: "values",
            data: {
              messages: [],
              __interrupt__: [{ when: "during", value: { q: "one" } }],
            },
          };
          yield {
            event: "values",
            data: {
              messages: [],
              __interrupt__: [
                { when: "during", value: { q: "a" } },
                { when: "during", value: { q: "b" } },
              ],
            },
          };
        },
        async *joinStream() {
          // no-op
        },
        cancel: async () => undefined,
      },
      threads: { create: async () => ({ thread_id: "t-created" }) },
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

    await result.stream.submit({});

    await waitFor(() => Array.isArray(result.stream.interrupt.value));
    expect(result.stream.interrupt.value).toHaveLength(2);

    scope.stop();
  });
});
