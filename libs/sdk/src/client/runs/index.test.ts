import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "../../client.js";
import { overrideFetchImplementation } from "../../singletons/fetch.js";

type MockFetch = ReturnType<typeof vi.fn> & typeof fetch;

const createMockFetch = () => vi.fn() as MockFetch;

describe("runs.cancelMany", () => {
  let fetchMock: MockFetch;

  beforeEach(() => {
    fetchMock = createMockFetch();
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

describe("runs.cancel", () => {
  function mockCancel() {
    const fetchMock = createMockFetch();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: () => Promise.resolve(undefined),
      text: () => Promise.resolve(""),
      headers: new Headers({}),
    });
    return fetchMock;
  }

  it("sends the reason as a query param", async () => {
    const fetchMock = mockCancel();
    const client = new Client({
      apiKey: "test-api-key",
      callerOptions: { fetch: fetchMock },
    });

    await client.runs.cancel("thread_abc", "run_1", false, "interrupt", {
      reason: "taken",
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/threads/thread_abc/runs/run_1/cancel");
    expect(url.searchParams.get("reason")).toBe("taken");
    expect(url.searchParams.get("action")).toBe("interrupt");
  });

  it("sends no reason when none is set", async () => {
    const fetchMock = mockCancel();
    const client = new Client({
      apiKey: "test-api-key",
      callerOptions: { fetch: fetchMock },
    });

    await client.runs.cancel("thread_abc", "run_1");

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.has("reason")).toBe(false);
  });
});

describe("runs.list", () => {
  function parseFetchCall(fetchMock: MockFetch) {
    const [url] = fetchMock.mock.calls[0];
    return { url: new URL(url) };
  }

  it("sends an array-valued param (select) as repeated query entries, not one JSON string", async () => {
    const fetchMock = createMockFetch();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve("[]"),
      headers: new Headers({}),
    });

    const client = new Client({
      apiKey: "test-api-key",
      callerOptions: { fetch: fetchMock },
    });
    await client.runs.list("thread_abc", {
      status: "pending",
      select: ["run_id", "kwargs", "created_at", "multitask_strategy"],
    });

    const { url } = parseFetchCall(fetchMock);
    expect(url.searchParams.getAll("select")).toEqual([
      "run_id",
      "kwargs",
      "created_at",
      "multitask_strategy",
    ]);
    expect(url.searchParams.get("status")).toBe("pending");
  });
});

describe("runs strictResume", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends strict_resume from create, wait and stream only when set", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/runs/stream")
        ? new Response("event: end\ndata: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          })
        : new Response("{}", {
            headers: { "content-type": "application/json" },
          })
    ) as unknown as MockFetch;
    overrideFetchImplementation(fetchMock);
    const client = new Client({ apiKey: "test-api-key" });

    await client.runs.create("thread_abc", "agent", { strictResume: true });
    await client.runs.wait("thread_abc", "agent", { strictResume: true });
    const chunks = [];
    for await (const chunk of client.runs.stream("thread_abc", "agent", {
      strictResume: true,
    })) {
      chunks.push(chunk);
    }
    await client.runs.create("thread_abc", "agent");

    expect(
      fetchMock.mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body)).strict_resume
      )
    ).toEqual([true, true, true, undefined]);
  });
});

describe("runs.createBatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps each payload onto the run-create schema", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("[]", {
          headers: { "content-type": "application/json" },
        })
    ) as unknown as MockFetch;
    overrideFetchImplementation(fetchMock);
    const client = new Client({ apiKey: "test-api-key" });

    await client.runs.createBatch([
      {
        assistantId: "agent",
        input: { question: "hi" },
        metadata: { source: "batch" },
        interruptBefore: ["review"],
        checkpointId: "ckpt_1",
        multitaskStrategy: "enqueue",
        streamMode: "values",
        afterSeconds: 30,
        ifNotExists: "create",
        feedbackKeys: ["fb"],
      },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe("/runs/batch");
    expect(JSON.parse(String(init?.body))).toEqual([
      {
        assistant_id: "agent",
        input: { question: "hi" },
        metadata: { source: "batch" },
        interrupt_before: ["review"],
        checkpoint_id: "ckpt_1",
        multitask_strategy: "enqueue",
        stream_mode: "values",
        after_seconds: 30,
        if_not_exists: "create",
        feedback_keys: ["fb"],
      },
    ]);
  });
});
