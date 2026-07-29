import { describe, expect, it } from "vitest";

import { AsyncCaller } from "./async_caller.js";

describe("HTTPError.response inclusion (regression for #2632)", () => {
  it("attaches the response to HTTPError by default (no onFailedResponseHook)", async () => {
    const caller = new AsyncCaller({ maxRetries: 0 });

    const mockResponse = {
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve("Resource not found"),
    };

    const failingCallable = () => Promise.reject(mockResponse);

    let caughtError: unknown;
    try {
      await caller.call(failingCallable);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    // Pre-fix: error.response was undefined unless onFailedResponseHook was set.
    // Post-fix: error.response is set by default.
    const error = caughtError as { response?: unknown; status?: number; text?: string };
    expect(error.response).toBe(mockResponse);
    expect(error.status).toBe(404);
    expect(error.text).toBe("Resource not found");
  });

  it("attaches the response when onFailedResponseHook is registered (legacy case)", async () => {
    const onFailedResponseHook = () => Promise.resolve(false);
    const caller = new AsyncCaller({
      maxRetries: 0,
      onFailedResponseHook,
    });

    const mockResponse = {
      status: 503,
      statusText: "Service Unavailable",
      text: () => Promise.resolve("Service down"),
    };

    const failingCallable = () => Promise.reject(mockResponse);

    let caughtError: unknown;
    try {
      await caller.call(failingCallable);
    } catch (err) {
      caughtError = err;
    }

    const error = caughtError as { response?: unknown; status?: number };
    expect(error.response).toBe(mockResponse);
    expect(error.status).toBe(503);
  });

  it("does NOT attach the response when includeResponseOnError is false", async () => {
    const caller = new AsyncCaller({
      maxRetries: 0,
      includeResponseOnError: false,
    });

    const mockResponse = {
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve("Resource not found"),
    };

    const failingCallable = () => Promise.reject(mockResponse);

    let caughtError: unknown;
    try {
      await caller.call(failingCallable);
    } catch (err) {
      caughtError = err;
    }

    const error = caughtError as { response?: unknown; status?: number; text?: string };
    // The status and text are still captured (they're cheap),
    // but the response object itself is omitted for memory savings.
    expect(error.response).toBeUndefined();
    expect(error.status).toBe(404);
    expect(error.text).toBe("Resource not found");
  });

  it("explicit includeResponseOnError: true overrides default", async () => {
    const caller = new AsyncCaller({
      maxRetries: 0,
      includeResponseOnError: true,
    });

    const mockResponse = {
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.resolve("boom"),
    };

    const failingCallable = () => Promise.reject(mockResponse);

    let caughtError: unknown;
    try {
      await caller.call(failingCallable);
    } catch (err) {
      caughtError = err;
    }

    const error = caughtError as { response?: unknown };
    expect(error.response).toBe(mockResponse);
  });

  it("does not affect onFailedResponseHook invocation (still called when set)", async () => {
    let hookCalled = false;
    const onFailedResponseHook = async () => {
      hookCalled = true;
      return false;
    };

    const caller = new AsyncCaller({
      maxRetries: 0,
      onFailedResponseHook,
    });

    const mockResponse = {
      status: 503,
      statusText: "Service Unavailable",
      text: () => Promise.resolve("Service down"),
    };

    const failingCallable = () => Promise.reject(mockResponse);

    try {
      await caller.call(failingCallable);
    } catch {
      // ignore
    }

    // The hook is called on retry attempts, not on the final throw.
    // We just verify that includeResponseOnError doesn't break the
    // hook registration.
    expect(typeof onFailedResponseHook).toBe("function");
    expect(hookCalled).toBe(true); // called via onFailedAttempt on the failed retry
  });
});

describe("includeResponseOnError default value", () => {
  it("defaults to true when no option is provided", async () => {
    const caller = new AsyncCaller({ maxRetries: 0 });
    // Use a private accessor to check the internal field
    const internal = caller as unknown as { includeResponseOnError: boolean };
    expect(internal.includeResponseOnError).toBe(true);
  });

  it("respects explicit includeResponseOnError: false", async () => {
    const caller = new AsyncCaller({
      maxRetries: 0,
      includeResponseOnError: false,
    });
    const internal = caller as unknown as { includeResponseOnError: boolean };
    expect(internal.includeResponseOnError).toBe(false);
  });
});
