import { describe, it, expect, vi } from "vitest";
import { AsyncCaller } from "../utils/async_caller.js";

describe("AsyncCaller retry and error handling", () => {
  it("surfaces the original error message on non-retryable failure", async () => {
    const caller = new AsyncCaller({ maxRetries: 0 });

    const err = new Error("Something specific went wrong");
    const callable = vi.fn().mockRejectedValue(err);

    await expect(caller.call(callable)).rejects.toThrow(
      "Something specific went wrong"
    );
  });

  it("surfaces HTTP error details on non-retryable status", async () => {
    const caller = new AsyncCaller({ maxRetries: 1 });

    const response = new Response("Not Found", { status: 404 });
    const callable = vi.fn().mockRejectedValue(response);

    await expect(caller.call(callable)).rejects.toThrow("HTTP 404");
    expect(callable).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable HTTP errors and eventually surfaces the error", async () => {
    const caller = new AsyncCaller({ maxRetries: 1 });

    const response = new Response("Service Unavailable", { status: 503 });
    const callable = vi.fn().mockRejectedValue(response);

    await expect(caller.call(callable)).rejects.toThrow("HTTP 503");
    expect(callable).toHaveBeenCalledTimes(2);
  });

  it("does not retry on abort errors", async () => {
    const caller = new AsyncCaller({ maxRetries: 1 });

    const err = new Error("AbortError");
    const callable = vi.fn().mockRejectedValue(err);

    await expect(caller.call(callable)).rejects.toThrow("AbortError");
    expect(callable).toHaveBeenCalledTimes(1);
  });

  it("does not retry on cancel errors", async () => {
    const caller = new AsyncCaller({ maxRetries: 1 });

    const err = new Error("Cancel: operation was cancelled");
    const callable = vi.fn().mockRejectedValue(err);

    await expect(caller.call(callable)).rejects.toThrow("Cancel");
    expect(callable).toHaveBeenCalledTimes(1);
  });

  it("wraps connection refused errors with a helpful message", async () => {
    const caller = new AsyncCaller({ maxRetries: 0 });

    const err = new Error(
      "request to http://localhost:2024 failed, ECONNREFUSED"
    );
    const callable = vi.fn().mockRejectedValue(err);

    await expect(caller.call(callable)).rejects.toThrow(
      "Unable to connect to LangGraph server"
    );
  });

  it("retries transient errors and succeeds", async () => {
    const caller = new AsyncCaller({ maxRetries: 1 });

    const callable = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("success");

    const result = await caller.call(callable);
    expect(result).toBe("success");
    expect(callable).toHaveBeenCalledTimes(2);
  });
});
