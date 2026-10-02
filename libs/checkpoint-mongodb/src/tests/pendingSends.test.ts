import { describe, it, expect, vi } from "vitest";
import { TASKS } from "@langchain/langgraph-checkpoint";
import { MongoDBSaver } from "../checkpoint.js";

const THREAD_ID = "thread-1";
const PARENT_ID = "parent-checkpoint";
const CHILD_ID = "child-checkpoint";

/** Stands in for the BSON Binary the driver hands back for `checkpoint`/`metadata`. */
function binary(payload: unknown) {
  return { value: () => JSON.stringify(payload) };
}

/**
 * A checkpoint written before `Checkpoint.pending_sends` was removed: `v: 3`,
 * no `channel_values[TASKS]`, and the queued sends living in the parent's
 * `__pregel_tasks` writes instead.
 */
function createSaver() {
  const legacyCheckpoint = {
    v: 3,
    id: CHILD_ID,
    ts: "2024-04-19T17:19:07.952Z",
    channel_values: { someChannel: "someValue" },
    channel_versions: { someChannel: 2 },
    versions_seen: {},
  };

  const checkpointDoc = {
    thread_id: THREAD_ID,
    checkpoint_ns: "",
    checkpoint_id: CHILD_ID,
    parent_checkpoint_id: PARENT_ID,
    type: "json",
    checkpoint: binary(legacyCheckpoint),
    metadata: binary({ source: "loop", step: 1, parents: {} }),
  };

  const taskWrite = {
    thread_id: THREAD_ID,
    checkpoint_ns: "",
    checkpoint_id: PARENT_ID,
    task_id: "task-1",
    idx: 0,
    channel: TASKS,
    type: "json",
    value: binary({ node: "worker", args: { n: 1 } }),
  };

  const writeQueries: Record<string, unknown>[] = [];

  const checkpoints = {
    find: vi.fn(() => ({
      sort: vi.fn(() => ({
        limit: vi.fn(() => ({ toArray: async () => [checkpointDoc] })),
      })),
    })),
  };

  const checkpointWrites = {
    find: vi.fn((query: Record<string, unknown>) => {
      writeQueries.push(query);
      const matches =
        query.checkpoint_id === PARENT_ID && query.channel === TASKS
          ? [taskWrite]
          : [];
      return {
        toArray: async () => matches,
        sort: vi.fn(() => ({ toArray: async () => matches })),
      };
    }),
  };

  const client = {
    appendMetadata: vi.fn(),
    db: vi.fn(() => ({
      collection: vi.fn((name: string) =>
        name === "checkpoints" ? checkpoints : checkpointWrites
      ),
    })),
  } as any;

  return { saver: new MongoDBSaver({ client }), writeQueries };
}

describe("MongoDBSaver legacy pending sends", () => {
  it("rebuilds channel_values[TASKS] from the parent's task writes", async () => {
    const { saver } = createSaver();

    const tuple = await saver.getTuple({
      configurable: { thread_id: THREAD_ID },
    });

    expect(tuple?.checkpoint.channel_values[TASKS]).toEqual([
      { node: "worker", args: { n: 1 } },
    ]);
  });

  it("gives TASKS a channel version so the topic is available", async () => {
    const { saver } = createSaver();

    const tuple = await saver.getTuple({
      configurable: { thread_id: THREAD_ID },
    });

    expect(tuple?.checkpoint.channel_versions[TASKS]).toBeDefined();
  });

  it("reads the sends from the parent checkpoint, not the child", async () => {
    const { saver, writeQueries } = createSaver();

    await saver.getTuple({ configurable: { thread_id: THREAD_ID } });

    const taskQuery = writeQueries.find((query) => query.channel === TASKS);
    expect(taskQuery).toMatchObject({
      thread_id: THREAD_ID,
      checkpoint_id: PARENT_ID,
      channel: TASKS,
    });
  });

  it("leaves a current checkpoint alone", async () => {
    const { saver, writeQueries } = createSaver();
    // A v4 checkpoint already carries its sends in channel_values.
    const collection = (saver as any).db.collection("checkpoints");
    collection.find.mockReturnValue({
      sort: () => ({
        limit: () => ({
          toArray: async () => [
            {
              thread_id: THREAD_ID,
              checkpoint_ns: "",
              checkpoint_id: CHILD_ID,
              parent_checkpoint_id: PARENT_ID,
              type: "json",
              checkpoint: binary({
                v: 4,
                id: CHILD_ID,
                ts: "2024-04-19T17:19:07.952Z",
                channel_values: {},
                channel_versions: {},
                versions_seen: {},
              }),
              metadata: binary({ source: "loop", step: 1, parents: {} }),
            },
          ],
        }),
      }),
    });

    const tuple = await saver.getTuple({
      configurable: { thread_id: THREAD_ID },
    });

    expect(tuple?.checkpoint.channel_values[TASKS]).toBeUndefined();
    expect(writeQueries.some((query) => query.channel === TASKS)).toBe(false);
  });
});
