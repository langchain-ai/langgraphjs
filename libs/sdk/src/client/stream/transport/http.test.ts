import { describe, expect, it, vi } from "vitest";

import { AsyncCaller } from "../../../utils/async_caller.js";
import { ProtocolSseTransportAdapter } from "./http.js";
import {
  LANGGRAPH_PROXY_API_URL,
  PROXIED_API_URL,
  THREAD_ID,
  createFetchRecorder,
  protocolSuccessResponse,
} from "./test-helpers.js";

describe("ProtocolSseTransportAdapter URL resolution", () => {
  it("preserves apiUrl path prefix for protocol commands", async () => {
    const { calls, fetch } = createFetchRecorder();
    const transport = new ProtocolSseTransportAdapter({
      apiUrl: PROXIED_API_URL,
      threadId: THREAD_ID,
      fetch,
    });

    await transport.send({
      id: 1,
      method: "state.get",
      params: { namespace: [] },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].href).toBe(
      `${PROXIED_API_URL}/threads/${THREAD_ID}/commands`
    );
  });

  it("preserves apiUrl path prefix for stream event subscriptions", async () => {
    const sentinel = new Error("stream-open");
    const { calls, fetch } = createFetchRecorder({ error: sentinel });
    const transport = new ProtocolSseTransportAdapter({
      apiUrl: PROXIED_API_URL,
      threadId: THREAD_ID,
      fetch,
    });

    const handle = transport.openEventStream({ channels: ["values"] });
    await expect(handle.ready).rejects.toBe(sentinel);

    expect(calls).toHaveLength(1);
    expect(calls[0].href).toBe(
      `${PROXIED_API_URL}/threads/${THREAD_ID}/stream/events`
    );
    handle.close();
  });

  it("preserves custom command and stream paths under a proxied apiUrl", async () => {
    const { calls, fetch } = createFetchRecorder();
    const transport = new ProtocolSseTransportAdapter({
      apiUrl: LANGGRAPH_PROXY_API_URL,
      threadId: THREAD_ID,
      fetch,
      paths: {
        commands: `/threads/${THREAD_ID}/commands`,
        stream: `/threads/${THREAD_ID}/stream/events`,
      },
    });

    await transport.send({
      id: 1,
      method: "state.get",
      params: { namespace: [] },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].href).toBe(
      `${LANGGRAPH_PROXY_API_URL}/threads/${THREAD_ID}/commands`
    );
  });

  it("fetches thread state with GET for hydration", async () => {
    const calls: Array<{ href: string; method?: string }> = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ href, method: init?.method });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            values: { messages: [] },
            next: [],
            tasks: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    };
    const transport = new ProtocolSseTransportAdapter({
      apiUrl: PROXIED_API_URL,
      threadId: THREAD_ID,
      fetch,
      paths: {
        state: `/threads/${THREAD_ID}/state`,
      },
    });

    const state = await transport.getState();
    expect(state?.values).toEqual({ messages: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.href).toBe(
      `${PROXIED_API_URL}/threads/${THREAD_ID}/state`
    );
  });

  it("returns null when thread state is missing", async () => {
    const { fetch } = createFetchRecorder({
      response: new Response("not found", { status: 404 }),
    });
    const transport = new ProtocolSseTransportAdapter({
      apiUrl: PROXIED_API_URL,
      threadId: THREAD_ID,
      fetch,
    });

    await expect(transport.getState()).resolves.toBeNull();
  });
});

describe("ProtocolSseTransportAdapter thread binding", () => {
  it("binds lazily via setThreadId when constructed without a threadId", async () => {
    const { calls, fetch } = createFetchRecorder();
    const transport = new ProtocolSseTransportAdapter({
      apiUrl: PROXIED_API_URL,
      fetch,
    });

    transport.setThreadId(THREAD_ID);
    await transport.send({ id: 1, method: "state.get", params: { namespace: [] } });

    expect(transport.threadId).toBe(THREAD_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0].href).toBe(
      `${PROXIED_API_URL}/threads/${THREAD_ID}/commands`
    );
  });

  it("follows setThreadId re-binds for commands and state", async () => {
    const calls: Array<string> = [];
    const fetch: typeof globalThis.fetch = (input) => {
      const href = typeof input === "string" ? input : input.toString();
      calls.push(href);
      // `/commands` expects a protocol response; `/state` a state body.
      if (href.endsWith("/state")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ values: { messages: [] }, next: [], tasks: [] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.resolve(protocolSuccessResponse());
    };
    const transport = new ProtocolSseTransportAdapter({
      apiUrl: PROXIED_API_URL,
      threadId: "thread-a",
      fetch,
    });

    await transport.send({ id: 1, method: "state.get", params: { namespace: [] } });
    transport.setThreadId("thread-b");
    await transport.send({ id: 2, method: "state.get", params: { namespace: [] } });
    await transport.getState();

    expect(calls).toEqual([
      `${PROXIED_API_URL}/threads/thread-a/commands`,
      `${PROXIED_API_URL}/threads/thread-b/commands`,
      `${PROXIED_API_URL}/threads/thread-b/state`,
    ]);
  });

  it("resolves function paths against the currently-bound thread", async () => {
    const { calls, fetch } = createFetchRecorder();
    const transport = new ProtocolSseTransportAdapter({
      apiUrl: PROXIED_API_URL,
      fetch,
      paths: { commands: (id) => `/sessions/${id}/cmd` },
    });

    transport.setThreadId("thread-z");
    await transport.send({ id: 1, method: "state.get", params: { namespace: [] } });

    expect(calls[0].href).toBe(`${PROXIED_API_URL}/sessions/thread-z/cmd`);
  });

  it("throws a helpful error when a command is sent before binding a thread", async () => {
    const { calls, fetch } = createFetchRecorder();
    const transport = new ProtocolSseTransportAdapter({
      apiUrl: PROXIED_API_URL,
      fetch,
    });

    await expect(
      transport.send({ id: 1, method: "state.get", params: { namespace: [] } })
    ).rejects.toThrow(/no bound threadId/);
    expect(calls).toHaveLength(0);
  });
});

describe("ProtocolSseTransportAdapter AsyncCaller", () => {
  it("retries transient command failures when asyncCaller is provided", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(() => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.resolve(
          new Response("unavailable", { status: 503, statusText: "Unavailable" })
        );
      }
      return Promise.resolve(protocolSuccessResponse());
    }) as typeof fetch;

    const transport = new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: THREAD_ID,
      fetch: fetchImpl,
      asyncCaller: new AsyncCaller({ maxRetries: 4, maxConcurrency: 1 }),
    });

    await transport.send({
      id: 1,
      method: "state.get",
      params: { namespace: [] },
    });

    expect(attempts).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable status codes when asyncCaller is provided", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response("not found", { status: 404, statusText: "Not Found" })
      )
    ) as typeof fetch;

    const transport = new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: THREAD_ID,
      fetch: fetchImpl,
      asyncCaller: new AsyncCaller({ maxRetries: 4, maxConcurrency: 1 }),
    });

    await expect(
      transport.send({
        id: 1,
        method: "state.get",
        params: { namespace: [] },
      })
    ).rejects.toThrow(/HTTP 404/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("routes commands through asyncCaller but bypasses it for the SSE event stream", async () => {
    // Long-lived event streams must not run through AsyncCaller (its
    // p-queue/p-retry semantics stall a streaming response). Commands must
    // still go through it for retry/backoff parity with REST.
    const sseFrame =
      'event: values\ndata: {"type":"event","method":"values","seq":1,"event_id":"e1"}\n\n';
    const fetchImpl = vi.fn((input: URL | RequestInfo) => {
      if (String(input).includes("/stream/events")) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(sseFrame));
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } }
          )
        );
      }
      return Promise.resolve(protocolSuccessResponse());
    }) as unknown as typeof fetch;

    const asyncCaller = new AsyncCaller({ maxRetries: 0, maxConcurrency: 1 });
    const callSpy = vi.spyOn(asyncCaller, "call");

    const transport = new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: THREAD_ID,
      fetch: fetchImpl,
      asyncCaller,
    });

    await transport.send({ id: 1, method: "state.get", params: { namespace: [] } });
    expect(callSpy).toHaveBeenCalledTimes(1);

    const callsAfterCommand = callSpy.mock.calls.length;

    const handle = transport.openEventStream({ channels: ["values"] });
    await handle.ready;
    const iterator = handle.events[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value).toMatchObject({ event_id: "e1", seq: 1 });
    // The event stream must NOT have gone through asyncCaller.
    expect(callSpy.mock.calls.length).toBe(callsAfterCommand);

    await transport.close();
  });
});
