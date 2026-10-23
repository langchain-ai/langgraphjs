import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "../client.js";
import { mergeSignals } from "./signals.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mergeSignals", () => {
  it("returns undefined when no signals are provided", () => {
    expect(mergeSignals()).toBeUndefined();
    expect(mergeSignals(null, undefined)).toBeUndefined();
  });

  it("returns a single signal unchanged without registering listeners", () => {
    const { signal } = new AbortController();
    expect(mergeSignals(null, signal, undefined)).toBe(signal);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it("returns a repeated single signal unchanged", () => {
    const { signal } = new AbortController();
    expect(mergeSignals(signal, null, signal)).toBe(signal);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it.each([0, 1, 2])(
    "does not register listeners when input %i is already aborted",
    (abortedIndex) => {
      const sources = Array.from({ length: 3 }, () => new AbortController());
      const reason = new Error("Already cancelled");
      sources[abortedIndex].abort(reason);
      const listeners = sources.map(({ signal }) =>
        vi.spyOn(signal, "addEventListener")
      );

      const merged = mergeSignals(...sources.map(({ signal }) => signal));

      expect(merged?.aborted).toBe(true);
      expect(merged?.reason).toBe(reason);
      for (const listener of listeners) expect(listener).not.toHaveBeenCalled();
    }
  );

  it("uses the first already-aborted input's reason", () => {
    const first = AbortSignal.abort("first");
    const second = AbortSignal.abort("second");

    expect(mergeSignals(first, second)?.reason).toBe("first");
  });

  it.each([0, 1, 2])(
    "removes all source listeners when input %i aborts",
    (abortedIndex) => {
      const sources = Array.from({ length: 3 }, () => new AbortController());
      const reason = new Error("Cancelled");
      const merged = mergeSignals(
        null,
        ...sources.map(({ signal }) => signal),
        undefined
      );
      const onAbort = vi.fn();
      merged?.addEventListener("abort", onAbort);

      expect(merged?.aborted).toBe(false);
      sources[abortedIndex].abort(reason);

      expect(merged?.aborted).toBe(true);
      expect(merged?.reason).toBe(reason);
      for (const { signal } of sources) {
        expect(getEventListeners(signal, "abort")).toHaveLength(0);
      }

      for (const source of sources) source.abort("Later cancellation");
      expect(merged?.reason).toBe(reason);
      expect(onAbort).toHaveBeenCalledTimes(1);
    }
  );

  it("only subscribes once to duplicate inputs and preserves unrelated listeners", () => {
    const first = new AbortController();
    const second = new AbortController();
    const unrelatedListener = vi.fn();
    first.signal.addEventListener("abort", unrelatedListener);

    const merged = mergeSignals(first.signal, second.signal, first.signal);
    expect(getEventListeners(first.signal, "abort")).toHaveLength(2);

    second.abort("Cancelled");

    expect(merged?.reason).toBe("Cancelled");
    expect(getEventListeners(first.signal, "abort")).toEqual([
      unrelatedListener,
    ]);
    expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
    first.abort();
    expect(unrelatedListener).toHaveBeenCalledTimes(1);
  });

  it.each([null, "Cancelled", { code: "cancelled" }])(
    "preserves a non-Error abort reason: %j",
    (reason) => {
      const first = new AbortController();
      const second = new AbortController();
      const merged = mergeSignals(first.signal, second.signal);

      second.abort(reason);

      expect(merged?.reason).toBe(reason);
    }
  );

  it("does not retain a shared caller signal after successful requests time out", async () => {
    const caller = new AbortController();
    const timeouts: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const timeout = new AbortController();
      timeouts.push(timeout);
      return timeout.signal;
    });
    const fetch = vi.fn(async () =>
      Response.json({ thread_id: "test-thread" })
    );
    const client = new Client({
      apiKey: null,
      timeoutMs: 100,
      callerOptions: { maxRetries: 0, fetch },
    });

    for (let i = 0; i < 12; i += 1) {
      await expect(
        client.threads.get("test-thread", { signal: caller.signal })
      ).resolves.toEqual({ thread_id: "test-thread" });
      timeouts[i].abort(new DOMException("Request timed out", "TimeoutError"));
    }

    expect(fetch).toHaveBeenCalledTimes(12);
    expect(AbortSignal.timeout).toHaveBeenCalledTimes(12);
    expect(caller.signal.aborted).toBe(false);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });
});
