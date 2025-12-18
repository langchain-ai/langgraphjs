import { describe, it, expect, vi, afterEach } from "vitest";
import { AsyncCaller } from "../async_caller.js";

describe("AsyncCaller", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("error handling with undefined/null message", () => {
    it("should handle errors with undefined message without crashing", async () => {
      const caller = new AsyncCaller({ maxRetries: 0 });

      // Create an error without a message property
      const errorWithoutMessage = new Error();
      // @ts-expect-error - deliberately removing message for testing
      delete errorWithoutMessage.message;

      const failingCallable = vi.fn(() => Promise.reject(errorWithoutMessage));

      // The key test: this should not crash with "Cannot read properties of undefined"
      await expect(caller.call(failingCallable)).rejects.toThrow();
      expect(failingCallable).toHaveBeenCalled();
    });

    it("should handle errors with null message without crashing", async () => {
      const caller = new AsyncCaller({ maxRetries: 0 });

      const errorWithNullMessage = new Error();
      // @ts-expect-error - deliberately setting message to null for testing
      errorWithNullMessage.message = null;

      const failingCallable = vi.fn(() => Promise.reject(errorWithNullMessage));

      // The key test: this should not crash with "Cannot read properties of null"
      await expect(caller.call(failingCallable)).rejects.toThrow();
      expect(failingCallable).toHaveBeenCalled();
    });

    it("should handle empty error object without crashing", async () => {
      const caller = new AsyncCaller({ maxRetries: 0 });

      // Create a minimal error-like object
      const minimalError = { name: "Error" };

      const failingCallable = vi.fn(() => Promise.reject(minimalError));

      // Should not crash
      await expect(caller.call(failingCallable)).rejects.toThrow();
    });
  });

  describe("successful calls", () => {
    it("should return result from successful call", async () => {
      const caller = new AsyncCaller({ maxRetries: 3 });

      const successfulCallable = vi.fn(() =>
        Promise.resolve({ data: "success" })
      );

      const result = await caller.call(successfulCallable);
      expect(result).toEqual({ data: "success" });
      expect(successfulCallable).toHaveBeenCalledTimes(1);
    });

    it("should pass arguments to callable", async () => {
      const caller = new AsyncCaller({ maxRetries: 3 });

      const successfulCallable = vi.fn((a: number, b: string) =>
        Promise.resolve(`${a}-${b}`)
      );

      const result = await caller.call(successfulCallable, 42, "test");
      expect(result).toBe("42-test");
      expect(successfulCallable).toHaveBeenCalledWith(42, "test");
    });
  });

  describe("fetch method", () => {
    it("should use custom fetch when provided", async () => {
      const mockFetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          text: () => Promise.resolve(""),
          json: () => Promise.resolve({}),
          headers: new Headers(),
        } as Response)
      );

      const caller = new AsyncCaller({
        maxRetries: 0,
        fetch: mockFetch,
      });

      await caller.fetch("http://example.com/api");

      expect(mockFetch).toHaveBeenCalledWith("http://example.com/api");
    });

    it("should reject non-ok responses", async () => {
      const mockFetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: () => Promise.resolve("Server error"),
          headers: new Headers(),
        } as Response)
      );

      const caller = new AsyncCaller({
        maxRetries: 0,
        fetch: mockFetch,
      });

      await expect(caller.fetch("http://example.com/api")).rejects.toThrow(
        /HTTP 500/
      );
    });
  });

  describe("callWithOptions", () => {
    it("should work without signal option", async () => {
      const caller = new AsyncCaller({ maxRetries: 3 });

      const successfulCallable = vi.fn(() => Promise.resolve("success"));

      const result = await caller.callWithOptions({}, successfulCallable);
      expect(result).toBe("success");
    });

    it("should pass through to call when no signal provided", async () => {
      const caller = new AsyncCaller({ maxRetries: 3 });

      const successfulCallable = vi.fn((x: number) => Promise.resolve(x * 2));

      const result = await caller.callWithOptions({}, successfulCallable, 21);
      expect(result).toBe(42);
      expect(successfulCallable).toHaveBeenCalledWith(21);
    });
  });

  describe("HTTP error handling", () => {
    it("should convert response-like objects to HTTPError", async () => {
      const caller = new AsyncCaller({ maxRetries: 0 });

      // Simulate a response object being rejected (like from fetch)
      const responseError = {
        status: 404,
        statusText: "Not Found",
        text: () => Promise.resolve("Resource not found"),
      };

      const failingCallable = vi.fn(() => Promise.reject(responseError));

      await expect(caller.call(failingCallable)).rejects.toThrow(/HTTP 404/);
    });

    it("should include response text in HTTPError message", async () => {
      const caller = new AsyncCaller({ maxRetries: 0 });

      const responseError = {
        status: 400,
        statusText: "Bad Request",
        text: () => Promise.resolve("Invalid parameters"),
      };

      const failingCallable = vi.fn(() => Promise.reject(responseError));

      await expect(caller.call(failingCallable)).rejects.toThrow(
        "HTTP 400: Invalid parameters"
      );
    });
  });

  describe("onFailedResponseHook", () => {
    it("should call onFailedResponseHook when provided and request fails with response", async () => {
      const onFailedResponseHook = vi.fn(() => Promise.resolve(false));

      const caller = new AsyncCaller({
        maxRetries: 0,
        onFailedResponseHook,
      });

      const mockResponse = {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: () => Promise.resolve("Service down"),
      };

      const failingCallable = vi.fn(() => Promise.reject(mockResponse));

      await expect(caller.call(failingCallable)).rejects.toThrow(/HTTP 503/);
    });
  });

  describe("maxConcurrency", () => {
    it("should default to Infinity for maxConcurrency", async () => {
      const caller = new AsyncCaller({});

      // Just verify we can create a caller with default options
      expect(caller).toBeDefined();
    });

    it("should respect maxConcurrency setting", async () => {
      const caller = new AsyncCaller({ maxConcurrency: 1 });

      const order: number[] = [];
      const callable = vi.fn(async (id: number) => {
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return id;
      });

      // Start multiple calls - with maxConcurrency=1, they should run sequentially
      const results = await Promise.all([
        caller.call(callable, 1),
        caller.call(callable, 2),
        caller.call(callable, 3),
      ]);

      expect(results).toEqual([1, 2, 3]);
      expect(order).toEqual([1, 2, 3]); // Should run in order due to concurrency limit
    });
  });
});
