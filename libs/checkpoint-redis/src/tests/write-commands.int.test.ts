import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Checkpoint,
  CheckpointMetadata,
  emptyCheckpoint,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import type { RedisClientType } from "redis";
import { RedisSaver } from "../index.js";
import { createRedisContainer } from "./redis-container.js";

// Commands Redis ran since the last CONFIG RESETSTAT, by lowercase name
async function commandCounts(
  client: RedisClientType
): Promise<Record<string, number>> {
  const info = await client.info("commandstats");
  const counts: Record<string, number> = {};
  for (const line of info.split("\r\n")) {
    const match = /^cmdstat_([^:]+):calls=(\d+),.*rejected_calls=(\d+)/.exec(
      line
    );
    if (match) {
      counts[match[1]] = Number(match[2]) + Number(match[3]);
    }
  }
  // The INFO call reading these counts
  delete counts.info;
  delete counts["config|resetstat"];
  return counts;
}

function makeCheckpoint(): Checkpoint {
  const checkpoint = emptyCheckpoint();
  checkpoint.id = uuid6(-1);
  checkpoint.channel_values = { foo: "bar", baz: 1 };
  checkpoint.channel_versions = { foo: 1, baz: 1 };
  return checkpoint;
}

const metadata: CheckpointMetadata = {
  source: "loop",
  step: 1,
  parents: {},
};

describe("RedisSaver write commands", () => {
  let client: RedisClientType;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ client, cleanup } = await createRedisContainer());
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await client.flushAll();
    await client.sendCommand(["FT.DROPINDEX", "checkpoints"]).catch(() => {});
    await client
      .sendCommand(["FT.DROPINDEX", "checkpoint_blobs"])
      .catch(() => {});
    await client
      .sendCommand(["FT.DROPINDEX", "checkpoint_writes"])
      .catch(() => {});
  });

  it("creates the indexes once per saver, not per put or putWrites", async () => {
    const saver = new RedisSaver(client, { defaultTTL: 60 });
    const checkpoint = makeCheckpoint();
    const config = await saver.put(
      { configurable: { thread_id: "t1", checkpoint_ns: "" } },
      checkpoint,
      metadata,
      { foo: 1, baz: 1 }
    );

    await client.configResetStat();
    const next = makeCheckpoint();
    await saver.put(config, next, metadata, { foo: 2 });
    expect(await commandCounts(client)).toEqual({
      exists: 1, // writes zset
      "json.set": 2, // blob + document
      expire: 3, // two referenced blobs + document
    });

    await client.configResetStat();
    await saver.putWrites(
      config,
      [
        ["foo", "a"],
        ["baz", 2],
      ],
      "task1"
    );
    expect(await commandCounts(client)).toEqual({
      "json.set": 3, // two writes + has_writes
      zadd: 1,
      expire: 3, // two writes + zset
    });
  });

  it("creates the indexes again after they are dropped", async () => {
    const saver = new RedisSaver(client);
    const config = await saver.put(
      { configurable: { thread_id: "t1", checkpoint_ns: "" } },
      makeCheckpoint(),
      metadata,
      {}
    );

    await client.sendCommand(["FT.DROPINDEX", "checkpoints"]);

    // The saver still thinks the indexes exist
    await saver.put(config, makeCheckpoint(), metadata, {});
    await expect(client.ft.info("checkpoints")).rejects.toThrow();

    // A search finds the index missing, falls back to the keys, and has the
    // next write create the index again
    const listed = [];
    for await (const tuple of saver.list({
      configurable: { thread_id: "t1" },
    })) {
      listed.push(tuple);
    }
    expect(listed).toHaveLength(2);

    await saver.put(config, makeCheckpoint(), metadata, {});
    const info = await client.ft.info("checkpoints");
    expect(info.indexName).toBe("checkpoints");

    // The recreated index covers the checkpoints written before it existed
    await expect
      .poll(async () => {
        const results = await client.ft.search(
          "checkpoints",
          "@thread_id:{t1}"
        );
        return results.total;
      })
      .toBe(3);
  });

  it("sets has_writes on a stored checkpoint and leaves the rest of it as it was", async () => {
    const saver = new RedisSaver(client);
    const config = await saver.put(
      { configurable: { thread_id: "t1", checkpoint_ns: "" } },
      makeCheckpoint(),
      metadata,
      { foo: 1, baz: 1 }
    );
    const key = `checkpoint:t1::${config.configurable?.checkpoint_id}`;
    const before = (await client.json.get(key)) as Record<string, unknown>;
    expect(before.has_writes).toBe("false");

    await saver.putWrites(config, [["foo", "a"]], "task1");

    const after = (await client.json.get(key)) as Record<string, unknown>;
    expect(after).toEqual({ ...before, has_writes: "true" });

    const tuple = await saver.getTuple(config);
    expect(tuple?.pendingWrites).toEqual([["task1", "foo", "a"]]);
  });

  it("keeps has_writes when the checkpoint is put after its writes", async () => {
    const saver = new RedisSaver(client);
    const checkpoint = makeCheckpoint();
    const config = {
      configurable: {
        thread_id: "t1",
        checkpoint_ns: "",
        checkpoint_id: checkpoint.id,
      },
    };

    await saver.putWrites(config, [["__interrupt__", "paused"]], "task1");
    // No document yet: putWrites doesn't create one
    expect(await client.exists(`checkpoint:t1::${checkpoint.id}`)).toBe(0);

    await saver.put(
      { configurable: { thread_id: "t1", checkpoint_ns: "" } },
      checkpoint,
      metadata,
      { foo: 1, baz: 1 }
    );

    const doc = (await client.json.get(
      `checkpoint:t1::${checkpoint.id}`
    )) as Record<string, unknown>;
    expect(doc.has_writes).toBe("true");
    const tuple = await saver.getTuple(config);
    expect(tuple?.pendingWrites).toEqual([["task1", "__interrupt__", "paused"]]);
  });
});
