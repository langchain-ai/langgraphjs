import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyCheckpoint, uuid6 } from "@langchain/langgraph-checkpoint";
import { RedisSaver } from "../index.js";
import { createRedisContainer } from "./redis-container.js";

type Client = Awaited<ReturnType<typeof createRedisContainer>>["client"];

// An id that sorts after every uuid6, for a checkpoint that does not exist.
const GONE = "ffffffff-ffff-6fff-bfff-ffffffffffff";

describe("RedisSaver head pointer", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ client, cleanup } = await createRedisContainer());
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  beforeEach(async () => {
    await client.flushAll();
  });

  const config = { configurable: { thread_id: "thread", checkpoint_ns: "" } };

  async function put(saver: RedisSaver, id: string, ns = "") {
    await saver.put(
      { configurable: { thread_id: "thread", checkpoint_ns: ns } },
      { ...emptyCheckpoint(), id, channel_values: { ch: id } },
      { source: "loop", step: 0, parents: {} },
      {}
    );
  }

  /** The checkpoint id `getTuple` returns, and how many KEYS calls it made. */
  async function latest(saver: RedisSaver) {
    const keys = vi.spyOn(client, "keys");
    try {
      const tuple = await saver.getTuple(config);
      return {
        id: tuple?.config.configurable?.checkpoint_id,
        keysCalls: keys.mock.calls.length,
      };
    } finally {
      keys.mockRestore();
    }
  }

  it("reads the latest checkpoint without KEYS", async () => {
    const saver = new RedisSaver(client);
    const [older, newer] = [uuid6(-1), uuid6(0)];
    await put(saver, older);
    await put(saver, newer);

    expect(await latest(saver)).toEqual({ id: newer, keysCalls: 0 });
  });

  it("keeps the latest checkpoint when an older one is written again", async () => {
    const saver = new RedisSaver(client);
    const [older, newer] = [uuid6(-1), uuid6(0)];
    await put(saver, older);
    await put(saver, newer);
    await put(saver, older);

    expect(await latest(saver)).toEqual({ id: newer, keysCalls: 0 });
  });

  it("keeps a pointer per namespace", async () => {
    const saver = new RedisSaver(client);
    const [root, child] = [uuid6(0), uuid6(1)];
    await put(saver, root);
    await put(saver, child, "child");

    expect(await client.hGetAll("checkpoint_head:thread")).toEqual({
      "": root,
      child,
    });
    expect(await latest(saver)).toEqual({ id: root, keysCalls: 0 });
  });

  it("falls back to KEYS once for a thread without a pointer", async () => {
    const saver = new RedisSaver(client);
    const id = uuid6(0);
    await put(saver, id);
    await client.del("checkpoint_head:thread");

    expect(await latest(saver)).toEqual({ id, keysCalls: 1 });
    expect(await latest(saver)).toEqual({ id, keysCalls: 0 });
  });

  it("replaces a pointer to a checkpoint that is gone, even one that sorts later", async () => {
    const saver = new RedisSaver(client);
    const id = uuid6(0);
    await put(saver, id);
    await client.hSet("checkpoint_head:thread", "", GONE);

    expect(await latest(saver)).toEqual({ id, keysCalls: 1 });
    expect(await client.hGet("checkpoint_head:thread", "")).toBe(id);
  });

  it("removes a pointer left on a thread without checkpoints", async () => {
    const saver = new RedisSaver(client);
    await client.hSet("checkpoint_head:thread", "", GONE);

    expect(await saver.getTuple(config)).toBeUndefined();
    expect(await client.hExists("checkpoint_head:thread", "")).toBe(false);
  });

  it("gives the pointer the checkpoints' TTL and renews it on read", async () => {
    const saver = new RedisSaver(client, { defaultTTL: 10, refreshOnRead: true });
    await put(saver, uuid6(0));
    expect(await client.ttl("checkpoint_head:thread")).toBeGreaterThan(590);

    await client.expire("checkpoint_head:thread", 5);
    await saver.getTuple(config);
    expect(await client.ttl("checkpoint_head:thread")).toBeGreaterThan(590);
  });

  it("deleteThread removes the pointer", async () => {
    const saver = new RedisSaver(client);
    await put(saver, uuid6(0));
    await saver.deleteThread("thread");

    expect(await client.exists("checkpoint_head:thread")).toBe(0);
  });
});
