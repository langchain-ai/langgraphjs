/* eslint-disable no-process-env */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { isDeltaSnapshot } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { DeltaChannel } from "../channels/delta.js";
import {
  messagesDeltaReducer,
  messagesStateReducer,
  type Messages,
} from "../graph/messages_reducer.js";
import { Annotation } from "../graph/index.js";
import { StateGraph } from "../graph/state.js";
import { START, END, Overwrite, Command } from "../constants.js";
import { interrupt } from "../interrupt.js";
import { initializeAsyncLocalStorageSingleton } from "../node.js";

const { Pool } = pg;

const { TEST_POSTGRES_URL } = process.env;
if (!TEST_POSTGRES_URL) {
  throw new Error("TEST_POSTGRES_URL environment variable is required");
}

// Create an isolated database + PostgresSaver per run, mirroring the bootstrap
// used by pregel.postgres_saver.int.test.ts.
async function createPostgresSaver(): Promise<PostgresSaver> {
  const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
  const dbName = `lg_test_db_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  try {
    await pool.query(`CREATE DATABASE ${dbName}`);
    const dbConnectionString = `${TEST_POSTGRES_URL?.split("/")
      .slice(0, -1)
      .join("/")}/${dbName}`;
    const checkpointer = PostgresSaver.fromConnString(dbConnectionString);
    await checkpointer.setup();
    return checkpointer;
  } finally {
    await pool.end();
  }
}

async function dropTestDatabases(): Promise<void> {
  const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
  try {
    const result = await pool.query(`
      SELECT datname FROM pg_database
      WHERE datname LIKE 'lg_test_db_%'
    `);
    for (const row of result.rows) {
      await pool.query(`DROP DATABASE ${row.datname} WITH (FORCE)`);
    }
  } finally {
    await pool.end();
  }
}

// Monotonic counter for stable, collision-free message ids across nodes and
// test inputs within a single file run.
let idCounter = 0;
const human = (content: string) =>
  new HumanMessage({ id: `h-${idCounter++}`, content });
const contents = (msgs: BaseMessage[]) => msgs.map((m) => m.content);
const messagesOf = (values: unknown) =>
  (values as { messages: BaseMessage[] }).messages;

// A graph whose `messages` key is a DeltaChannel: each turn appends an AI reply
// that echoes the most recent message.
function deltaChatGraph(saver: PostgresSaver, snapshotFrequency = 1000) {
  const State = Annotation.Root({
    messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer, {
      snapshotFrequency,
    }),
  });
  return new StateGraph(State)
    .addNode("chat", (state) => {
      const last = state.messages[state.messages.length - 1];
      return {
        messages: [
          new AIMessage({ id: `ai-${idCounter++}`, content: `reply:${last.content}` }),
        ],
      };
    })
    .addEdge(START, "chat")
    .addEdge("chat", END)
    .compile({ checkpointer: saver });
}

// A graph whose `messages` key is a legacy (non-delta) reducer channel that
// stores the full accumulated value in every checkpoint blob.
function legacyChatGraph(saver: PostgresSaver) {
  const State = Annotation.Root({
    messages: Annotation<BaseMessage[], Messages>({
      reducer: messagesStateReducer,
      default: () => [],
    }),
  });
  return new StateGraph(State)
    .addNode("chat", (state) => {
      const last = state.messages[state.messages.length - 1];
      return {
        messages: [
          new AIMessage({ id: `ai-${idCounter++}`, content: `reply:${last.content}` }),
        ],
      };
    })
    .addEdge(START, "chat")
    .addEdge("chat", END)
    .compile({ checkpointer: saver });
}

// A graph whose agent node emits an Overwrite (hard reset) when the run config
// requests compaction; otherwise it appends a normal reply.
function compactingGraph(saver: PostgresSaver) {
  const State = Annotation.Root({
    messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer),
  });
  return new StateGraph(State)
    .addNode("agent", (state, config) => {
      const compact = Boolean(
        (config?.configurable as Record<string, unknown> | undefined)?.compact
      );
      if (compact) {
        return {
          messages: new Overwrite([
            new AIMessage({ id: `sum-${idCounter++}`, content: "summary" }),
          ]),
        };
      }
      const last = state.messages[state.messages.length - 1];
      return {
        messages: [
          new AIMessage({ id: `ai-${idCounter++}`, content: `reply:${last.content}` }),
        ],
      };
    })
    .addEdge(START, "agent")
    .addEdge("agent", END)
    .compile({ checkpointer: saver });
}

/**
 * A graph where two nodes write to the same DeltaChannel in one super-step: a
 * plain write and an Overwrite.
 */
function fanInOverwriteGraph(saver: PostgresSaver) {
  const State = Annotation.Root({
    messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer),
  });
  return new StateGraph(State)
    .addNode("plain", () => ({
      messages: [new AIMessage({ id: `p-${idCounter++}`, content: "plain" })],
    }))
    .addNode("reset", () => ({
      messages: new Overwrite([
        new AIMessage({ id: `o-${idCounter++}`, content: "over" }),
      ]),
    }))
    .addEdge(START, "plain")
    .addEdge(START, "reset")
    .addEdge("plain", END)
    .addEdge("reset", END)
    .compile({ checkpointer: saver });
}

// A graph mixing a DeltaChannel (`messages`) with a reducer channel (`count`)
// and a LastValue channel (`status`). Verifies delta reconstruction coexists
// with ordinary channels stored in full in `channel_values`.
function mixedStateGraph(saver: PostgresSaver) {
  const State = Annotation.Root({
    messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer),
    count: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
    status: Annotation<string>,
  });
  return new StateGraph(State)
    .addNode("chat", (state) => {
      const last = state.messages[state.messages.length - 1];
      return {
        messages: [
          new AIMessage({ id: `ai-${idCounter++}`, content: `reply:${last.content}` }),
        ],
        count: 1,
        status: `seen:${last.content}`,
      };
    })
    .addEdge(START, "chat")
    .addEdge("chat", END)
    .compile({ checkpointer: saver });
}

// A graph that pauses on `interrupt()` and, when resumed via Command, appends a
// message derived from the resume value. Exercises the HITL persist/reconstruct
// path for a DeltaChannel across the interrupt boundary.
function hitlGraph(saver: PostgresSaver) {
  const State = Annotation.Root({
    messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer),
  });
  return new StateGraph(State)
    .addNode("ask", () => {
      const answer = interrupt<string, string>("need input");
      return {
        messages: [
          new AIMessage({ id: `ai-${idCounter++}`, content: `answered:${answer}` }),
        ],
      };
    })
    .addEdge(START, "ask")
    .addEdge("ask", END)
    .compile({ checkpointer: saver });
}

// A parent graph that delegates to a compiled subgraph sharing the same
// DeltaChannel-backed `messages` state. The subgraph runs under a child
// checkpoint namespace; reconstruction must walk the parent namespace correctly.
function subgraphParentGraph(saver: PostgresSaver) {
  const State = Annotation.Root({
    messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer),
  });
  const sub = new StateGraph(State)
    .addNode("inner", (state) => {
      const last = state.messages[state.messages.length - 1];
      return {
        messages: [
          new AIMessage({ id: `sub-${idCounter++}`, content: `sub:${last.content}` }),
        ],
      };
    })
    .addEdge(START, "inner")
    .addEdge("inner", END)
    .compile();
  return new StateGraph(State)
    .addNode("outer", (state) => {
      const last = state.messages[state.messages.length - 1];
      return {
        messages: [
          new AIMessage({ id: `out-${idCounter++}`, content: `out:${last.content}` }),
        ],
      };
    })
    .addNode("child", sub)
    .addEdge(START, "outer")
    .addEdge("outer", "child")
    .addEdge("child", END)
    .compile({ checkpointer: saver });
}

describe("DeltaChannel end-to-end with PostgresSaver", () => {
  let checkpointer: PostgresSaver;

  beforeAll(async () => {
    // The `int` vitest mode does not load the unit setup file, so the
    // AsyncLocalStorage singleton that `interrupt()` relies on must be
    // initialized explicitly (mirrors chatbot.int.test.ts / prebuilt.int.test.ts).
    initializeAsyncLocalStorageSingleton();
    checkpointer = await createPostgresSaver();
  }, 60_000);

  afterAll(async () => {
    await checkpointer?.end();
    await dropTestDatabases();
  }, 60_000);

  const durabilities = ["async", "sync", "exit"] as const;
  for (const durability of durabilities) {
    it(`reconstructs accumulated messages across multiple runs in a thread (durability=${durability})`, async () => {
      const graph = deltaChatGraph(checkpointer);
      const config = {
        configurable: { thread_id: `acc-${durability}` },
        durability,
      };

      for (let i = 0; i < 4; i += 1) {
        await graph.invoke({ messages: [human(`q${i}`)] }, config);
      }

      const state = await graph.getState(config);
      expect(contents(messagesOf(state.values))).toEqual([
        "q0",
        "reply:q0",
        "q1",
        "reply:q1",
        "q2",
        "reply:q2",
        "q3",
        "reply:q3",
      ]);
    });
  }

  it("reconstructs state from a fresh graph instance sharing only the saver (cold read)", async () => {
    const config = { configurable: { thread_id: "cold" } };
    await deltaChatGraph(checkpointer).invoke(
      { messages: [human("a")] },
      config
    );
    await deltaChatGraph(checkpointer).invoke(
      { messages: [human("b")] },
      config
    );

    // Brand new compiled graph that only shares the Postgres checkpointer.
    const fresh = deltaChatGraph(checkpointer);
    const state = await fresh.getState(config);
    expect(contents(messagesOf(state.values))).toEqual([
      "a",
      "reply:a",
      "b",
      "reply:b",
    ]);

    // Message ids must be stable across repeated reconstruction reads.
    const again = await fresh.getState(config);
    expect(messagesOf(again.values).map((m) => m.id)).toEqual(
      messagesOf(state.values).map((m) => m.id)
    );
  });

  it("never persists the full accumulated value in Postgres checkpoint blobs", async () => {
    const graph = deltaChatGraph(checkpointer, 1000);
    const config = { configurable: { thread_id: "blobs" } };
    for (let i = 0; i < 3; i += 1) {
      await graph.invoke({ messages: [human(`q${i}`)] }, config);
    }

    // A delta channel may only ever appear in a stored blob as a DeltaSnapshot,
    // never as a plain accumulated array. With snapshotFrequency=1000 there are
    // no snapshots within 3 runs, so it should be absent entirely.
    let sawSnapshot = false;
    for await (const tup of checkpointer.list(config)) {
      const cv = tup.checkpoint.channel_values as Record<string, unknown>;
      if ("messages" in cv && cv.messages !== undefined) {
        expect(isDeltaSnapshot(cv.messages)).toBe(true);
        sawSnapshot = true;
      }
    }
    expect(sawSnapshot).toBe(false);

    // Reconstruction from the persisted deltas must still be correct.
    const state = await graph.getState(config);
    expect(contents(messagesOf(state.values))).toHaveLength(6);
  });

  it("writes periodic DeltaSnapshot blobs and still reconstructs correctly", async () => {
    const graph = deltaChatGraph(checkpointer, 2);
    const config = { configurable: { thread_id: "snap" } };
    for (let i = 0; i < 6; i += 1) {
      await graph.invoke({ messages: [human(`q${i}`)] }, config);
    }

    let snapshots = 0;
    for await (const tup of checkpointer.list(config)) {
      const cv = tup.checkpoint.channel_values as Record<string, unknown>;
      if (isDeltaSnapshot(cv.messages)) snapshots += 1;
    }
    expect(snapshots).toBeGreaterThan(0);

    const state = await deltaChatGraph(checkpointer).getState(config);
    expect(contents(messagesOf(state.values))).toHaveLength(12);
  });

  it("applies Overwrite as a hard reset and persists it across runs", async () => {
    const config = { configurable: { thread_id: "overwrite" } };
    await compactingGraph(checkpointer).invoke(
      { messages: [human("a")] },
      config
    );
    await compactingGraph(checkpointer).invoke(
      { messages: [human("b")] },
      config
    );

    let state = await compactingGraph(checkpointer).getState(config);
    expect(contents(messagesOf(state.values))).toEqual([
      "a",
      "reply:a",
      "b",
      "reply:b",
    ]);

    // Compaction run: the agent overwrites the channel. The hard reset drops all
    // prior messages (including the just-applied input) down to the summary.
    await compactingGraph(checkpointer).invoke(
      { messages: [human("c")] },
      { configurable: { thread_id: "overwrite", compact: true } }
    );

    // Cold read through a fresh graph must observe the persisted reset.
    state = await compactingGraph(checkpointer).getState(config);
    expect(contents(messagesOf(state.values))).toEqual(["summary"]);

    // Subsequent runs accumulate on top of the overwrite.
    await compactingGraph(checkpointer).invoke(
      { messages: [human("d")] },
      config
    );
    state = await compactingGraph(checkpointer).getState(config);
    expect(contents(messagesOf(state.values))).toEqual([
      "summary",
      "d",
      "reply:d",
    ]);
  });

  // Reconstruction from a checkpoint must EXACTLY reproduce the live state when
  // a plain write and an Overwrite are applied concurrently in one super-step.
  // Under option A the Overwrite wins the entire super-step: the concurrent
  // "plain" write is discarded along with the pre-overwrite "start" input, so
  // the result is deterministically `["over"]` on both the live and replay
  // paths — independent of task ordering. Each iteration uses a fresh thread
  // (and therefore fresh task ids) to also guard against ordering
  // nondeterminism across runs and across savers (MemorySaver vs PostgresSaver).
  for (const durability of durabilities) {
    it(`reconstruction exactly matches live for concurrent plain+Overwrite writes (durability=${durability})`, async () => {
      for (let i = 0; i < 5; i += 1) {
        const config = {
          configurable: { thread_id: `fanin-${durability}-${i}` },
          durability,
        };
        const live = await fanInOverwriteGraph(checkpointer).invoke(
          { messages: [human("start")] },
          config
        );
        const cold = await fanInOverwriteGraph(checkpointer).getState(config);
        expect(contents(messagesOf(cold.values))).toEqual(
          contents(messagesOf(live))
        );
        // The Overwrite wins the whole super-step: only "over" survives, while
        // both the concurrent "plain" write and the "start" input are dropped.
        expect(contents(messagesOf(live))).toEqual(["over"]);
        expect(contents(messagesOf(live))).not.toContain("plain");
        expect(contents(messagesOf(live))).not.toContain("start");
      }
    });
  }

  it("migrates a thread from a non-delta channel to a DeltaChannel", async () => {
    const config = { configurable: { thread_id: "migrate" } };

    // Phase 1: a legacy reducer channel stores the full value in every blob.
    await legacyChatGraph(checkpointer).invoke(
      { messages: [human("a")] },
      config
    );
    await legacyChatGraph(checkpointer).invoke(
      { messages: [human("b")] },
      config
    );

    const legacyState = await legacyChatGraph(checkpointer).getState(config);
    expect(contents(messagesOf(legacyState.values))).toEqual([
      "a",
      "reply:a",
      "b",
      "reply:b",
    ]);
    // The legacy blob holds the full plain array (not a delta sentinel).
    const legacyTuple = await checkpointer.getTuple(config);
    expect(legacyTuple).toBeDefined();
    const legacyValues = legacyTuple!.checkpoint.channel_values as Record<
      string,
      unknown
    >;
    expect(Array.isArray(legacyValues.messages)).toBe(true);

    // Phase 2: resume the SAME thread with a DeltaChannel for `messages`. The
    // migration-boundary plain blob becomes the delta seed; new writes replay
    // on top of it.
    await deltaChatGraph(checkpointer).invoke(
      { messages: [human("c")] },
      config
    );

    const expected = [
      "a",
      "reply:a",
      "b",
      "reply:b",
      "c",
      "reply:c",
    ];

    const migrated = await deltaChatGraph(checkpointer).getState(config);
    expect(contents(messagesOf(migrated.values))).toEqual(expected);

    // Cold read from a fresh delta graph reconstructs through the migration
    // boundary plain seed + replayed post-migration writes.
    const cold = await deltaChatGraph(checkpointer).getState(config);
    expect(contents(messagesOf(cold.values))).toEqual(expected);

    // Continued accumulation post-migration stays correct.
    await deltaChatGraph(checkpointer).invoke(
      { messages: [human("d")] },
      config
    );
    const final = await deltaChatGraph(checkpointer).getState(config);
    expect(contents(messagesOf(final.values))).toEqual([
      ...expected,
      "d",
      "reply:d",
    ]);
  });

  it("reconstructs a DeltaChannel alongside reducer and LastValue channels", async () => {
    const config = { configurable: { thread_id: "mixed" } };
    for (let i = 0; i < 3; i += 1) {
      await mixedStateGraph(checkpointer).invoke(
        { messages: [human(`q${i}`)] },
        config
      );
    }

    // Cold read through a fresh graph: the delta channel is replayed from its
    // persisted writes while `count`/`status` come straight from the blob.
    const state = await mixedStateGraph(checkpointer).getState(config);
    expect(contents(messagesOf(state.values))).toEqual([
      "q0",
      "reply:q0",
      "q1",
      "reply:q1",
      "q2",
      "reply:q2",
    ]);
    const values = state.values as {
      messages: BaseMessage[];
      count: number;
      status: string;
    };
    expect(values.count).toBe(3);
    expect(values.status).toBe("seen:q2");
  });

  it("persists and reconstructs a DeltaChannel across an interrupt + resume (HITL)", async () => {
    const config = { configurable: { thread_id: "hitl" } };

    // First invocation pauses at interrupt(); the input is already committed to
    // the delta channel before the node yields.
    await hitlGraph(checkpointer).invoke({ messages: [human("hello")] }, config);
    const paused = await hitlGraph(checkpointer).getState(config);
    expect(contents(messagesOf(paused.values))).toEqual(["hello"]);
    expect(paused.next).toEqual(["ask"]);

    // Resume on a fresh graph instance: the node completes and appends a reply
    // derived from the resume value. Reconstruction must include both writes.
    await hitlGraph(checkpointer).invoke(
      new Command({ resume: "yes" }),
      config
    );
    const resumed = await hitlGraph(checkpointer).getState(config);
    expect(contents(messagesOf(resumed.values))).toEqual([
      "hello",
      "answered:yes",
    ]);
    expect(resumed.next).toEqual([]);
  });

  it("reconstructs a DeltaChannel written across a subgraph boundary", async () => {
    const config = { configurable: { thread_id: "subgraph" } };
    const live = await subgraphParentGraph(checkpointer).invoke(
      { messages: [human("hi")] },
      config
    );
    expect(contents(messagesOf(live))).toEqual([
      "hi",
      "out:hi",
      "sub:out:hi",
    ]);

    // Cold read through a fresh graph reconstructs the parent-namespace deltas,
    // including the message contributed by the child subgraph.
    const cold = await subgraphParentGraph(checkpointer).getState(config);
    expect(contents(messagesOf(cold.values))).toEqual(
      contents(messagesOf(live))
    );
  });

  it("reconstructs a DeltaChannel at a historical checkpoint and on a fork", async () => {
    const config = { configurable: { thread_id: "fork" } };

    await deltaChatGraph(checkpointer).invoke({ messages: [human("a")] }, config);
    const afterA = await deltaChatGraph(checkpointer).getState(config);
    expect(contents(messagesOf(afterA.values))).toEqual(["a", "reply:a"]);
    const forkPoint = afterA.config;

    await deltaChatGraph(checkpointer).invoke({ messages: [human("b")] }, config);
    await deltaChatGraph(checkpointer).invoke({ messages: [human("c")] }, config);
    const latest = await deltaChatGraph(checkpointer).getState(config);
    expect(contents(messagesOf(latest.values))).toEqual([
      "a",
      "reply:a",
      "b",
      "reply:b",
      "c",
      "reply:c",
    ]);

    // Time-travel read: reconstructing AT the historical checkpoint must yield
    // only the deltas up to that point, not the latest accumulated value.
    const atFork = await deltaChatGraph(checkpointer).getState(forkPoint);
    expect(contents(messagesOf(atFork.values))).toEqual(["a", "reply:a"]);

    // Forking a new run from that checkpoint reconstructs the historical delta
    // state as its base, so the new branch excludes b/c entirely.
    const forked = await deltaChatGraph(checkpointer).invoke(
      { messages: [human("z")] },
      forkPoint
    );
    expect(contents(messagesOf(forked))).toEqual([
      "a",
      "reply:a",
      "z",
      "reply:z",
    ]);
  });

  it("persists and reconstructs manual updateState writes to a DeltaChannel", async () => {
    const config = { configurable: { thread_id: "update" } };
    await deltaChatGraph(checkpointer).invoke({ messages: [human("a")] }, config);

    // A manual update writes to the delta channel just like a node would.
    await deltaChatGraph(checkpointer).updateState(config, {
      messages: [new AIMessage({ id: `u-${idCounter++}`, content: "manual" })],
    });

    const state = await deltaChatGraph(checkpointer).getState(config);
    expect(contents(messagesOf(state.values))).toEqual([
      "a",
      "reply:a",
      "manual",
    ]);

    // The manual write survives a subsequent normal run and a cold read.
    await deltaChatGraph(checkpointer).invoke({ messages: [human("b")] }, config);
    const cold = await deltaChatGraph(checkpointer).getState(config);
    expect(contents(messagesOf(cold.values))).toEqual([
      "a",
      "reply:a",
      "manual",
      "b",
      "reply:b",
    ]);
  });
});
