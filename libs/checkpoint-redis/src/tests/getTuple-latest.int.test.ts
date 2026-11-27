import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  Checkpoint,
  CheckpointTuple,
  emptyCheckpoint,
  ERROR,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import { RedisSaver } from "../index.js";
import { WRITE_KEYS_ZSET_PREFIX } from "../constants.js";
import { createRedisContainer } from "./redis-container.js";

type Client = Awaited<ReturnType<typeof createRedisContainer>>["client"];

/** How many KEYS commands the server has run since the last CONFIG RESETSTAT. */
async function keysCommandCount(client: Client): Promise<number> {
  const stats = await client.info("commandstats");
  const match = /cmdstat_keys:calls=(\d+)/.exec(stats);
  return match ? Number(match[1]) : 0;
}

/** What `run` returns, and how many KEYS commands Redis ran meanwhile. */
async function countingKeys<T>(client: Client, run: () => Promise<T>) {
  await client.configResetStat();
  const result = await run();
  return { result, keysCalls: await keysCommandCount(client) };
}

describe("RedisSaver.getTuple without a checkpoint_id", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let saver: RedisSaver;

  beforeAll(async () => {
    ({ client, cleanup } = await createRedisContainer());
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  beforeEach(async () => {
    await client.flushAll();
    saver = new RedisSaver(client as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Puts checkpoints with `ids` in order, each the child of the previous one,
   * and returns the config of the last.
   */
  async function putChain(
    threadId: string,
    checkpointNs: string,
    ids: string[]
  ): Promise<RunnableConfig> {
    let config: RunnableConfig = {
      configurable: { thread_id: threadId, checkpoint_ns: checkpointNs },
    };
    for (const [step, id] of ids.entries()) {
      const checkpoint: Checkpoint = {
        ...emptyCheckpoint(),
        id,
        channel_values: { step },
        channel_versions: { step: step + 1 },
      };
      config = await saver.put(
        config,
        checkpoint,
        { source: "loop", step, parents: {} },
        { step: step + 1 }
      );
    }
    return config;
  }

  /** getTuple with the index lookup failing, so it takes the KEYS path. */
  async function getTupleByScan(
    config: RunnableConfig
  ): Promise<CheckpointTuple | undefined> {
    const search = vi
      .spyOn(client.ft, "search")
      .mockRejectedValue(new Error("Index not found: checkpoints"));
    try {
      return await saver.getTuple(config);
    } finally {
      search.mockRestore();
    }
  }

  /** `count` new checkpoint ids, in ascending order. */
  function ids(count: number): string[] {
    return Array.from({ length: count }, () => uuid6(-1)).sort();
  }

  it("returns the latest checkpoint of a thread with several", async () => {
    const chain = ids(3);
    await putChain("thread-1", "", chain);
    const config = { configurable: { thread_id: "thread-1" } };

    const tuple = await saver.getTuple(config);

    expect(tuple?.checkpoint.id).toBe(chain[2]);
    expect(tuple?.config.configurable).toEqual({
      thread_id: "thread-1",
      checkpoint_ns: "",
      checkpoint_id: chain[2],
    });
    expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe(chain[1]);
    expect(tuple).toEqual(await getTupleByScan(config));
    expect(tuple).toEqual(
      await saver.getTuple({
        configurable: { thread_id: "thread-1", checkpoint_id: chain[2] },
      })
    );
  });

  it("keeps the root and a subgraph namespace apart", async () => {
    const root = ids(2);
    await putChain("thread-1", "", root);
    const child = ids(2);
    await putChain("thread-1", "child:task-1", child);
    // A later root checkpoint must not hide the subgraph's latest.
    const rootLater = ids(1);
    await putChain("thread-1", "", rootLater);

    const rootConfig = { configurable: { thread_id: "thread-1" } };
    const childConfig = {
      configurable: { thread_id: "thread-1", checkpoint_ns: "child:task-1" },
    };
    const rootTuple = await saver.getTuple(rootConfig);
    const childTuple = await saver.getTuple(childConfig);

    expect(rootTuple?.checkpoint.id).toBe(rootLater[0]);
    expect(childTuple?.checkpoint.id).toBe(child[1]);
    expect(childTuple?.config.configurable?.checkpoint_ns).toBe(
      "child:task-1"
    );
    expect(rootTuple).toEqual(await getTupleByScan(rootConfig));
    expect(childTuple).toEqual(await getTupleByScan(childConfig));
  });

  it("returns the pending writes of a superstep where one task failed", async () => {
    const config = await putChain("thread-1", "", ids(1));
    // Task "b" wrote its output; its sibling "a" then threw. Task ids sort
    // opposite to task paths, so only writesSortKey order passes.
    await saver.putWrites(
      config,
      [
        ["out", "b-1"],
        ["out", "b-2"],
      ],
      "task-b",
      "~__pregel_pull, a"
    );
    await saver.putWrites(
      config,
      [[ERROR, { message: "boom" }]],
      "task-a",
      "~__pregel_pull, b"
    );
    const latest = { configurable: { thread_id: "thread-1" } };

    const tuple = await saver.getTuple(latest);

    expect(tuple?.pendingWrites).toEqual([
      ["task-b", "out", "b-1"],
      ["task-b", "out", "b-2"],
      ["task-a", ERROR, { message: "boom" }],
    ]);
    expect(tuple).toEqual(await getTupleByScan(latest));
  });

  it("returns undefined for a thread or namespace with no checkpoints", async () => {
    await putChain("thread-1", "", ids(1));

    expect(
      await saver.getTuple({ configurable: { thread_id: "thread-2" } })
    ).toBeUndefined();
    expect(
      await saver.getTuple({
        configurable: { thread_id: "thread-1", checkpoint_ns: "child:task-1" },
      })
    ).toBeUndefined();
  });

  it("returns the higher checkpoint_id when two share a checkpoint_ts", async () => {
    const [lower, higher] = ids(2);
    // Put the higher id first, then give both the same timestamp.
    await putChain("thread-1", "", [higher]);
    await putChain("thread-1", "", [lower]);
    for (const id of [lower, higher]) {
      await client.json.set(
        `checkpoint:thread-1::${id}`,
        "$.checkpoint_ts",
        1_700_000_000_000
      );
    }

    const tuple = await saver.getTuple({
      configurable: { thread_id: "thread-1" },
    });

    expect(tuple?.checkpoint.id).toBe(higher);
  });

  it("returns the highest checkpoint_id even when many were put after it", async () => {
    const sorted = ids(25);
    const highest = sorted[sorted.length - 1];
    await putChain("thread-1", "", [highest, ...sorted.slice(0, -1)]);
    const config = { configurable: { thread_id: "thread-1" } };

    const tuple = await saver.getTuple(config);

    expect(tuple?.checkpoint.id).toBe(highest);
    expect(tuple).toEqual(await getTupleByScan(config));
  });

  it("does not return the checkpoint of a thread whose id differs only in case", async () => {
    const upper = ids(1);
    await putChain("Call-1", "", upper);
    // Put later, so it sorts first in the index for either thread.
    const lower = ids(1);
    await putChain("call-1", "", lower);

    expect(
      (await saver.getTuple({ configurable: { thread_id: "Call-1" } }))
        ?.checkpoint.id
    ).toBe(upper[0]);
    expect(
      (await saver.getTuple({ configurable: { thread_id: "call-1" } }))
        ?.checkpoint.id
    ).toBe(lower[0]);
  });

  it("issues no KEYS command", async () => {
    const config = await putChain("thread-1", "", ids(2));
    await putChain("thread-1", "child:task-1", ids(2));
    await saver.putWrites(config, [["out", 1]], "task-1", "");
    await saver.putWrites(config, [[ERROR, "boom"]], "task-2", "");
    const keysSpy = vi.spyOn(client, "keys");

    const { result, keysCalls } = await countingKeys(client, async () => [
      await saver.getTuple({ configurable: { thread_id: "thread-1" } }),
      await saver.getTuple({
        configurable: { thread_id: "thread-1", checkpoint_ns: "child:task-1" },
      }),
      await saver.getTuple({ configurable: { thread_id: "thread-2" } }),
    ]);

    expect(result[0]?.pendingWrites).toHaveLength(2);
    expect(result[1]).toBeDefined();
    expect(result[2]).toBeUndefined();
    expect(keysCalls).toBe(0);
    expect(keysSpy).not.toHaveBeenCalled();
  });

  it("falls back to scanning keys when the index doesn't exist", async () => {
    const config = await putChain("thread-1", "", ids(3));
    await saver.putWrites(config, [["out", "x"]], "task-1", "");
    const latest = { configurable: { thread_id: "thread-1" } };
    const expected = await saver.getTuple(latest);
    // Keeps the documents, so only the lookup changes.
    await client.ft.dropIndex("checkpoints");

    const { result, keysCalls } = await countingKeys(client, () =>
      saver.getTuple(latest)
    );

    expect(result).toEqual(expected);
    expect(result?.checkpoint.id).toBe(config.configurable?.checkpoint_id);
    expect(keysCalls).toBeGreaterThan(0);
  });

  it("returns no pending writes once the write keys have expired", async () => {
    const config = await putChain("thread-1", "", ids(1));
    await saver.putWrites(config, [["out", "x"]], "task-1", "");
    const checkpointId = config.configurable?.checkpoint_id;
    // The sorted set still lists the keys; the documents are gone.
    const writeKeys = await client.zRange(
      `${WRITE_KEYS_ZSET_PREFIX}:thread-1::${checkpointId}`,
      0,
      -1
    );
    await client.del(writeKeys);

    const tuple = await saver.getTuple({
      configurable: { thread_id: "thread-1" },
    });

    expect(tuple?.checkpoint.id).toBe(checkpointId);
    expect(tuple?.pendingWrites).toBeUndefined();
  });

  it("refreshes the TTL of the latest checkpoint on read", async () => {
    saver = new RedisSaver(client as any, {
      defaultTTL: 1,
      refreshOnRead: true,
    });
    const config = await putChain("thread-1", "", ids(2));
    const key = `checkpoint:thread-1::${config.configurable?.checkpoint_id}`;
    await client.expire(key, 5);

    await saver.getTuple({ configurable: { thread_id: "thread-1" } });

    expect(await client.ttl(key)).toBeGreaterThan(5);
  });
});
