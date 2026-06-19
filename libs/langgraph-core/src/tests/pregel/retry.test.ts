/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { _runWithRetry } from "../../pregel/retry.js";
import type { PregelExecutableTask } from "../../pregel/types.js";

function makeTask(
  invoke: ReturnType<typeof vi.fn>,
  retryPolicy: NonNullable<PregelExecutableTask<string, string>["retry_policy"]>
): PregelExecutableTask<string, string> {
  return {
    id: "task-1",
    name: "test_node",
    input: {},
    proc: { invoke } as any,
    writes: [],
    writers: [],
    triggers: [],
    retry_policy: retryPolicy,
  };
}

describe("_runWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses backoff: initial * backoff^(attempts - 1)", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce("ok");

    const sleepSpy = vi.spyOn(globalThis, "setTimeout");

    const task = makeTask(invoke, {
      maxAttempts: 3,
      initialInterval: 10,
      backoffFactor: 2,
      jitter: false,
      retryOn: () => true,
      logWarning: false,
    });

    const resultPromise = _runWithRetry(task);
    await vi.runAllTimersAsync();
    const { result, error } = await resultPromise;

    expect(error).toBeUndefined();
    expect(result).toBe("ok");
    expect(invoke).toHaveBeenCalledTimes(3);

    const sleepDelays = sleepSpy.mock.calls.map((call) => call[1]);
    expect(sleepDelays).toEqual([10, 20]);
  });

  it("applies jitter: interval + uniform(0, 1s) in ms", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.05);

    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce("ok");

    const sleepSpy = vi.spyOn(globalThis, "setTimeout");

    const task = makeTask(invoke, {
      maxAttempts: 2,
      initialInterval: 10,
      jitter: true,
      retryOn: () => true,
      logWarning: false,
    });

    const resultPromise = _runWithRetry(task);
    await vi.runAllTimersAsync();
    await resultPromise;

    const sleepDelays = sleepSpy.mock.calls.map((call) => call[1]);
    expect(sleepDelays).toEqual([60]);
  });
});
