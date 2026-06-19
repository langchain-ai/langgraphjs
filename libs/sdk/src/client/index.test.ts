import { describe, expect, it } from "vitest";

import { Client } from "./index.js";
import { ThreadStream } from "./stream/index.js";
import { HttpAgentServerAdapter } from "./stream/transport/agent-server.js";
import { ProtocolSseTransportAdapter } from "./stream/transport/http.js";
import {
  PROXIED_API_URL,
  THREAD_ID,
  createFetchRecorder,
  createWebSocketUrlRecorder,
} from "./stream/transport/test-helpers.js";

describe("Client", () => {
  it("exposes sub-clients on main Client", () => {
    const client = new Client({
      apiUrl: "http://localhost:9999",
      apiKey: null,
    });

    expect(client.assistants).toBeDefined();
    expect(client.threads).toBeDefined();
    expect(client.runs).toBeDefined();
    expect(client.crons).toBeDefined();
    expect(client.store).toBeDefined();
  });

  it("threads.stream returns a ThreadStream bound to an existing thread ID", () => {
    const client = new Client({
      apiUrl: "http://localhost:9999",
      apiKey: null,
    });

    const thread = client.threads.stream("my-thread", {
      assistantId: "my-agent",
    });
    expect(thread).toBeInstanceOf(ThreadStream);
    expect(thread.threadId).toBe("my-thread");
    expect(thread.assistantId).toBe("my-agent");
  });

  it("threads.stream auto-generates a thread ID when called with options only", () => {
    const client = new Client({
      apiUrl: "http://localhost:9999",
      apiKey: null,
    });

    const thread = client.threads.stream({ assistantId: "my-agent" });
    expect(thread).toBeInstanceOf(ThreadStream);
    expect(thread.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(thread.assistantId).toBe("my-agent");
  });

  it("threads.stream forwards webSocketFactory to the websocket adapter", async () => {
    const client = new Client({
      apiUrl: "http://localhost:9999",
      apiKey: null,
    });

    const sentinel = new Error("sentinel-websocket-factory");
    const calls: string[] = [];
    const thread = client.threads.stream("my-thread", {
      assistantId: "my-agent",
      transport: "websocket",
      webSocketFactory: (url) => {
        calls.push(url);
        throw sentinel;
      },
    });

    await expect(thread.subscribe(["values"])).rejects.toBe(sentinel);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/threads/my-thread/stream/events");
  });

  it("threads.stream forwards fetch to the sse adapter", async () => {
    const client = new Client({
      apiUrl: "http://localhost:9999",
      apiKey: null,
    });

    const sentinel = new Error("sentinel-fetch");
    const calls: URL[] = [];
    const customFetch = ((input: URL | RequestInfo) => {
      calls.push(
        // oxlint-disable-next-line no-instanceof/no-instanceof
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url)
      );
      return Promise.reject(sentinel);
    }) as typeof fetch;

    const thread = client.threads.stream("my-thread", {
      assistantId: "my-agent",
      transport: "sse",
      fetch: customFetch,
    });

    await expect(thread.subscribe(["values"])).rejects.toBe(sentinel);
    expect(calls).toHaveLength(1);
    expect(calls[0].pathname).toContain("/threads/my-thread/stream/events");
  });

  it("uses the protocol commands path for sse commands", async () => {
    const { calls, fetch: customFetch } = createFetchRecorder();

    const transport = new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:9999",
      threadId: "my-thread",
      fetch: customFetch,
    });

    await transport.send({ id: 1, method: "state.get", params: { namespace: [] } });

    expect(calls).toHaveLength(1);
    expect(calls[0].pathname).toBe("/threads/my-thread/commands");
  });

  it("threads.stream preserves proxied apiUrl path prefix for sse subscriptions", async () => {
    const sentinel = new Error("sentinel-fetch");
    const { calls, fetch: customFetch } = createFetchRecorder({ error: sentinel });
    const client = new Client({
      apiUrl: PROXIED_API_URL,
      apiKey: null,
    });

    const thread = client.threads.stream(THREAD_ID, {
      assistantId: "docs_agent",
      transport: "sse",
      fetch: customFetch,
    });

    await expect(thread.subscribe(["values"])).rejects.toBe(sentinel);
    expect(calls).toHaveLength(1);
    expect(calls[0].href).toBe(
      `${PROXIED_API_URL}/threads/${THREAD_ID}/stream/events`
    );
  });

  it("threads.stream preserves proxied apiUrl path prefix for websocket subscriptions", async () => {
    const { calls, webSocketFactory, sentinel } = createWebSocketUrlRecorder();
    const client = new Client({
      apiUrl: PROXIED_API_URL,
      apiKey: null,
    });

    const thread = client.threads.stream(THREAD_ID, {
      assistantId: "docs_agent",
      transport: "websocket",
      webSocketFactory,
    });

    await expect(thread.subscribe(["values"])).rejects.toBe(sentinel);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      `ws://localhost:4100/api/chat-langchain/threads/${THREAD_ID}/stream/events`
    );
  });

  it("threads.stream binds a custom adapter to the requested thread via setThreadId", () => {
    const client = new Client({
      apiUrl: "http://localhost:9999",
      apiKey: null,
    });

    // Constructed unbound — the framework binds it to the thread passed to
    // threads.stream (the lazy-create seam).
    const adapter = new HttpAgentServerAdapter({
      apiUrl: "http://localhost:9999",
    });
    const thread = client.threads.stream("late-thread", {
      assistantId: "my-agent",
      transport: adapter,
    });

    expect(adapter.threadId).toBe("late-thread");
    expect(thread.threadId).toBe("late-thread");
  });

  it("threads.stream binds a custom adapter to an auto-generated thread id", () => {
    const client = new Client({
      apiUrl: "http://localhost:9999",
      apiKey: null,
    });

    const adapter = new HttpAgentServerAdapter({
      apiUrl: "http://localhost:9999",
    });
    const thread = client.threads.stream({
      assistantId: "my-agent",
      transport: adapter,
    });

    expect(adapter.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(thread.threadId).toBe(adapter.threadId);
  });
});
