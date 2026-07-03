import { describe, expect, it } from "vitest";

import { HttpAgentServerAdapter } from "./agent-server.js";
import {
  createFetchRecorder,
  createWebSocketUrlRecorder,
} from "./test-helpers.js";

describe("HttpAgentServerAdapter hydration", () => {
  it("exposes getState for the default SSE delegate", async () => {
    const { fetch } = createFetchRecorder({
      response: new Response(
        JSON.stringify({ values: { messages: [] }, next: [], tasks: [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    });
    const adapter = new HttpAgentServerAdapter({
      apiUrl: "http://localhost:4100/api",
      threadId: "thread-1",
      fetch,
    });

    expect(adapter.getState).toEqual(expect.any(Function));
    await expect(adapter.getState?.()).resolves.toEqual({
      values: { messages: [] },
      next: [],
      tasks: [],
    });
  });

  it("exposes hasActiveRun through the SSE delegate auth context", async () => {
    const calls: Array<{ href: string; headers: Headers }> = [];
    const fetch = (async (input, init) => {
      const href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ href, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify([{ status: "running" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const adapter = new HttpAgentServerAdapter({
      apiUrl: "http://localhost:4100/api",
      threadId: "thread-1",
      defaultHeaders: {
        authorization: "Bearer adapter-token",
      },
      onRequest: (_url, init) => {
        const headers = new Headers(init.headers);
        headers.set("x-request-hook", "yes");
        return { ...init, headers };
      },
      paths: {
        runs: (threadId) => `/sessions/${threadId}/runs`,
      },
      fetch,
    });

    expect(adapter.hasActiveRun).toEqual(expect.any(Function));
    await expect(adapter.hasActiveRun?.()).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].href).toBe(
      "http://localhost:4100/api/sessions/thread-1/runs?limit=1"
    );
    expect(calls[0].headers.get("authorization")).toBe("Bearer adapter-token");
    expect(calls[0].headers.get("x-request-hook")).toBe("yes");
  });

  it("omits getState for WebSocket delegates", () => {
    const { webSocketFactory } = createWebSocketUrlRecorder();
    const adapter = new HttpAgentServerAdapter({
      apiUrl: "http://localhost:4100/api",
      threadId: "thread-1",
      webSocketFactory,
    });

    expect(adapter.getState).toBeUndefined();
    expect(adapter.hasActiveRun).toBeUndefined();
  });
});

describe("HttpAgentServerAdapter thread binding", () => {
  it("binds the SSE delegate lazily via setThreadId", async () => {
    const { calls, fetch } = createFetchRecorder({
      response: new Response(
        JSON.stringify({ values: { messages: [] }, next: [], tasks: [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    });
    const adapter = new HttpAgentServerAdapter({
      apiUrl: "http://localhost:4100/api",
      fetch,
    });

    adapter.setThreadId("thread-late");
    expect(adapter.threadId).toBe("thread-late");

    await adapter.getState?.();
    expect(calls).toHaveLength(1);
    expect(calls[0].href).toBe(
      "http://localhost:4100/api/threads/thread-late/state"
    );
  });

  it("forwards setThreadId to the WebSocket delegate", async () => {
    const { calls, webSocketFactory, sentinel } = createWebSocketUrlRecorder();
    const adapter = new HttpAgentServerAdapter({
      apiUrl: "http://localhost:4100/api",
      webSocketFactory,
    });

    adapter.setThreadId("thread-ws");
    expect(adapter.threadId).toBe("thread-ws");

    await expect(adapter.open()).rejects.toBe(sentinel);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/threads/thread-ws/stream/events");
  });
});
