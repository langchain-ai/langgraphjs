import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "../client.js";
import { overrideFetchImplementation } from "../singletons/fetch.js";

describe("runs.cancelMany", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    overrideFetchImplementation(fetchMock);
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockNoContent() {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: () => Promise.resolve(undefined),
      text: () => Promise.resolve(""),
      headers: new Headers({}),
    });
  }

  function parseFetchCall() {
    const [url, init] = fetchMock.mock.calls[0];
    return {
      url: new URL(url),
      method: init?.method,
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
  }

  it("cancels by status", async () => {
    mockNoContent();

    const client = new Client({ apiKey: "test-api-key" });
    await client.runs.cancelMany({ status: "pending" });

    const { url, method, body } = parseFetchCall();
    expect(method).toBe("POST");
    expect(url.pathname).toBe("/runs/cancel");
    expect(body).toEqual({ status: "pending" });
  });

  it("cancels by thread ID and run IDs", async () => {
    mockNoContent();

    const client = new Client({ apiKey: "test-api-key" });
    await client.runs.cancelMany({
      threadId: "thread_abc",
      runIds: ["run_1", "run_2"],
    });

    const { url, method, body } = parseFetchCall();
    expect(method).toBe("POST");
    expect(url.pathname).toBe("/runs/cancel");
    expect(body).toEqual({
      thread_id: "thread_abc",
      run_ids: ["run_1", "run_2"],
    });
  });

  it("passes action as query parameter", async () => {
    mockNoContent();

    const client = new Client({ apiKey: "test-api-key" });
    await client.runs.cancelMany({
      status: "all",
      action: "rollback",
    });

    const { url, body } = parseFetchCall();
    expect(url.searchParams.get("action")).toBe("rollback");
    expect(body).toEqual({ status: "all" });
  });

  it("omits undefined fields from request body", async () => {
    mockNoContent();

    const client = new Client({ apiKey: "test-api-key" });
    await client.runs.cancelMany({ status: "running" });

    const { body } = parseFetchCall();
    expect(body).not.toHaveProperty("thread_id");
    expect(body).not.toHaveProperty("run_ids");
    expect(body).toEqual({ status: "running" });
  });
});
