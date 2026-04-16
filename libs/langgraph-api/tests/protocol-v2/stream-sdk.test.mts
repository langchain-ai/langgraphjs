/**
 * Integration tests verifying that the SDK's streaming subscription handles
 * (`subscribeTools`, `subscribeValues`, `subscribeStreamingMessages`)
 * work end-to-end against the embed server over real HTTP/SSE.
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import {
  ProtocolClient,
  ProtocolSseTransportAdapter,
  type Session,
} from "@langchain/langgraph-sdk";
import type { Pregel } from "@langchain/langgraph";

import {
  createEmbedServer,
  type ThreadSaver,
} from "../../src/experimental/embed.mjs";
import { graph as agent } from "../graphs/agent.mjs";
import { graph as agentWithToolsGraph } from "../graphs/agent_with_tools.mjs";


const threads = (() => {
  let store: Record<
    string,
    {
      thread_id: string;
      metadata: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
    }
  > = {};

  return {
    get: async (id: string) => store[id],
    set: async (
      threadId: string,
      {
        kind,
        metadata,
      }: { kind: "put" | "patch"; metadata?: Record<string, unknown> }
    ) => {
      const now = new Date();
      store[threadId] ??= {
        thread_id: threadId,
        metadata: {},
        created_at: now,
        updated_at: now,
      };
      store[threadId].updated_at = now;
      store[threadId].metadata = {
        ...(kind === "patch" && store[threadId].metadata),
        ...metadata,
      };
      return store[threadId];
    },
    delete: async (threadId: string) => void delete store[threadId],
    truncate: () => {
      store = {};
    },
  };
})() satisfies ThreadSaver & { truncate: () => void };

let serverUrl: string;
let httpServer: Server;
let checkpointer: MemorySaver;

beforeAll(async () => {
  checkpointer = new MemorySaver();

  const embedApp = createEmbedServer({
    graph: {
      agent: agent as unknown as Pregel<any, any, any, any, any>,
      agent_with_tools: agentWithToolsGraph,
    },
    checkpointer,
    threads,
  });

  const app = new Hono();
  app.route("/", embedApp);

  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      serverUrl = `http://localhost:${info.port}`;
      resolve();
    }) as Server;
  });
});

afterAll(() => {
  httpServer?.closeAllConnections();
  httpServer?.close();
});

beforeEach(() => {
  threads.truncate();
});

function createClient() {
  return new ProtocolClient(
    () => new ProtocolSseTransportAdapter({ apiUrl: serverUrl })
  );
}

/**
 * Collect items from an async iterable with a time limit.
 * Returns whatever has been collected when the timeout fires.
 */
async function collectWithTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs = 5000
): Promise<T[]> {
  const items: T[] = [];
  const iter = iterable[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await Promise.race([
      iter.next(),
      new Promise<IteratorResult<T>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined as T }), Math.max(0, deadline - Date.now()))
      ),
    ]);
    if (result.done) break;
    items.push(result.value);
  }

  return items;
}

/**
 * Run a graph and wait for events to settle, then close the session.
 */
async function runAndCollect<T>(
  session: Session,
  subscribe: () => Promise<AsyncIterable<T>>,
  input: Record<string, unknown>,
  config?: Record<string, unknown>
): Promise<T[]> {
  const iterable = await subscribe();
  await session.run.input({ input, config });

  const items = await collectWithTimeout(iterable, 15000);
  await session.close();
  return items;
}

describe("SDK streaming subscriptions against embed server", () => {
  describe("subscribe(\"values\")", () => {
    it("receives state snapshots from a simple agent run", async () => {
      const client = createClient();
      const session = await client.open({
        protocol_version: "0.3.0",
        target: { id: "agent" },
      });

      const snapshots = await runAndCollect(
        session,
        () => session.subscribe("values"),
        { messages: [{ role: "user", content: "should_end" }] },
        { configurable: { user_id: "test-values" } }
      );

      expect(snapshots.length).toBeGreaterThanOrEqual(1);

      const lastSnapshot = snapshots[snapshots.length - 1] as Record<
        string,
        unknown
      >;
      expect(lastSnapshot).toHaveProperty("messages");
      expect(Array.isArray(lastSnapshot.messages)).toBe(true);
    });
  });

  describe("subscribe(\"toolCalls\")", () => {
    it("receives assembled tool calls from an agent with tools", async () => {
      const client = createClient();
      const session = await client.open({
        protocol_version: "0.3.0",
        target: { id: "agent_with_tools" },
      });

      const toolCalls = await runAndCollect(
        session,
        () => session.subscribe("toolCalls"),
        { messages: [{ role: "user", content: "What is the weather in SF?" }] }
      );

      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      const weatherCall = toolCalls.find((tc) => tc.name === "weather");
      expect(weatherCall).toBeDefined();
      expect(weatherCall!.callId).toBe("call_embed_1");
      const input =
        typeof weatherCall!.input === "string"
          ? JSON.parse(weatherCall!.input)
          : weatherCall!.input;
      expect(input).toEqual({ query: "SF" });

      await expect(weatherCall!.output).resolves.toBeDefined();
      await expect(weatherCall!.status).resolves.toBe("finished");
      await expect(weatherCall!.error).resolves.toBeUndefined();
    });
  });

  describe("subscribe(\"messages\")", () => {
    it("receives raw messages events from the agent graph", async () => {
      const client = createClient();
      const session = await client.open({
        protocol_version: "0.3.0",
        target: { id: "agent" },
      });

      const events = await runAndCollect(
        session,
        () => session.subscribe({ channels: ["messages"] }),
        { messages: [{ role: "user", content: "hello" }] },
        { configurable: { user_id: "test-raw-messages" } }
      );

      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.method === "messages")).toBe(true);
      const lifecycle = events.map(
        (e) =>
          (e.params as { data: { event?: string } }).data
      );
      expect(lifecycle.some((m) => m.event === "message-start")).toBe(true);
      expect(
        lifecycle.some(
          (m) =>
            m.event === "content-block-start" ||
            m.event === "content-block-delta"
        )
      ).toBe(true);
    });
  });

  describe("raw subscribe (params form)", () => {
    it("receives raw protocol events on the values channel", async () => {
      const client = createClient();
      const session = await client.open({
        protocol_version: "0.3.0",
        target: { id: "agent" },
      });

      const events = await runAndCollect(
        session,
        () => session.subscribe({ channels: ["values"] }),
        { messages: [{ role: "user", content: "should_end" }] },
        { configurable: { user_id: "test-raw" } }
      );

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].method).toBe("values");
    });
  });
});
