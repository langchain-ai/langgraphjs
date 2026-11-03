import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "../../client.js";
import { overrideFetchImplementation } from "../../singletons/fetch.js";

type MockFetch = ReturnType<typeof vi.fn> & typeof fetch;

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers({}),
  });

describe("client.http", () => {
  let fetchMock: MockFetch;

  beforeEach(() => {
    fetchMock = vi.fn(() => jsonResponse({ ok: true })) as MockFetch;
    overrideFetchImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a POST with a JSON body, params and merged headers", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ run_id: "run_1" }));
    const client = new Client({
      apiUrl: "http://example.com/",
      apiKey: "test-api-key",
      defaultHeaders: { "x-default": "default" },
    });

    const result = await client.http.post<{ run_id: string }>(
      "/threads/thread_1/runs/take",
      {
        json: { run_id: "run_1" },
        params: { wait: true, tags: ["a", "b"] },
        headers: { "x-custom": "custom" },
      }
    );

    expect(result).toEqual({ run_id: "run_1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://example.com/threads/thread_1/runs/take?wait=true&tags=a&tags=b"
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-api-key": "test-api-key",
      "x-default": "default",
      "x-custom": "custom",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({ run_id: "run_1" });
  });

  it.each([
    ["get", "GET"],
    ["put", "PUT"],
    ["patch", "PATCH"],
    ["delete", "DELETE"],
  ] as const)("%s sends a %s request", async (name, method) => {
    const client = new Client({ apiUrl: "http://example.com", apiKey: null });

    await client.http[name]("/some/route");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://example.com/some/route");
    expect(init.method).toBe(method);
    expect(init.body).toBeUndefined();
  });

  it("applies the onRequest hook", async () => {
    const onRequest = vi.fn((_url: URL, init: RequestInit) => ({
      ...init,
      headers: { ...(init.headers as Record<string, string>), "x-hook": "1" },
    }));
    const client = new Client({
      apiUrl: "http://example.com",
      apiKey: null,
      onRequest,
    });

    await client.http.get("/info");

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest.mock.calls[0][0].toString()).toBe(
      "http://example.com/info"
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "x-hook": "1" });
  });

  it("rejects with the response status on an error response", async () => {
    fetchMock.mockImplementationOnce(() =>
      jsonResponse({ detail: "Thread not found" }, 404)
    );
    const client = new Client({ apiUrl: "http://example.com", apiKey: null });

    await expect(
      client.http.post("/threads/missing/runs/take", { json: {} })
    ).rejects.toMatchObject({
      status: 404,
      message: 'HTTP 404: {"detail":"Thread not found"}',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
