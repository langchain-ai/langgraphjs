import { describe, expect, test, vi } from "vitest";
import { effectScope } from "vue";
import { useStream } from "../vue/index.js";

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

describe("vue/useStream (custom transport)", () => {
  test("updates values and aborts on scope dispose", async () => {
    type State = { messages: string[] };

    let seenSignal: AbortSignal | undefined;

    const scope = effectScope();
    const result = scope.run(() => {
      const stream = useStream<State>({
        throttle: false,
        transport: {
          async stream({ signal }) {
            seenSignal = signal;
            async function* gen() {
              yield { event: "values", data: { messages: ["a"] } };

              // Wait until aborted; this simulates an in-flight stream.
              await abortSignalPromise(signal);
            }
            return gen();
          },
        },
      });

      const submitPromise = stream.submit({});
      return { stream, submitPromise };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");

    await waitFor(() => {
      return (
        seenSignal != null &&
        result.stream.values.value.messages?.length === 1 &&
        result.stream.values.value.messages[0] === "a"
      );
    });

    // Disposing the scope should stop the stream (abort the signal).
    scope.stop();
    expect(seenSignal?.aborted).toBe(true);

    // The submit promise should settle after abort.
    await result.submitPromise;
  });

  test("generates threadId via crypto.randomUUID and injects configurable.thread_id", async () => {
    type State = { messages: string[] };

    const onThreadId = vi.fn();
    const generated = "00000000-0000-0000-0000-000000000000";
    const uuidSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue(generated);

    let seenThreadId: string | undefined;
    let seenConfigThreadId: string | undefined;

    const scope = effectScope();
    const result = scope.run(() => {
      const stream = useStream<State>({
        throttle: false,
        onThreadId,
        transport: {
          async stream({ config }) {
            // capture injected thread id
            seenThreadId = (config as any)?.configurable?.thread_id; // eslint-disable-line @typescript-eslint/no-explicit-any
            seenConfigThreadId = (config as any)?.configurable?.thread_id; // eslint-disable-line @typescript-eslint/no-explicit-any
            async function* gen() {
              yield { event: "values", data: { messages: ["ok"] } };
            }
            return gen();
          },
        },
      });
      return { stream };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");

    await result.stream.submit({});

    await waitFor(() => result.stream.values.value.messages?.[0] === "ok");

    expect(uuidSpy).toHaveBeenCalledTimes(1);
    expect(onThreadId).toHaveBeenCalledWith(generated);
    expect(seenThreadId).toBe(generated);
    expect(seenConfigThreadId).toBe(generated);

    scope.stop();
    uuidSpy.mockRestore();
  });
});
