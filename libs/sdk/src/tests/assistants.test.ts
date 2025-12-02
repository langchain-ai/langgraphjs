import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "../client.js";
import { overrideFetchImplementation } from "../singletons/fetch.js";

function assistantPayload() {
  return {
    assistant_id: "asst_123",
    graph_id: "graph_123",
    config: { configurable: { foo: "bar" } },
    context: { foo: "bar" },
    created_at: "2024-01-01T00:00:00Z",
    metadata: { env: "test" },
    version: 1,
    name: "My Assistant",
    description: "Example",
    updated_at: "2024-01-02T00:00:00Z",
  };
}

describe("assistants.search", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    overrideFetchImplementation(fetchMock);
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns list by default", async () => {
    const assistant = assistantPayload();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([assistant]),
      text: () => Promise.resolve(""),
      headers: new Headers({}),
    });

    const client = new Client({ apiKey: "test-api-key" });
    const result = await client.assistants.search({ limit: 3 });

    expect(result).toEqual([assistant]);
  });

  it("can include pagination metadata", async () => {
    const assistant = assistantPayload();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([assistant]),
      text: () => Promise.resolve(""),
      headers: new Headers({ "X-Pagination-Next": "42" }),
    });

    const client = new Client({ apiKey: "test-api-key" });
    const result = await client.assistants.search({ includePagination: true });

    expect(result).toEqual({ assistants: [assistant], next: "42" });
  });
});
