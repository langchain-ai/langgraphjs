import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeSignals } from "./signals.js";

const nativeAbortSignalAny = AbortSignal.any;

describe.each([
  { runtime: "with AbortSignal.any", abortSignalAny: nativeAbortSignalAny },
  { runtime: "without AbortSignal.any", abortSignalAny: undefined },
])("mergeSignals $runtime", ({ abortSignalAny }) => {
  beforeEach(() => {
    AbortSignal.any = abortSignalAny as typeof AbortSignal.any;
  });

  afterEach(() => {
    AbortSignal.any = nativeAbortSignalAny;
  });

  it("aborts with the input's reason and leaves no listener on the others", () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    const merged = mergeSignals(timeout.signal, caller.signal);

    timeout.abort("timed out");

    expect(merged?.reason).toBe("timed out");
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("adds no listeners when an input is already aborted", () => {
    const caller = new AbortController();
    const merged = mergeSignals(caller.signal, AbortSignal.abort("done"));

    expect(merged?.reason).toBe("done");
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });
});

it("keeps no listeners on a caller signal shared by requests in flight", () => {
  const caller = new AbortController();
  for (let i = 0; i < 20; i += 1) {
    mergeSignals(caller.signal, new AbortController().signal);
  }

  expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
});
