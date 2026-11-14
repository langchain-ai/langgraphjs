import { afterEach, describe, expect, it, vi } from "vitest";
import { _runWithRetry } from "../pregel/retry.js";

function taskFor(invoke: () => Promise<unknown>) {
  return {
    id: "3078-provenance",
    name: "B",
    input: {},
    config: { configurable: {} },
    writes: [],
    proc: { invoke },
  } as unknown as Parameters<typeof _runWithRetry>[0];
}

afterEach(() => vi.useRealTimers());

describe("issue #3078: retry outcome is not cancellation provenance", () => {
  it("retains a genuine domain error when cancellation happens during retry backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const domainError = new Error("B domain failure before cancellation");
    const invoke = vi.fn(async () => { throw domainError; });
    const task = taskFor(invoke);
    let enteredRetry!: () => void;
    const retryEntered = new Promise<void>((resolve) => { enteredRetry = resolve; });
    let abortedAtFailure: boolean | undefined;
    const running = _runWithRetry(task, {
      maxAttempts: 2,
      initialInterval: 1,
      jitter: false,
      logWarning: false,
      retryOn: (error) => {
        expect(error).toBe(domainError);
        abortedAtFailure = controller.signal.aborted;
        enteredRetry();
        return true;
      },
    }, undefined, controller.signal);
    await retryEntered;
    controller.abort();
    await vi.runAllTimersAsync();
    const settled = await running;
    console.log("[issue3078-retry-provenance]", JSON.stringify({
      abortedAtFailure,
      signalAborted: settled.signalAborted,
      sameDomainError: settled.error === domainError,
      error: { name: settled.error?.name, message: settled.error?.message },
      calls: invoke.mock.calls.length,
      writes: settled.task.writes,
    }));
    expect(abortedAtFailure).toBe(false);
    expect(settled.error).toBe(domainError);
    expect(settled.signalAborted).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("returns the cancellation reason without writes when the first attempt is prevented", async () => {
    const controller = new AbortController();
    controller.abort();
    const invoke = vi.fn(async () => ({ b: 1 }));
    const task = taskFor(invoke);
    const settled = await _runWithRetry(task, {
      maxAttempts: 2,
      initialInterval: 1,
      jitter: false,
      logWarning: false,
    }, undefined, controller.signal);
    console.log("[issue3078-preaborted]", JSON.stringify({
      signalAborted: settled.signalAborted,
      error: settled.error,
      result: settled.result,
      calls: invoke.mock.calls.length,
      writes: settled.task.writes,
    }));
    expect(settled.error).toBe(controller.signal.reason);
    expect(settled.result).toBeUndefined();
    expect(settled.task.writes).toEqual([]);
    expect(settled.signalAborted).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
