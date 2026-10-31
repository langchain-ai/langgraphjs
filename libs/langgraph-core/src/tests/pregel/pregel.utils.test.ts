import { describe, it, expect } from "vitest";
import {
  AbortSignalFanOut,
  combineAbortSignals,
} from "../../pregel/utils/index.js";

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
    expect(signal?.reason).toBe("abort signal 1");
  });

  it("fans out a parent signal to parallel consumers", () => {
    const parent = new AbortController();
    const fanOut = new AbortSignalFanOut(parent.signal);

    const childSignals = Array.from({ length: 12 }, () => fanOut.fork());
    for (const child of childSignals) {
      child.addEventListener("abort", () => undefined, { once: true });
    }

    parent.abort("cancelled");
    for (const child of childSignals) {
      expect(child.aborted).toBe(true);
      expect(child.reason).toBe("cancelled");
    }

    for (const child of childSignals) {
      fanOut.release(child);
    }
    fanOut.dispose();
  });

  it("aborts immediately if one signal is already aborted", () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    controller2.abort("abort signal 2");
    const { signal } = combineAbortSignals(
      controller1.signal,
      controller2.signal
    );
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe("abort signal 2");
  });
});
