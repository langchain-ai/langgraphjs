import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "../client.js";
import { overrideFetchImplementation } from "../singletons/fetch.js";
import {
  ProtocolSseTransportAdapter,
  ProtocolWebSocketTransportAdapter,
} from "./stream/transport/index.js";
import * as envUtils from "../utils/env.js";

type MockFetch = ReturnType<typeof vi.fn> & typeof fetch;

describe.each([["global"], ["mocked"]])(
  "Client uses %s fetch",
  (description: string) => {
    let globalFetchMock: MockFetch;
    let overriddenFetch: MockFetch;

    let expectedFetchMock: MockFetch;
    let unexpectedFetchMock: MockFetch;

    beforeEach(() => {
      globalFetchMock = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              batch_ingest_config: {
                use_multipart_endpoint: true,
              },
            }),
          text: () => Promise.resolve(""),
          headers: new Headers({}),
        })
      ) as MockFetch;
      overriddenFetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              batch_ingest_config: {
                use_multipart_endpoint: true,
              },
            }),
          text: () => Promise.resolve(""),
          headers: new Headers({}),
        })
      ) as MockFetch;
      expectedFetchMock =
        description === "mocked" ? overriddenFetch : globalFetchMock;
      unexpectedFetchMock =
        description === "mocked" ? globalFetchMock : overriddenFetch;

      if (description === "mocked") {
        overrideFetchImplementation(overriddenFetch);
      } else {
        overrideFetchImplementation(globalFetchMock);
      }
      // Mock global fetch
      (globalThis as any).fetch = globalFetchMock;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe("createRuns", () => {
      it("should create an example with the given input and generation", async () => {
        const client = new Client({ apiKey: "test-api-key" });

        const thread = await client.threads.create();
        expect(expectedFetchMock).toHaveBeenCalledTimes(1);
        expect(unexpectedFetchMock).not.toHaveBeenCalled();

        vi.clearAllMocks(); // Clear all mocks before the next operation

        // Then clear & run the function
        await client.runs.create(thread.thread_id, "somegraph", {
          input: { foo: "bar" },
        });
        expect(expectedFetchMock).toHaveBeenCalledTimes(1);
        expect(unexpectedFetchMock).not.toHaveBeenCalled();
      });
    });

    describe("threads.update", () => {
      it("should request a minimal response when returnMinimal is true", async () => {
        expectedFetchMock.mockResolvedValueOnce({
          ok: true,
          status: 204,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          headers: new Headers({}),
        });

        const client = new Client({ apiKey: "test-api-key" });
        const result = await client.threads.update("thread_123", {
          metadata: { foo: "bar" },
          returnMinimal: true,
        });

        expect(result).toBeUndefined();
        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/threads/thread_123"),
          expect.objectContaining({
            method: "PATCH",
            headers: expect.objectContaining({
              prefer: "return=minimal",
            }),
          })
        );
        expect(
          JSON.parse((expectedFetchMock.mock.calls[0][1] as RequestInit).body as string)
        ).toEqual({ metadata: { foo: "bar" } });
        expect(unexpectedFetchMock).not.toHaveBeenCalled();
      });
    });

    describe("header coalescing", () => {
      it("should properly merge headers with conflicting name casing", async () => {
        const client = new Client({ apiKey: "test-api-key" });
        await (client.threads as any).fetch("/test", {
          headers: { "X-Api-Key": "custom-value" },
        });
        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "custom-value",
            }),
          })
        );
      });

      it("should properly merge headers from multiple sources", async () => {
        const client = new Client({
          apiKey: "test-api-key",
          defaultHeaders: {
            "x-default": "default-value",
            "x-override": "default-value",
          },
        });

        await (client.threads as any).fetch("/test", {
          headers: {
            "x-custom": "custom-value",
            "x-override": "custom-value",
          },
        });

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "test-api-key",
              "x-default": "default-value",
              "x-custom": "custom-value",
              "x-override": "custom-value",
            }),
          })
        );

        vi.clearAllMocks();

        // Test with null/undefined values
        await (client.threads as any).fetch("/test", {
          headers: {
            "x-null": null,
            "x-undefined": undefined,
            "x-empty": "",
          },
        });

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "test-api-key",
              "x-default": "default-value",
            }),
          })
        );
        expect(expectedFetchMock).not.toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-null": null,
              "x-undefined": undefined,
            }),
          })
        );
      });

      it("should handle Headers object input", async () => {
        const client = new Client({ apiKey: "test-api-key" });
        const headers = new Headers();
        headers.append("x-custom", "custom-value");
        headers.append("x-multi", "value1");
        headers.append("x-multi", "value2");

        await (client.threads as any).fetch("/test", { headers });

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "test-api-key",
              "x-custom": "custom-value",
              "x-multi": "value1, value2",
            }),
          })
        );
      });

      it("should handle array of header tuples", async () => {
        const client = new Client({
          apiKey: "test-api-key",
          defaultHeaders: {
            "x-custom": "custom-value",
          },
        });
        const headers = [
          ["x-multi", "value1"],
          ["x-multi", "value2"],
        ];

        await (client.threads as any).fetch("/test", { headers });

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "test-api-key",
              "x-custom": "custom-value",
              "x-multi": "value1, value2",
            }),
          })
        );
      });
    });

    describe("in-flight read coalescing", () => {
      let pending: Array<() => void>;

      const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

      beforeEach(() => {
        pending = [];
        const makeResponse = () => ({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ values: {}, next: [] }),
          text: () => Promise.resolve(""),
          headers: new Headers({}),
        });
        // A fetch that only resolves when we explicitly flush, so two
        // concurrent reads genuinely overlap in flight.
        const deferred = vi.fn(
          () =>
            new Promise((resolve) => {
              pending.push(() => resolve(makeResponse()));
            })
        );
        expectedFetchMock = deferred as MockFetch;
        overrideFetchImplementation(deferred);
        (globalThis as any).fetch = deferred;
      });

      const flush = () => {
        for (const resolve of pending.splice(0)) resolve();
      };

      it("coalesces concurrent identical getState reads into one request", async () => {
        const client = new Client({ apiKey: "k" });
        const p1 = client.threads.getState("t-state");
        const p2 = client.threads.getState("t-state");
        await tick();
        expect(expectedFetchMock).toHaveBeenCalledTimes(1);
        flush();
        await Promise.all([p1, p2]);
      });

      it("does not coalesce reads for different threads", async () => {
        const client = new Client({ apiKey: "k" });
        const p1 = client.threads.getState("t-a");
        const p2 = client.threads.getState("t-b");
        await tick();
        expect(expectedFetchMock).toHaveBeenCalledTimes(2);
        flush();
        await Promise.all([p1, p2]);
      });

      it("re-fetches once the in-flight read settles (no result caching)", async () => {
        const client = new Client({ apiKey: "k" });
        const p1 = client.threads.getState("t-resettle");
        await tick();
        expect(expectedFetchMock).toHaveBeenCalledTimes(1);
        flush();
        await p1;

        const p2 = client.threads.getState("t-resettle");
        await tick();
        expect(expectedFetchMock).toHaveBeenCalledTimes(2);
        flush();
        await p2;
      });

      it("coalesces concurrent getHistory reads into one request", async () => {
        const client = new Client({ apiKey: "k" });
        const p1 = client.threads.getHistory("t-hist", { limit: 20 });
        const p2 = client.threads.getHistory("t-hist", { limit: 20 });
        await tick();
        expect(expectedFetchMock).toHaveBeenCalledTimes(1);
        flush();
        await Promise.all([p1, p2]);
      });

      it("does not coalesce when the caller supplies an AbortSignal", async () => {
        const client = new Client({ apiKey: "k" });
        const ac = new AbortController();
        const p1 = client.threads.getState("t-signal", undefined, {
          signal: ac.signal,
        });
        const p2 = client.threads.getState("t-signal", undefined, {
          signal: ac.signal,
        });
        await tick();
        expect(expectedFetchMock).toHaveBeenCalledTimes(2);
        flush();
        await Promise.all([p1, p2]);
      });

      it("does not coalesce across clients using different credentials", async () => {
        // Same API URL + thread, different auth → must NOT share a
        // promise (otherwise the second caller would receive a response
        // fetched with the first caller's credentials).
        const clientA = new Client({ apiKey: "tenant-a" });
        const clientB = new Client({ apiKey: "tenant-b" });
        const p1 = clientA.threads.getState("t-shared");
        const p2 = clientB.threads.getState("t-shared");
        await tick();
        expect(expectedFetchMock).toHaveBeenCalledTimes(2);
        flush();
        await Promise.all([p1, p2]);
      });

      it("coalesces across clients only when credentials match", async () => {
        const clientA = new Client({ apiKey: "same" });
        const clientB = new Client({ apiKey: "same" });
        const p1 = clientA.threads.getState("t-match");
        const p2 = clientB.threads.getState("t-match");
        await tick();
        expect(expectedFetchMock).toHaveBeenCalledTimes(1);
        flush();
        await Promise.all([p1, p2]);
      });

      it("does not coalesce when an onRequest hook is configured", async () => {
        // `onRequest` can inject per-request auth that is invisible at
        // key-computation time, so dedupe must be disabled entirely.
        const client = new Client({
          apiKey: "k",
          onRequest: (_url, requestInit) => requestInit,
        });
        const p1 = client.threads.getState("t-hook");
        const p2 = client.threads.getState("t-hook");
        await tick();
        expect(expectedFetchMock).toHaveBeenCalledTimes(2);
        flush();
        await Promise.all([p1, p2]);
      });
    });

    describe("API key auto-load", () => {
      it("should auto-load API key from environment when apiKey is undefined", async () => {
        const getEnvSpy = vi
          .spyOn(envUtils, "getEnvironmentVariable")
          .mockImplementation((name: string) => {
            if (name === "LANGGRAPH_API_KEY") return "env-api-key";
            return undefined;
          });

        const client = new Client();
        await (client.threads as any).fetch("/test");

        expect(expectedFetchMock).toHaveBeenNthCalledWith(
          1,
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "env-api-key",
            }),
          })
        );

        const client2 = new Client({ apiKey: undefined });
        await (client2.threads as any).fetch("/test");

        expect(expectedFetchMock).toHaveBeenNthCalledWith(
          2,
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "env-api-key",
            }),
          })
        );

        getEnvSpy.mockRestore();
      });

      it("should skip API key auto-load when apiKey is null", async () => {
        const getEnvSpy = vi
          .spyOn(envUtils, "getEnvironmentVariable")
          .mockImplementation((name: string) => {
            if (name === "LANGGRAPH_API_KEY") return "env-api-key";
            return undefined;
          });

        const client = new Client({ apiKey: null });
        await (client.threads as any).fetch("/test");

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.not.objectContaining({
              "x-api-key": expect.anything(),
            }),
          })
        );

        getEnvSpy.mockRestore();
      });

      it("should use explicit API key when provided as a string", async () => {
        const getEnvSpy = vi
          .spyOn(envUtils, "getEnvironmentVariable")
          .mockImplementation((name: string) => {
            if (name === "LANGGRAPH_API_KEY") return "env-api-key";
            return undefined;
          });

        const client = new Client({
          apiKey: "explicit-api-key",
        });
        await (client.threads as any).fetch("/test");

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "explicit-api-key",
            }),
          })
        );

        getEnvSpy.mockRestore();
      });
    });
  }
);

describe("identifier path encoding", () => {
  interface RecordedRequest {
    method: string;
    pathname: string;
    search: string;
    apiKey: string | null;
  }

  const origin = "http://localhost:2024";
  let requests: RecordedRequest[];
  let fetchMock: MockFetch;

  // `fetch` receives the URL after `new URL()` has resolved dot segments,
  // so asserting here covers what would reach the server.
  beforeEach(() => {
    requests = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push({
        method: init?.method ?? "GET",
        pathname: url.pathname,
        search: url.search,
        apiKey: new Headers(init?.headers).get("x-api-key"),
      });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as MockFetch;
    overrideFetchImplementation(fetchMock);
  });

  function lastRequest(): RecordedRequest {
    expect(requests).toHaveLength(1);
    return requests[0];
  }

  it("threads.get cannot escape to /assistants", async () => {
    const client = new Client({ apiUrl: origin, apiKey: "secret" });
    await client.threads.get("../assistants/abc").catch(() => {});

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.pathname.startsWith("/threads/")).toBe(true);
    expect(req.pathname).not.toBe("/assistants/abc");
  });

  it("threads.get cannot read the store or inject a query string", async () => {
    const client = new Client({ apiUrl: origin, apiKey: "secret" });
    await client.threads
      .get("../store/items?namespace=x&key=y")
      .catch(() => {});

    const req = lastRequest();
    expect(req.pathname.startsWith("/threads/")).toBe(true);
    expect(req.pathname).not.toContain("/store/");
    expect(req.search).toBe("");
  });

  it("threads.delete cannot become DELETE /assistants/A?delete_threads=true", async () => {
    const client = new Client({ apiUrl: origin, apiKey: "secret" });
    await client.threads
      .delete("../assistants/A?delete_threads=true")
      .catch(() => {});

    const req = lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.pathname.startsWith("/threads/")).toBe(true);
    expect(req.pathname).not.toContain("/assistants/");
    expect(req.search).not.toContain("delete_threads=true");
  });

  it("assistants.delete keeps the SDK-controlled query string", async () => {
    const client = new Client({ apiUrl: origin, apiKey: "secret" });
    await client.assistants
      .delete("A?delete_threads=true&x=")
      .catch(() => {});

    const req = lastRequest();
    expect(req.pathname.startsWith("/assistants/")).toBe(true);
    expect(new URLSearchParams(req.search).getAll("delete_threads")).toEqual([
      "false",
    ]);
  });

  it("runs.get cannot escape via runId", async () => {
    const client = new Client({ apiUrl: origin, apiKey: "secret" });
    await client.runs.get("t1", "../../../assistants/abc").catch(() => {});

    const req = lastRequest();
    expect(req.pathname.startsWith("/threads/t1/runs/")).toBe(true);
  });

  it("crons.delete cannot escape via cronId", async () => {
    const client = new Client({ apiUrl: origin, apiKey: "secret" });
    await client.crons.delete("../../assistants/abc").catch(() => {});

    const req = lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.pathname.startsWith("/runs/crons/")).toBe(true);
  });

  it("rejects all-dot identifiers without sending a request", async () => {
    const client = new Client({ apiUrl: origin, apiKey: "secret" });
    await expect(client.threads.get("..")).rejects.toThrow(
      /Invalid path segment/
    );
    await expect(client.threads.get(".")).rejects.toThrow(
      /Invalid path segment/
    );
    expect(requests).toHaveLength(0);
  });

  it("cannot escape an apiUrl path prefix", async () => {
    const client = new Client({
      apiUrl: `${origin}/langgraph`,
      apiKey: "secret",
    });
    await client.threads.get("../../admin/secrets").catch(() => {});

    const req = lastRequest();
    expect(req.pathname.startsWith("/langgraph/threads/")).toBe(true);
  });

  it("SSE transport cannot escape via threadId", async () => {
    const transport = new ProtocolSseTransportAdapter({
      apiUrl: origin,
      threadId: "../assistants/abc",
      fetch: fetchMock,
      maxReconnectAttempts: 0,
    });
    await transport.getState().catch(() => {});
    await transport.close();

    const req = lastRequest();
    expect(req.pathname.startsWith("/threads/")).toBe(true);
    expect(req.pathname.endsWith("/state")).toBe(true);
    expect(req.pathname).not.toContain("/assistants/");
  });

  it("WebSocket transport cannot escape via threadId", async () => {
    const urls: string[] = [];
    const transport = new ProtocolWebSocketTransportAdapter({
      apiUrl: origin,
      threadId: "../assistants/abc?x=1",
      webSocketFactory: (url) => {
        urls.push(url);
        throw new Error("stop");
      },
    });
    await transport.open().catch(() => {});
    await transport.close().catch(() => {});

    expect(urls).toHaveLength(1);
    const { pathname } = new URL(urls[0]);
    expect(pathname.startsWith("/threads/")).toBe(true);
    expect(pathname.endsWith("/stream/events")).toBe(true);
    expect(pathname).not.toContain("/assistants/");
  });

  it("encoded identifiers still round-trip to the intended route", async () => {
    const client = new Client({ apiUrl: origin, apiKey: "secret" });
    await client.threads.get("thread_123").catch(() => {});

    const req = lastRequest();
    expect(req.pathname).toBe("/threads/thread_123");
    expect(req.apiKey).toBe("secret");
  });
});

describe("defaultHeaders shared between clients", () => {
  let requests: { url: string; apiKey: string | null }[];
  let fetchMock: MockFetch;

  beforeEach(() => {
    requests = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        apiKey: new Headers(init?.headers).get("x-api-key"),
      });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as MockFetch;
    overrideFetchImplementation(fetchMock);
  });

  it("a later client's apiKey does not replace an earlier client's", async () => {
    const defaultHeaders = { "x-tenant": "shared" };
    const first = new Client({ apiKey: "key-A", defaultHeaders });
    new Client({ apiKey: "key-B", defaultHeaders });

    await first.threads.get("t");

    expect(requests.map((r) => r.apiKey)).toEqual(["key-A"]);
    expect(defaultHeaders).toEqual({ "x-tenant": "shared" });
  });

  it("a keyless client on another host does not send an earlier client's apiKey", async () => {
    const defaultHeaders = { "x-tenant": "shared" };
    new Client({ apiUrl: "https://mine.example", apiKey: "key-A", defaultHeaders });
    const other = new Client({
      apiUrl: "https://other.example",
      apiKey: null,
      defaultHeaders,
    });

    await other.threads.get("t");

    expect(requests).toEqual([
      { url: "https://other.example/threads/t", apiKey: null },
    ]);
  });
});
