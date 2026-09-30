import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "../client.js";

afterEach(() => {
  vi.useRealTimers();
});

function createClient(fetch: typeof globalThis.fetch) {
  return new Client({
    apiUrl: "http://localhost:8123",
    apiKey: null,
    callerOptions: { fetch, maxRetries: 2 },
  });
}

describe("SDK cancellation retries", () => {
  it.each([
    { name: "AbortError", message: "This operation was aborted" },
    { name: "TimeoutError", message: "The operation was aborted due to timeout" },
  ])("does not retry a native $name", async ({ name, message }) => {
    vi.useFakeTimers();
    const error = new DOMException(message, name);
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(error);
    const result = createClient(fetch).threads.get("thread").catch((e) => e);

    await vi.runAllTimersAsync();

    expect(await result).toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["AbortError: cancelled", "TimeoutError: expired", "Cancelled"])(
    "preserves no-retry behavior for the legacy message %s",
    async (message) => {
      vi.useFakeTimers();
      const error = new Error(message);
      const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(error);
      const result = createClient(fetch).threads.get("thread").catch((e) => e);

      await vi.runAllTimersAsync();

      expect(await result).toBe(error);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it("still retries a transient network failure", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(Response.json({ thread_id: "thread" }));
    const result = createClient(fetch).threads.get("thread");

    await vi.runAllTimersAsync();

    expect(await result).toEqual({ thread_id: "thread" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
