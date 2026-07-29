import { describe, expect, it } from "vitest";

import { HTTPError } from "./async_caller.js";
import { isHTTPError } from "./async_caller.js";

describe("HTTPError public export (regression for #2633)", () => {
  it("exports HTTPError as a class", () => {
    // The class must be importable from the package root.
    // Before this fix, HTTPError was not exported from async_caller.ts
    // (no `export` keyword), so consumers had no way to narrow errors
    // thrown by the SDK's HTTP layer.
    expect(typeof HTTPError).toBe("function");
    expect(HTTPError.prototype).toBeInstanceOf(Error);
  });

  it("HTTPError is constructable with status, message, and optional response", () => {
    const err = new HTTPError(404, "Not Found");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HTTPError);
    expect(err.status).toBe(404);
    expect(err.text).toBe("Not Found");
    expect(err.message).toBe("HTTP 404: Not Found");
    expect(err.response).toBeUndefined();
  });

  it("HTTPError carries the response object when provided", () => {
    const mockResponse = { status: 500, statusText: "Internal Server Error" } as unknown as Response;
    const err = new HTTPError(500, "boom", mockResponse);
    expect(err.response).toBe(mockResponse);
    expect(err.status).toBe(500);
  });

  it("static isInstance narrows the type", () => {
    const real = new HTTPError(404, "Not Found");
    const other = new Error("plain");
    expect(HTTPError.isInstance(real)).toBe(true);
    expect(HTTPError.isInstance(other)).toBe(false);
    expect(HTTPError.isInstance(null)).toBe(false);
    expect(HTTPError.isInstance(undefined)).toBe(false);
    expect(HTTPError.isInstance("string")).toBe(false);
    expect(HTTPError.isInstance({ status: 404, text: "fake" })).toBe(false);
  });

  it("free-standing isHTTPError narrows the same way", () => {
    const real = new HTTPError(404, "Not Found");
    const other = new Error("plain");
    expect(isHTTPError(real)).toBe(true);
    expect(isHTTPError(other)).toBe(false);
    expect(isHTTPError(null)).toBe(false);
  });

  it("isInstance and isHTTPError agree on the same input", () => {
    const inputs = [
      new HTTPError(200, "ok"),
      new Error("plain"),
      null,
      undefined,
      "string",
      { status: 404 },
    ];
    for (const input of inputs) {
      expect(HTTPError.isInstance(input)).toBe(isHTTPError(input));
    }
  });

  it("HTTPError.fromResponse creates an error with response text", async () => {
    const response = new Response("Resource not found", {
      status: 404,
      statusText: "Not Found",
    });
    const err = await HTTPError.fromResponse(response);
    expect(err).toBeInstanceOf(HTTPError);
    expect(err.status).toBe(404);
    expect(err.text).toBe("Resource not found");
    expect(err.message).toBe("HTTP 404: Resource not found");
  });
});
