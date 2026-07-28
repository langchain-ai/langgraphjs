import { describe, expect, it, vi } from "vitest";
import type { SubscribeParams } from "@langchain/protocol";

import { AsyncCaller } from "../../../utils/async_caller.js";
import { ProtocolSseTransportAdapter } from "./http.js";
import {
  LANGGRAPH_PROXY_API_URL,
  PROXIED_API_URL,
  THREAD_ID,
  createFetchRecorder,
  protocolSuccessResponse,
} from "./test-helpers.js";

type MockFetch = ReturnType<typeof vi.fn> & typeof fetch;

function streamEventBodies(fetchImpl: MockFetch): Record<string, unknown>[] {
  return fetchImpl.mock.calls
    .filter((call: unknown[]) => String(call[0]).includes("/stream/events"))
    .map((call: unknown[]) => {
      const init = call[1] as RequestInit | undefined;
      return init?.body != null
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
    })
    .filter((body): body is Record<string, unknown> => body != null);
}

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
      // Fail-fast mock: custom fetch keeps reconnect on by default.
      maxReconnectAttempts: 0,
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

describe("ProtocolSseTransportAdapter SSE reconnect with custom fetch", () => {
  it("reconnects after a mid-stream failure when a custom auth fetch is supplied", async () => {
    let streamOpens = 0;
    const onReconnect = vi.fn();
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn((input: URL | RequestInfo) => {
      if (!String(input).includes("/stream/events")) {
        return Promise.resolve(protocolSuccessResponse());
      }
      streamOpens += 1;
      if (streamOpens === 1) {
        // First open fails after headers — auth-shim browsers hit the same
        // class of transport error (QUIC / idle proxy drop).
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'event: values\ndata: {"type":"event","method":"values","seq":1,"event_id":"e1"}\n\n'
                  )
                );
                // Defer the failure so e1 can flush through the SSE decoder
                // before the reconnect loop starts.
                setTimeout(() => {
                  controller.error(
                    new TypeError("net::ERR_QUIC_PROTOCOL_ERROR")
                  );
                }, 10);
              },
            }),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }
          )
        );
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: values\ndata: {"type":"event","method":"values","seq":2,"event_id":"e2"}\n\n'
                )
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }
        )
      );
    }) as MockFetch;

    const transport = new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: THREAD_ID,
      fetch: fetchImpl,
      maxReconnectAttempts: 3,
      reconnectDelayMs: () => 0,
      onReconnect,
      idleReconnect: 0,
    });

    const handle = transport.openEventStream({ channels: ["values"] });
    await handle.ready;

    const received: Array<{ event_id?: string; seq?: number }> = [];
    for await (const message of handle.events) {
      received.push(message as { event_id?: string; seq?: number });
      if (received.some((m) => m.event_id === "e2")) break;
    }

    expect(received.map((m) => m.event_id)).toContain("e2");
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(streamOpens).toBe(2);

    const streamBodies = streamEventBodies(fetchImpl);
    expect(streamBodies).toHaveLength(2);
    expect(streamBodies[0]).not.toHaveProperty("since");
    expect(streamBodies[1]).not.toHaveProperty("since");

    await transport.close();
  });

  it("honors caller since on the initial open but omits it on reconnect", async () => {
    let streamOpens = 0;
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn((input: URL | RequestInfo) => {
      if (!String(input).includes("/stream/events")) {
        return Promise.resolve(protocolSuccessResponse());
      }
      streamOpens += 1;
      if (streamOpens === 1) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'event: values\ndata: {"type":"event","method":"values","seq":6,"event_id":"e6"}\n\n'
                  )
                );
                setTimeout(() => {
                  controller.error(
                    new TypeError("net::ERR_QUIC_PROTOCOL_ERROR")
                  );
                }, 10);
              },
            }),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }
          )
        );
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: values\ndata: {"type":"event","method":"values","seq":1,"event_id":"e1"}\n\n'
                )
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }
        )
      );
    }) as MockFetch;

    const transport = new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: THREAD_ID,
      fetch: fetchImpl,
      maxReconnectAttempts: 3,
      reconnectDelayMs: () => 0,
      idleReconnect: 0,
    });

    const handle = transport.openEventStream({
      channels: ["values"],
      since: 5,
    } as SubscribeParams & { since: number });
    await handle.ready;

    const received: Array<{ event_id?: string }> = [];
    for await (const message of handle.events) {
      received.push(message as { event_id?: string });
      if (received.some((m) => m.event_id === "e1")) break;
    }

    const streamBodies = streamEventBodies(fetchImpl);
    expect(streamBodies).toHaveLength(2);
    expect(streamBodies[0]).toMatchObject({ since: 5 });
    expect(streamBodies[1]).not.toHaveProperty("since");
    expect(received.map((m) => m.event_id)).toEqual(
      expect.arrayContaining(["e6", "e1"])
    );

    await transport.close();
  });

  it("keeps caller since across pre-ready fetch failures", async () => {
    let streamOpens = 0;
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn((input: URL | RequestInfo) => {
      if (!String(input).includes("/stream/events")) {
        return Promise.resolve(protocolSuccessResponse());
      }
      streamOpens += 1;
      if (streamOpens === 1) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: values\ndata: {"type":"event","method":"values","seq":6,"event_id":"e6"}\n\n'
                )
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }
        )
      );
    }) as MockFetch;

    const transport = new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: THREAD_ID,
      fetch: fetchImpl,
      maxReconnectAttempts: 3,
      reconnectDelayMs: () => 0,
      idleReconnect: 0,
    });

    const handle = transport.openEventStream({
      channels: ["values"],
      since: 5,
    } as SubscribeParams & { since: number });
    await handle.ready;

    const received: Array<{ event_id?: string }> = [];
    for await (const message of handle.events) {
      received.push(message as { event_id?: string });
      if (received.some((m) => m.event_id === "e6")) break;
    }

    const streamBodies = streamEventBodies(fetchImpl);
    expect(streamBodies.length).toBeGreaterThanOrEqual(1);
    for (const body of streamBodies) {
      expect(body).toMatchObject({ since: 5 });
    }
    expect(received.map((m) => m.event_id)).toContain("e6");

    await transport.close();
  });

  it("keeps reconnect disabled when maxReconnectAttempts is explicitly 0", async () => {
    const sentinel = new TypeError("net::ERR_QUIC_PROTOCOL_ERROR");
    let streamOpens = 0;
    const fetchImpl = vi.fn(() => {
      streamOpens += 1;
      return Promise.reject(sentinel);
    }) as MockFetch;

    const transport = new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: THREAD_ID,
      fetch: fetchImpl,
      maxReconnectAttempts: 0,
      idleReconnect: 0,
    });

    const handle = transport.openEventStream({ channels: ["values"] });
    await expect(handle.ready).rejects.toBe(sentinel);
    expect(streamOpens).toBe(1);
    handle.close();
  });
});
