import { describe, it, expect } from "vitest";
import { RedisSaver } from "../index.js";
import { ShallowRedisSaver } from "../shallow.js";

// Regression for https://github.com/langchain-ai/langgraphjs/issues/3352
//
// When `ttlConfig.defaultTTL` is set, `put()` and `putWrites()` used to write
// keys first and apply the TTL in a separate `EXPIRE` pass. A crash between
// the two left checkpoint data without a TTL forever, and a failed `EXPIRE`
// was only logged. The fix writes the keys and sets their TTLs in a single
// MULTI/EXEC transaction, which is atomic on the server.
//
// These tests observe the client call shape with a mock, the same approach as
// `putWrites.test.ts`: with TTL configured, writes and their EXPIREs must be
// queued on one `multi()` transaction; without TTL, no transaction is used.
type QueuedCommand = { cmd: string; args: unknown[] };

const makeMockClient = () => {
  const transactions: QueuedCommand[][] = [];
  const directExpireCalls: unknown[][] = [];
  const client = {
    exists: async () => 0,
    keys: async () => [],
    del: async () => 0,
    expire: async (...args: unknown[]) => {
      directExpireCalls.push(args);
      return 1;
    },
    json: {
      set: async () => "OK",
      get: async () => null,
    },
    zAdd: async () => 0,
    ft: { info: async () => ({}) },
    multi: () => {
      const queued: QueuedCommand[] = [];
      const tx: Record<string, any> = {
        json: {
          set: (...args: unknown[]) => {
            queued.push({ cmd: "json.set", args });
            return tx;
          },
        },
        zAdd: (...args: unknown[]) => {
          queued.push({ cmd: "zAdd", args });
          return tx;
        },
        expire: (...args: unknown[]) => {
          queued.push({ cmd: "expire", args });
          return tx;
        },
        exec: async () => {
          transactions.push(queued);
          return [];
        },
      };
      return tx;
    },
  } as never;
  return { client, transactions, directExpireCalls };
};

const config = {
  configurable: {
    thread_id: "t",
    checkpoint_ns: "",
    checkpoint_id: "c1",
  },
};

const checkpoint = {
  v: 1,
  id: "c2",
  ts: "2026-11-12T00:00:00.000Z",
  channel_values: { foo: "v_foo" },
  channel_versions: { foo: 1 },
  versions_seen: {},
};

const metadata = { source: "update", step: 1, parents: {} } as never;

const ttlConfig = { defaultTTL: 60 }; // 60 minutes = 3600 seconds

describe("RedisSaver TTL atomicity", () => {
  it("put() writes blobs, checkpoint and TTLs in one MULTI/EXEC transaction", async () => {
    const { client, transactions } = makeMockClient();
    const saver = new RedisSaver(client, ttlConfig);

    await saver.put(config, checkpoint as never, metadata, { foo: 1 });

    expect(transactions).toHaveLength(1);
    const tx = transactions[0];
    const blobKey = "checkpoint_blob:t::foo:1";
    const checkpointKey = "checkpoint:t::c2";

    // blob write + its TTL
    expect(tx.some((c) => c.cmd === "json.set" && c.args[0] === blobKey)).toBe(
      true,
    );
    expect(
      tx.some(
        (c) =>
          c.cmd === "expire" && c.args[0] === blobKey && c.args[1] === 3600,
      ),
    ).toBe(true);
    // checkpoint write + its TTL
    expect(
      tx.some((c) => c.cmd === "json.set" && c.args[0] === checkpointKey),
    ).toBe(true);
    expect(
      tx.some(
        (c) =>
          c.cmd === "expire" &&
          c.args[0] === checkpointKey &&
          c.args[1] === 3600,
      ),
    ).toBe(true);
  });

  it("put() without TTL does not use a transaction", async () => {
    const { client, transactions } = makeMockClient();
    const saver = new RedisSaver(client);

    await saver.put(config, checkpoint as never, metadata, { foo: 1 });

    expect(transactions).toHaveLength(0);
  });

  it("putWrites() writes docs, zset and TTLs in one MULTI/EXEC transaction", async () => {
    const { client, transactions, directExpireCalls } = makeMockClient();
    const saver = new RedisSaver(client, ttlConfig);

    await saver.putWrites(
      config,
      [
        ["foo", "v_foo"],
        ["bar", "v_bar"],
      ],
      "task-1",
    );

    expect(transactions).toHaveLength(1);
    const tx = transactions[0];
    const zsetKey = "write_keys_zset:t::c1";

    for (const idx of [0, 1]) {
      const writeKey = `checkpoint_write:t::c1:task-1:${idx}`;
      expect(
        tx.some(
          (c) =>
            c.cmd === "json.set" &&
            c.args[0] === writeKey &&
            (c.args[3] as { NX?: boolean })?.NX === true,
        ),
      ).toBe(true);
      expect(
        tx.some(
          (c) =>
            c.cmd === "expire" && c.args[0] === writeKey && c.args[1] === 3600,
        ),
      ).toBe(true);
    }
    expect(tx.some((c) => c.cmd === "zAdd" && c.args[0] === zsetKey)).toBe(
      true,
    );
    expect(
      tx.some(
        (c) =>
          c.cmd === "expire" && c.args[0] === zsetKey && c.args[1] === 3600,
      ),
    ).toBe(true);

    // No TTL applied outside the transaction.
    expect(directExpireCalls).toHaveLength(0);
  });

  it("putWrites() without TTL writes directly without a transaction", async () => {
    const { client, transactions } = makeMockClient();
    const saver = new RedisSaver(client);

    await saver.putWrites(config, [["foo", "v_foo"]], "task-1");

    expect(transactions).toHaveLength(0);
  });
});

describe("ShallowRedisSaver TTL atomicity", () => {
  it("put() writes the checkpoint and its TTL in one MULTI/EXEC transaction", async () => {
    const { client, transactions } = makeMockClient();
    const saver = new ShallowRedisSaver(client, ttlConfig);

    await saver.put(config, checkpoint as never, metadata, { foo: 1 });

    expect(transactions).toHaveLength(1);
    const tx = transactions[0];
    const checkpointKey = "checkpoint:t::shallow";
    expect(
      tx.some((c) => c.cmd === "json.set" && c.args[0] === checkpointKey),
    ).toBe(true);
    expect(
      tx.some(
        (c) =>
          c.cmd === "expire" &&
          c.args[0] === checkpointKey &&
          c.args[1] === 3600,
      ),
    ).toBe(true);
  });

  it("putWrites() writes docs, zset and TTLs in one MULTI/EXEC transaction", async () => {
    const { client, transactions, directExpireCalls } = makeMockClient();
    const saver = new ShallowRedisSaver(client, ttlConfig);

    await saver.putWrites(config, [["foo", "v_foo"]], "task-1");

    expect(transactions).toHaveLength(1);
    const tx = transactions[0];
    const writeKey = "checkpoint_write:t::c1:task-1:0";
    const zsetKey = "write_keys_zset:t::c1";
    expect(tx.some((c) => c.cmd === "json.set" && c.args[0] === writeKey)).toBe(
      true,
    );
    expect(
      tx.some(
        (c) =>
          c.cmd === "expire" && c.args[0] === writeKey && c.args[1] === 3600,
      ),
    ).toBe(true);
    expect(tx.some((c) => c.cmd === "zAdd" && c.args[0] === zsetKey)).toBe(
      true,
    );
    expect(
      tx.some(
        (c) =>
          c.cmd === "expire" && c.args[0] === zsetKey && c.args[1] === 3600,
      ),
    ).toBe(true);
    expect(directExpireCalls).toHaveLength(0);
  });
});
