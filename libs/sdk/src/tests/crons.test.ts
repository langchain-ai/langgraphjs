import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "../client.js";
import { overrideFetchImplementation } from "../singletons/fetch.js";

function cronPayload() {
  return {
    cron_id: "cron_123",
    assistant_id: "asst_123",
    thread_id: "thread_123",
    schedule: "0 0 * * *",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    payload: {
      input: { message: "test" },
      metadata: { env: "test" },
    },
    enabled: true,
  };
}

describe("crons.update", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    overrideFetchImplementation(fetchMock);
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("only sends defined fields to API", async () => {
    const cron = cronPayload();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(cron),
      text: () => Promise.resolve(""),
      headers: new Headers({}),
    });

    const client = new Client({ apiKey: "test-api-key" });
    await client.crons.update("cron_123", {
      schedule: "0 10 * * *",
      enabled: false,
      // Other fields are undefined and should not be sent
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(url).toContain("/runs/crons/cron_123");
    expect(options.method).toBe("PATCH");
    expect(body).toEqual({
      schedule: "0 10 * * *",
      enabled: false,
    });
  });

  it("converts camelCase to snake_case", async () => {
    const cron = cronPayload();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(cron),
      text: () => Promise.resolve(""),
      headers: new Headers({}),
    });

    const client = new Client({ apiKey: "test-api-key" });
    await client.crons.update("cron_123", {
      schedule: "0 10 * * *",
      endTime: "2024-12-31T23:59:59Z",
      interruptBefore: ["node1", "node2"],
      interruptAfter: "*",
      onRunCompleted: "delete",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body).toEqual({
      schedule: "0 10 * * *",
      end_time: "2024-12-31T23:59:59Z",
      interrupt_before: ["node1", "node2"],
      interrupt_after: "*",
      on_run_completed: "delete",
    });
  });

  it("sends all updatable fields when provided", async () => {
    const cron = cronPayload();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(cron),
      text: () => Promise.resolve(""),
      headers: new Headers({}),
    });

    const client = new Client({ apiKey: "test-api-key" });
    await client.crons.update("cron_123", {
      schedule: "0 10 * * *",
      endTime: "2024-12-31T23:59:59Z",
      input: { message: "updated" },
      metadata: { env: "prod" },
      config: { configurable: { foo: "bar" } },
      context: { user: "test" },
      webhook: "https://example.com/webhook",
      interruptBefore: ["node1"],
      interruptAfter: ["node2"],
      onRunCompleted: "keep",
      enabled: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body).toEqual({
      schedule: "0 10 * * *",
      end_time: "2024-12-31T23:59:59Z",
      input: { message: "updated" },
      metadata: { env: "prod" },
      config: { configurable: { foo: "bar" } },
      context: { user: "test" },
      webhook: "https://example.com/webhook",
      interrupt_before: ["node1"],
      interrupt_after: ["node2"],
      on_run_completed: "keep",
      enabled: false,
    });
  });

  it("passes signal through to fetch", async () => {
    const cron = cronPayload();
    const abortController = new AbortController();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(cron),
      text: () => Promise.resolve(""),
      headers: new Headers({}),
    });

    const client = new Client({ apiKey: "test-api-key" });
    await client.crons.update("cron_123", {
      schedule: "0 10 * * *",
      signal: abortController.signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];

    expect(options.signal).toBe(abortController.signal);
  });
});