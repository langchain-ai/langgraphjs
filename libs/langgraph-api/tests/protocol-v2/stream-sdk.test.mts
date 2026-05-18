/**
 * Integration tests verifying that the SDK's ThreadStream projections
 * (`thread.values`, `thread.toolCalls`, `thread.messages`, etc.) work
 * end-to-end against the embed server over real HTTP/SSE.
 */
import type { Server } from "node:http";
import { v7 as uuidv7 } from "uuid";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  it,
  expect,
} from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  MemorySaver,
  type CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import {
  ProtocolSseTransportAdapter,
  ThreadStream,
} from "@langchain/langgraph-sdk";
import type { Pregel } from "@langchain/langgraph";

import {
  createEmbedServer,
  type ThreadSaver,
} from "../../src/experimental/embed.mjs";
import { graph as agent } from "../graphs/agent.mjs";
import { graph as agentWithToolsGraph } from "../graphs/agent_with_tools.mjs";
import { graph as agentWithStatsGraph } from "../graphs/agent_with_stats.mjs";

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
      agent_with_stats:
        agentWithStatsGraph as unknown as Pregel<any, any, any, any, any>,
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

function createThread(assistantId: string): ThreadStream {
  const threadId = uuidv7();
  const transport = new ProtocolSseTransportAdapter({
    apiUrl: serverUrl,
    threadId,
  });
  return new ThreadStream(transport, { assistantId });
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
        setTimeout(
          () => resolve({ done: true, value: undefined as T }),
          Math.max(0, deadline - Date.now())
        )
      ),
    ]);
    if (result.done) break;
    items.push(result.value);
  }

  return items;
}

/**
 * Run a graph and wait for events to settle, then close the thread.
 */
async function runAndCollect<T>(
  thread: ThreadStream,
  iterable: AsyncIterable<T>,
  input: Record<string, unknown>,
  config?: Record<string, unknown>
): Promise<T[]> {
  await thread.run.start({ input, config });

  const items = await collectWithTimeout(iterable, 15000);
  await thread.close();
  return items;
}

describe("SDK streaming projections against embed server", () => {
  describe("thread.values", () => {
    it("receives state snapshots from a simple agent run", async () => {
      const thread = createThread("agent");

      const snapshots = await runAndCollect(
        thread,
        thread.values,
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

  describe("thread.toolCalls", () => {
    it("receives assembled tool calls from an agent with tools", async () => {
      const thread = createThread("agent_with_tools");

      const toolCalls = await runAndCollect(
        thread,
        thread.toolCalls,
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

  describe("raw subscribe (messages channel)", () => {
    it("receives raw messages events from the agent graph", async () => {
      const thread = createThread("agent");

      const sub = await thread.subscribe({ channels: ["messages"] });
      const events = await runAndCollect(
        thread,
        sub,
        { messages: [{ role: "user", content: "hello" }] },
        { configurable: { user_id: "test-raw-messages" } }
      );

      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.method === "messages")).toBe(true);
      const lifecycle = events.map(
        (e) => (e.params as { data: { event?: string } }).data
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

  describe("raw subscribe (values channel)", () => {
    it("receives raw protocol events on the values channel", async () => {
      const thread = createThread("agent");

      const sub = await thread.subscribe({ channels: ["values"] });
      const events = await runAndCollect(
        thread,
        sub,
        { messages: [{ role: "user", content: "should_end" }] },
        { configurable: { user_id: "test-raw" } }
      );

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].method).toBe("values");
    });
  });

  describe("thread.extensions (final-value transformers)", () => {
    it("resolves final-value transformer projections remotely", async () => {
      const thread = createThread(
        "agent_with_stats"
      ) as ThreadStream<{
        toolCallCount: number;
        totalTokens: number;
      }>;

      await thread.run.start({
        input: {
          messages: [{ role: "user", content: "What is the weather in SF?" }],
        },
      });

      // Drive the run to completion via the values projection so that
      // by the time we touch `.extensions.*` the server has buffered
      // every `custom:<name>` event emitted by the final-value flush.
      await collectWithTimeout(thread.values, 15000);

      // Lazy access AFTER the run has ended — the SDK opens a single
      // shared `custom` subscription and relies on server replay to
      // deliver the buffered final-value events. Specific counts
      // depend on the graph shape; the important invariant is that
      // the handles resolve to *something* (not `undefined`), proving
      // the mux → server buffer → client replay → dispatcher pipeline.
      await expect(thread.extensions.toolCallCount).resolves.toBeTypeOf(
        "number"
      );
      await expect(thread.extensions.totalTokens).resolves.toBeTypeOf(
        "number"
      );

      await thread.close();
    });
  });

  describe("run.start forkFrom", () => {
    it("branches checkpoint history from the provided checkpoint id", async () => {
      // Uses `agent_with_tools` because it is compiled synchronously
      // (the `agent` graph is exported as a Promise, which bypasses
      // the embed server's `targetGraph.checkpointer = ...` injection
      // and leaves MemorySaver empty for runs against it). The
      // deterministic tool-calling agent here produces a reliable
      // multi-checkpoint history without relying on a fake model's
      // mutable response counter.
      const thread = createThread("agent_with_tools");
      const { threadId } = thread;

      await runAndCollect(thread, thread.values, {
        messages: [{ role: "user", content: "What is the weather in SF?" }],
      });

      const listTuples = async (): Promise<CheckpointTuple[]> => {
        const out: CheckpointTuple[] = [];
        for await (const tuple of checkpointer.list({
          configurable: { thread_id: threadId },
        })) {
          out.push(tuple);
        }
        return out;
      };

      const baseline = await listTuples();
      // Expect at least the root input checkpoint and one loop
      // checkpoint after the agent node. MemorySaver.list is sorted
      // newest-first, so the root (no parent) is the last entry.
      expect(baseline.length).toBeGreaterThanOrEqual(2);
      const root = baseline[baseline.length - 1];
      expect(root.parentConfig).toBeUndefined();
      const rootCheckpointId = root.checkpoint.id;

      // Fork a new run from the root checkpoint on the same thread.
      // A fresh `ThreadStream` is required because `runAndCollect`
      // closed the previous one.
      const forked = new ThreadStream(
        new ProtocolSseTransportAdapter({ apiUrl: serverUrl, threadId }),
        { assistantId: "agent_with_tools" }
      );

      // `forkFrom` is not part of the protocol's stock `RunStartParams`
      // type yet (it's an SDK-side convenience consumed by the service
      // layer), so we cast to reach the wider shape the server accepts.
      await (
        forked.run.start as (params: unknown) => Promise<unknown>
      )({
        input: { messages: [{ role: "user", content: "What is the weather in SF?" }] },
        forkFrom: { checkpointId: rootCheckpointId },
      });
      await collectWithTimeout(forked.values, 15000);
      await forked.close();

      const afterFork = await listTuples();

      // Before the fix, `forkFrom` was silently dropped, so the second
      // run would chain off the latest checkpoint instead of the root
      // and only the original loop checkpoint would claim the root as
      // its parent. Honoring `forkFrom` means a *second* checkpoint
      // (the forked run's input checkpoint) also descends directly
      // from the root, giving us at least two root children.
      const childrenOfRoot = afterFork.filter(
        (t) => t.parentConfig?.configurable?.checkpoint_id === rootCheckpointId
      );
      // With `forkFrom` honored, the fork-run's input checkpoint
      // descends directly from the root, alongside the original
      // loop checkpoint. If the server silently dropped `forkFrom`
      // (the pre-fix behavior), only the original entry would
      // claim the root as its parent and this assertion would fail.
      expect(childrenOfRoot.length).toBeGreaterThanOrEqual(2);
    });
  });
});
