import { describe, expect, it } from "vitest";

import { ProtocolSseTransportAdapter } from "./http.js";
import {
  LANGGRAPH_PROXY_API_URL,
  PROXIED_API_URL,
  THREAD_ID,
  createFetchRecorder,
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
});
