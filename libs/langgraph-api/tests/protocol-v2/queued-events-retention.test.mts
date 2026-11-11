/**
 * Regression tests for the embed protocol's per-thread replay buffer
 * (`EmbedThread.queuedEvents`).
 *
 * `createEmbedServer`'s protocol routes buffer every event of every run so a
 * late-attaching `/stream/events` subscriber can replay history it missed.
 * A thread whose graph never interrupts never clears that buffer, so it
 * grows for the life of the process. These tests exercise the
 * `maxQueuedEvents` option that caps it, and confirm that leaving it unset
 * preserves today's unbounded behavior exactly.
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { v7 as uuidv7 } from "@langchain/core/utils/uuid";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
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

// Every channel the embed protocol can emit on. Subscribing to all of them
// makes a subscriber's view equivalent to the raw, per-thread
// `queuedEvents` buffer instead of one filtered slice of it, which is what
// this test needs to reason about total buffer size and eviction order.
const ALL_CHANNELS = [
  "values",
  "updates",
  "checkpoints",
  "messages",
  "tools",
  "custom",
  "lifecycle",
  "input",
  "tasks",
] as const;

function createThreadSaver() {
  const store: Record<
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
  } satisfies ThreadSaver;
}

async function startEmbedServer(maxQueuedEvents?: number) {
  const embedApp = createEmbedServer({
    graph: { agent: agent as unknown as Pregel<any, any, any, any, any> },
    checkpointer: new MemorySaver(),
    threads: createThreadSaver(),
    maxQueuedEvents,
  });

  const app = new Hono();
  app.route("/", embedApp);

  let serverUrl = "";
  const httpServer = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, (info) => {
      serverUrl = `http://localhost:${info.port}`;
      resolve(s as Server);
    });
  });

  return {
    serverUrl,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}

function bindThread(serverUrl: string, threadId: string): ThreadStream {
  const transport = new ProtocolSseTransportAdapter({
    apiUrl: serverUrl,
    threadId,
  });
  return new ThreadStream(transport, { assistantId: "agent" });
}

/**
 * Pulls from `iterator` until either a new event arrives or `quietMs`
 * elapses with nothing pending, whichever comes first. Used to detect that
 * a run (or a whole run of turns) has settled without depending on
 * wall-clock sleeps sized to "long enough".
 */
async function nextOrQuiet<T>(
  iterator: AsyncIterator<T>,
  quietMs: number
): Promise<{ value: T; done?: false } | { done: true }> {
  return Promise.race([
    iterator.next().then((result) =>
      result.done ? ({ done: true } as const) : { value: result.value }
    ),
    new Promise<{ done: true }>((resolve) =>
      setTimeout(() => resolve({ done: true }), quietMs)
    ),
  ]);
}

async function drainUntilQuiet<T>(
  iterator: AsyncIterator<T>,
  quietMs: number
): Promise<T[]> {
  const items: T[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await nextOrQuiet(iterator, quietMs);
    if (result.done) break;
    items.push(result.value);
  }
  return items;
}

/**
 * Runs `turnCount` sequential, non-interrupting turns against `threadId`,
 * subscribed to every channel from before the first turn starts, and
 * returns every event observed live, in order. The graph used here
 * (`agent`) checks only the *first* human message to decide whether to
 * end, so every subsequent turn also ends immediately after a single
 * model call — no interrupts, ever.
 */
async function runTurnsAndCollectLive(
  serverUrl: string,
  threadId: string,
  turnCount: number
): Promise<unknown[]> {
  const driver = bindThread(serverUrl, threadId);
  const subscription = await driver.subscribe({ channels: ALL_CHANNELS });
  const iterator = subscription[Symbol.asyncIterator]();

  const observed: unknown[] = [];
  for (let turn = 0; turn < turnCount; turn += 1) {
    await driver.run.start({
      input: {
        messages: [
          { role: "user", content: turn === 0 ? "should_end" : `turn-${turn}` },
        ],
      },
      config: { configurable: { user_id: "queued-events-retention" } },
    });

    // Drain this turn's events until the stream goes quiet, i.e. the run
    // has finished and there is nothing left in flight, before starting
    // the next turn.
    observed.push(...(await drainUntilQuiet(iterator, 300)));
  }

  await subscription.unsubscribe();
  await driver.close();
  return observed;
}

/**
 * Projects an event down to its stable wire identity (`event_id`/`seq`/
 * `method`/`namespace`). Comparisons in this file use this projection
 * rather than full deep equality: the SDK's `ThreadStream` hydrates
 * `values`/`messages` payloads into richer message objects, and that
 * hydration is not guaranteed to be byte-identical between a sink that
 * received events live versus one that received them via replay (e.g.
 * derived fields like `contentBlocks` are filled in lazily). That
 * hydration difference is orthogonal to what this test is verifying:
 * that the *set and order* of buffered events is preserved (or capped),
 * not the client's in-memory message representation of them.
 */
function identify(events: unknown[]) {
  return events.map((event) => {
    const e = event as {
      event_id?: string;
      seq?: number;
      method?: string;
      params?: { namespace?: string[] };
    };
    return {
      event_id: e.event_id,
      seq: e.seq,
      method: e.method,
      namespace: e.params?.namespace,
    };
  });
}

/** Attaches fresh (a "late subscriber") and drains whatever replays. */
async function lateSubscribeAndCollect(
  serverUrl: string,
  threadId: string
): Promise<unknown[]> {
  const late = bindThread(serverUrl, threadId);
  const subscription = await late.subscribe({ channels: ALL_CHANNELS });
  const iterator = subscription[Symbol.asyncIterator]();

  const replayed = await drainUntilQuiet(iterator, 500);

  await subscription.unsubscribe();
  await late.close();
  return replayed;
}

describe("embed protocol queued-events retention", () => {
  describe("maxQueuedEvents unset (default)", () => {
    let server: Awaited<ReturnType<typeof startEmbedServer>>;

    beforeAll(async () => {
      server = await startEmbedServer(undefined);
    }, 30_000);

    afterAll(() => server.close());

    it("retains every event for a thread that never interrupts", async () => {
      const threadId = uuidv7();
      const turnCount = 6;

      const live = await runTurnsAndCollectLive(
        server.serverUrl,
        threadId,
        turnCount
      );
      const replayed = await lateSubscribeAndCollect(
        server.serverUrl,
        threadId
      );

      // Sanity check the fixture actually produced more than one event
      // per turn, matching the shape of the bug (values snapshots
      // interleaved with other channels), not a degenerate no-op.
      expect(live.length).toBeGreaterThan(turnCount);

      // Unbounded (today's) behavior: a late subscriber replays every
      // event ever pushed for this thread — nothing was ever evicted.
      expect(identify(replayed)).toEqual(identify(live));
    }, 30_000);
  });

  describe("maxQueuedEvents set", () => {
    const cap = 3;
    let server: Awaited<ReturnType<typeof startEmbedServer>>;

    beforeAll(async () => {
      server = await startEmbedServer(cap);
    }, 30_000);

    afterAll(() => server.close());

    it("caps the replay buffer to the newest events, never emptying it", async () => {
      const threadId = uuidv7();
      const turnCount = 6;

      const live = await runTurnsAndCollectLive(
        server.serverUrl,
        threadId,
        turnCount
      );
      const replayed = await lateSubscribeAndCollect(
        server.serverUrl,
        threadId
      );

      // More events were generated than the cap allows, so this
      // assertion actually exercises eviction rather than passing
      // vacuously.
      expect(live.length).toBeGreaterThan(cap);

      // The buffer never holds more than the configured cap, is never
      // emptied, and — because eviction only ever drops from the front —
      // what survives is exactly the newest `cap` events, in order.
      expect(replayed).toHaveLength(cap);
      expect(identify(replayed)).toEqual(identify(live.slice(-cap)));
    }, 30_000);
  });
});
