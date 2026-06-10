import { describe, it, expect } from "vitest";
import { RedisSaver } from "../index.js";

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
