import { describe, expect, it } from "vitest";

import { Client } from "./index.js";
import { ThreadStream } from "./stream/index.js";
import { ProtocolSseTransportAdapter } from "./stream/transport/http.js";

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
    expect(calls[0]).toContain("/v2/threads/my-thread/stream");
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
    expect(calls[0].pathname).toContain("/v2/threads/my-thread/stream");
  });

  it("uses the v2 protocol commands path for sse commands", async () => {
    const calls: URL[] = [];
    const customFetch = ((input: URL | RequestInfo) => {
      calls.push(
        // oxlint-disable-next-line no-instanceof/no-instanceof
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url)
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: "success",
            id: 1,
            result: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    }) as typeof fetch;

    const transport = new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:9999",
      threadId: "my-thread",
      fetch: customFetch,
    });

    await transport.send({ id: 1, method: "state.get", params: { namespace: [] } });

    expect(calls).toHaveLength(1);
    expect(calls[0].pathname).toBe("/v2/threads/my-thread/commands");
  });
});
