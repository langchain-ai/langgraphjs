import { describe, expect, it } from "vitest";
import { ShallowRedisSaver } from "../shallow.js";

describe("ShallowRedisSaver.putWrites concurrency", () => {
  it("does not replace a newer checkpoint when marking writes present", async () => {
    const checkpointKey = "checkpoint:thread::shallow";
    const documents = new Map<string, any>();
    const sortedSets = new Set<string>();
    let pauseNextCheckpointMutation = false;
    let notifyCheckpointMutation: (() => void) | undefined;
    let resumeCheckpointMutation: (() => void) | undefined;
    const checkpointMutationReached = new Promise<void>((resolve) => {
      notifyCheckpointMutation = resolve;
    });
    const checkpointMutationResumed = new Promise<void>((resolve) => {
      resumeCheckpointMutation = resolve;
    });
    const pauseCheckpointMutation = async () => {
      if (pauseNextCheckpointMutation) {
        pauseNextCheckpointMutation = false;
        notifyCheckpointMutation?.();
        await checkpointMutationResumed;
      }
    };

    const client = {
      exists: async (key: string) =>
        Number(documents.has(key) || sortedSets.has(key)),
      keys: async () => [],
      del: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          documents.delete(key);
          sortedSets.delete(key);
        }
      },
      zAdd: async (key: string) => {
        sortedSets.add(key);
        return 1;
      },
      ft: { create: async () => "OK" },
      json: {
        get: async (key: string) => {
          const snapshot = documents.has(key)
            ? structuredClone(documents.get(key))
            : null;
          if (key === checkpointKey) {
            await pauseCheckpointMutation();
          }
          return snapshot;
        },
        set: async (key: string, path: string, value: any) => {
          if (key === checkpointKey && path === "$.has_writes") {
            await pauseCheckpointMutation();
          }
          if (path === "$") {
            documents.set(key, structuredClone(value));
          } else if (path === "$.has_writes" && documents.has(key)) {
            documents.get(key).has_writes = value;
          }
          return "OK";
        },
      },
    } as never;

    const saver = new ShallowRedisSaver(client);
    const initialCheckpoint = {
      v: 4,
      id: "checkpoint-1",
      ts: "2026-10-15T00:00:00.000Z",
      channel_values: { state: "old" },
      channel_versions: {},
      versions_seen: {},
    } as Parameters<ShallowRedisSaver["put"]>[1];
    const nextCheckpoint = {
      ...initialCheckpoint,
      id: "checkpoint-2",
      channel_values: { state: "new" },
    };

    await saver.put(
      { configurable: { thread_id: "thread" } },
      initialCheckpoint,
      { source: "loop", step: 1, parents: {} },
      {},
    );

    pauseNextCheckpointMutation = true;
    const inFlightPutWrites = saver.putWrites(
      {
        configurable: {
          thread_id: "thread",
          checkpoint_id: "checkpoint-1",
        },
      },
      [["__interrupt__", "paused"]],
      "task",
    );
    await checkpointMutationReached;

    await saver.put(
      { configurable: { thread_id: "thread" } },
      nextCheckpoint,
      { source: "loop", step: 2, parents: {} },
      {},
    );
    resumeCheckpointMutation?.();
    await inFlightPutWrites;

    const savedCheckpoint = documents.get(checkpointKey);
    expect(savedCheckpoint.checkpoint_id).toBe("checkpoint-2");
    expect(savedCheckpoint.checkpoint.channel_values).toEqual({ state: "new" });
    expect(savedCheckpoint.has_writes).toBe("true");
  });

  it("keeps the writes marker when putWrites races the checkpoint root write", async () => {
    const checkpointKey = "checkpoint:thread::shallow";
    const writeKey = "checkpoint_write:thread::checkpoint-2:task:0";
    const writeSetKey = "write_keys_zset:thread::checkpoint-2";
    const documents = new Map<string, any>();
    const sortedSets = new Set<string>();
    let pauseNextRootWrite = false;
    let notifyRootWrite: (() => void) | undefined;
    let resumeRootWrite: (() => void) | undefined;
    const rootWriteReached = new Promise<void>((resolve) => {
      notifyRootWrite = resolve;
    });
    const rootWriteResumed = new Promise<void>((resolve) => {
      resumeRootWrite = resolve;
    });

    const client = {
      exists: async (key: string) =>
        Number(documents.has(key) || sortedSets.has(key)),
      keys: async () => [],
      del: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          documents.delete(key);
          sortedSets.delete(key);
        }
      },
      zAdd: async (key: string) => {
        sortedSets.add(key);
        return 1;
      },
      ft: { create: async () => "OK" },
      json: {
        get: async (key: string) =>
          documents.has(key) ? structuredClone(documents.get(key)) : null,
        set: async (key: string, path: string, value: any) => {
          if (key === checkpointKey && path === "$" && pauseNextRootWrite) {
            pauseNextRootWrite = false;
            notifyRootWrite?.();
            await rootWriteResumed;
          }
          if (path === "$") {
            documents.set(key, structuredClone(value));
          } else if (path === "$.has_writes" && documents.has(key)) {
            documents.get(key).has_writes = value;
          }
          return "OK";
        },
      },
    } as never;

    const saver = new ShallowRedisSaver(client);
    const checkpoint = (id: string, state: string) =>
      ({
        v: 4,
        id,
        ts: "2026-10-15T00:00:00.000Z",
        channel_values: { state },
        channel_versions: {},
        versions_seen: {},
      }) as Parameters<ShallowRedisSaver["put"]>[1];

    await saver.put(
      { configurable: { thread_id: "thread" } },
      checkpoint("checkpoint-1", "old"),
      { source: "loop", step: 1, parents: {} },
      {},
    );

    pauseNextRootWrite = true;
    const inFlightPut = saver.put(
      { configurable: { thread_id: "thread" } },
      checkpoint("checkpoint-2", "new"),
      { source: "loop", step: 2, parents: {} },
      {},
    );
    await rootWriteReached;

    await saver.putWrites(
      {
        configurable: {
          thread_id: "thread",
          checkpoint_id: "checkpoint-2",
        },
      },
      [["__interrupt__", "paused"]],
      "task",
    );
    resumeRootWrite?.();
    await inFlightPut;

    const savedCheckpoint = documents.get(checkpointKey);
    expect(savedCheckpoint.checkpoint_id).toBe("checkpoint-2");
    expect(savedCheckpoint.has_writes).toBe("true");
    expect(documents.has(writeKey)).toBe(true);
    expect(sortedSets.has(writeSetKey)).toBe(true);
  });
});
