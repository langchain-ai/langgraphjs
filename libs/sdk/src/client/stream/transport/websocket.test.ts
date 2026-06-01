import { describe, expect, it } from "vitest";

import { ProtocolWebSocketTransportAdapter } from "./websocket.js";
import {
  PROXIED_API_URL,
  THREAD_ID,
  createWebSocketUrlRecorder,
} from "./test-helpers.js";

describe("ProtocolWebSocketTransportAdapter URL resolution", () => {
  it("preserves apiUrl path prefix when opening the stream socket", async () => {
    const { calls, webSocketFactory, sentinel } = createWebSocketUrlRecorder();
    const transport = new ProtocolWebSocketTransportAdapter({
      apiUrl: PROXIED_API_URL,
      threadId: THREAD_ID,
      webSocketFactory,
    });

    await expect(transport.open()).rejects.toBe(sentinel);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      `ws://localhost:4100/api/chat-langchain/threads/${THREAD_ID}/stream/events`
    );
  });

  it("preserves custom stream paths under a proxied apiUrl", async () => {
    const customStreamPath = `/threads/${THREAD_ID}/stream/events`;
    const { calls, webSocketFactory, sentinel } = createWebSocketUrlRecorder();
    const transport = new ProtocolWebSocketTransportAdapter({
      apiUrl: PROXIED_API_URL,
      threadId: THREAD_ID,
      paths: { stream: customStreamPath },
      webSocketFactory,
    });

    await expect(transport.open()).rejects.toBe(sentinel);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      `ws://localhost:4100/api/chat-langchain${customStreamPath}`
    );
  });
});
