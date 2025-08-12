import { describe, it, expect } from "vitest";
import { combineAbortSignals } from "../../pregel/utils/index.js";

describe("combineAbortSignals", () => {
  it("should combine multiple abort signals", () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const { signal } = combineAbortSignals(
      controller1.signal,
      controller2.signal
    );
    controller1.abort("abort signal 1");
    controller2.abort("abort signal 2");
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe("abort signal 2");
  });
});
