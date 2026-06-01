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
});
