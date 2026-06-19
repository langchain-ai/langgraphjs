import { describe, it, expect } from "vitest";
import { RedisSaver } from "../index.js";
import { ShallowRedisSaver } from "../shallow.js";

// `RedisSaver.putWrites` stores one JSON document per write under a key shaped
// `checkpoint_write:<thread>:<ns>:<ckpt>:<task>:<idx>`. The two things this
// suite needs to assert are:
//   1. special channels (ERROR / SCHEDULED / INTERRUPT / RESUME) are written
//      to fixed negative `idx`es from WRITES_IDX_MAP, not the ordinal in the
//      call — otherwise they collide with regular per-step writes.
//   2. the conflict-resolution clause matches the contract: `$set`-style
//      overwrite when every write is a special channel, NX (insert-or-ignore)
//      otherwise.
// Both are observable from the `json.set` call sites without standing up
// real Redis.
const makeMockClient = () => {
  const jsonSetCalls: Array<{
    key: string;
    path: string;
    value: unknown;
    options?: { NX?: boolean; XX?: boolean };
  }> = [];
  const client = {
    exists: async () => 0,
    keys: async () => [],
    json: {
      set: async (
        key: string,
        path: string,
        value: unknown,
        options?: { NX?: boolean; XX?: boolean }
      ) => {
        jsonSetCalls.push({ key, path, value, options });
        return "OK";
      },
      get: async () => null,
    },
    zAdd: async () => 0,
    ft: { info: async () => ({}) },
  } as never;
  return { client, jsonSetCalls };
};

describe("RedisSaver.putWrites — WRITES_IDX_MAP", () => {
  const config = {
    configurable: {
      thread_id: "t",
      checkpoint_ns: "",
      checkpoint_id: "c",
    },
  };

  it("uses fixed negative indices for special channels mixed with regular writes, and NX-guards the inserts", async () => {
    const { client, jsonSetCalls } = makeMockClient();
    const saver = new RedisSaver(client);

    await saver.putWrites(
      config,
      [
        ["foo", "v_foo"],
        ["bar", "v_bar"],
        ["__interrupt__", "paused"],
      ],
      "task_A"
    );

    // Only the write-doc json.set calls — drop the trailing checkpoint
    // has_writes marker by filtering on the key prefix.
    const writeSets = jsonSetCalls.filter((c) =>
      c.key.startsWith("checkpoint_write:")
    );

    const tails = writeSets.map((c) => c.key.split(":").pop());
    // foo (idx 0), bar (idx 1), __interrupt__ (idx -3 via WRITES_IDX_MAP)
    expect(tails.sort()).toEqual(["-3", "0", "1"].sort());

    // Mixed batch → every JSON.SET must carry NX so a peer task's existing
    // row at the same (task_id, idx) doesn't get clobbered.
    for (const c of writeSets) {
      expect(c.options).toMatchObject({ NX: true });
    }
  });

  it("uses unguarded JSON.SET when every write is a special channel (INTERRUPT → RESUME state transitions must overwrite)", async () => {
    const { client, jsonSetCalls } = makeMockClient();
    const saver = new RedisSaver(client);

    await saver.putWrites(config, [["__resume__", "carry_on"]], "task_A");

    const writeSets = jsonSetCalls.filter((c) =>
      c.key.startsWith("checkpoint_write:")
    );
    expect(writeSets).toHaveLength(1);
    expect(writeSets[0].key.endsWith(":-4")).toBe(true); // RESUME → idx -4
    // No NX option, so it overwrites whatever was there before.
    expect(writeSets[0].options ?? {}).not.toHaveProperty("NX");
  });
});

const makeCheckpointDocWithUndefinedPendingWrite = () => ({
  thread_id: "t",
  checkpoint_ns: "",
  checkpoint_id: "c",
  parent_checkpoint_id: null,
  checkpoint: {
    v: 4,
    id: "c",
    ts: "2026-01-01T00:00:00.000Z",
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  },
  metadata: {},
  checkpoint_ts: 1,
  has_writes: "true",
});

const writeDocWithoutValue = {
  thread_id: "t",
  checkpoint_ns: "",
  checkpoint_id: "c",
  task_id: "task_A",
  idx: 0,
  channel: "regular",
  type: "json",
  timestamp: 1,
  global_idx: 1,
};

describe("RedisSaver.loadPendingWrites — undefined values", () => {
  it("restores a missing write value as undefined instead of parsing it as JSON", async () => {
    const checkpointDoc = makeCheckpointDocWithUndefinedPendingWrite();
    const client = {
      keys: async (pattern: string) => {
        if (pattern === "checkpoint_write:t::c:*") {
          return ["checkpoint_write:t::c:task_A:0"];
        }
        return [];
      },
      json: {
        get: async (key: string) => {
          if (key === "checkpoint:t::c") {
            return checkpointDoc;
          }
          if (key === "checkpoint_write:t::c:task_A:0") {
            return writeDocWithoutValue;
          }
          return null;
        },
      },
      ft: { info: async () => ({}) },
    } as never;

    const saver = new RedisSaver(client);
    const tuple = await saver.getTuple({
      configurable: {
        thread_id: "t",
        checkpoint_ns: "",
        checkpoint_id: "c",
      },
    });

    expect(tuple?.pendingWrites).toEqual([["task_A", "regular", undefined]]);
  });
});

describe("ShallowRedisSaver.loadPendingWrites — undefined values", () => {
  it("restores a missing write value as undefined instead of parsing it as JSON", async () => {
    const checkpointDoc = makeCheckpointDocWithUndefinedPendingWrite();
    const client = {
      zRange: async (key: string) => {
        if (key === "write_keys_zset:t::c") {
          return ["checkpoint_write:t::c:task_A:0"];
        }
        return [];
      },
      json: {
        get: async (key: string) => {
          if (key === "checkpoint:t::shallow") {
            return checkpointDoc;
          }
          if (key === "checkpoint_write:t::c:task_A:0") {
            return writeDocWithoutValue;
          }
          return null;
        },
      },
      ft: { info: async () => ({}) },
    } as never;

    const saver = new ShallowRedisSaver(client);
    const tuple = await saver.getTuple({
      configurable: {
        thread_id: "t",
        checkpoint_ns: "",
        checkpoint_id: "c",
      },
    });

    expect(tuple?.pendingWrites).toEqual([["task_A", "regular", undefined]]);
  });
});
