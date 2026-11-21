import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "../../client.js";
import { overrideFetchImplementation } from "../../singletons/fetch.js";

type MockFetch = ReturnType<typeof vi.fn> & typeof fetch;

const createMockFetch = () => vi.fn() as MockFetch;

describe("threads.create", () => {
  let fetchMock: MockFetch;

  beforeEach(() => {
    fetchMock = createMockFetch();
    overrideFetchImplementation(fetchMock);
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockThread() {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ thread_id: "thread_123" }),
      text: () => Promise.resolve(""),
      headers: new Headers({}),
    });
  }

  function parseFetchCall() {
    const [url, options] = fetchMock.mock.calls[0];
    return {
      url: new URL(url),
      method: options?.method,
      body: JSON.parse(options.body),
    };
  }

  it("keeps a caller-supplied metadata.graph_id", async () => {
    mockThread();

    const client = new Client({ apiKey: "test-api-key" });
    await client.threads.create({
      metadata: { graph_id: "my-graph", owner: "me" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, method, body } = parseFetchCall();
    expect(method).toBe("POST");
    expect(url.pathname).toBe("/threads");
    expect(body.metadata).toEqual({ graph_id: "my-graph", owner: "me" });
  });

  it("lets the graphId shorthand win over metadata.graph_id", async () => {
    mockThread();

    const client = new Client({ apiKey: "test-api-key" });
    await client.threads.create({
      graphId: "shorthand-graph",
      metadata: { graph_id: "in-metadata", owner: "me" },
    });

    expect(parseFetchCall().body.metadata).toEqual({
      graph_id: "shorthand-graph",
      owner: "me",
    });
  });

  it("omits graph_id when neither the shorthand nor metadata supplies one", async () => {
    mockThread();

    const client = new Client({ apiKey: "test-api-key" });
    await client.threads.create({ metadata: { owner: "me" } });

    expect(parseFetchCall().body.metadata).toEqual({ owner: "me" });
  });

  it("ignores an empty-string graphId instead of erasing metadata.graph_id", async () => {
    mockThread();

    const client = new Client({ apiKey: "test-api-key" });
    await client.threads.create({
      graphId: "",
      metadata: { graph_id: "in-metadata" },
    });

    expect(parseFetchCall().body.metadata).toEqual({ graph_id: "in-metadata" });
  });
});
