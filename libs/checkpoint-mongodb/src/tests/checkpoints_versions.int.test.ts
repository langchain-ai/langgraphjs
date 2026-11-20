import { afterAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import {
  emptyCheckpoint,
  uuid6,
  type Checkpoint,
} from "@langchain/langgraph-checkpoint";
import { MongoDBSaver } from "../index.js";

const client = new MongoClient(process.env.MONGODB_URL!, {
  auth: { username: "user", password: "password" },
});
const dbName = "checkpoint_versions_tests";
const db = client.db(dbName);
const metadata = { source: "update" as const, step: 0, parents: {} };
const config = (thread: string, ns = "") => ({
  configurable: { thread_id: thread, checkpoint_ns: ns },
});
const checkpoint = (
  values: Record<string, unknown>,
  versions: Record<string, number | string>
): Checkpoint => ({
  ...emptyCheckpoint(),
  id: uuid6(),
  channel_values: values,
  channel_versions: versions,
});
const saverFor = (name: string, extra = {}) =>
  new MongoDBSaver({
    client,
    dbName,
    checkpointCollectionName: name,
    checkpointWritesCollectionName: `${name}_writes`,
    ...extra,
  });
const rows = (name: string) => db.collection(name);

afterAll(async () => {
  await client.close();
});

describe("version-aware checkpoint storage", () => {
  it("stores each version once while partial and empty writes retain full reads", async () => {
    const name = `dedup_${uuid6()}`;
    const saver = saverFor(name);
    expect(await saver.setup()).toEqual([]);
    const first = checkpoint(
      { foo: "first", baz: "retained" },
      { foo: 1, baz: 1 }
    );
    const second = checkpoint(
      { foo: "second", baz: "retained" },
      { foo: 2, baz: 1 }
    );
    const third = checkpoint(
      { ...second.channel_values },
      { ...second.channel_versions }
    );
    const before = structuredClone(second);
    const a = await saver.put(config("one"), first, metadata, {
      foo: 1,
      baz: 1,
    });
    const b = await saver.put(a, second, metadata, { foo: 2 });
    const c = await saver.put(b, third, metadata, {});
    expect(second).toEqual(before);
    for (const [saved, expected] of [
      [a, first],
      [b, second],
      [c, third],
    ] as const) {
      expect((await saver.getTuple(saved))?.checkpoint).toEqual(expected);
    }
    const listed = [];
    for await (const tuple of saver.list(config("one")))
      listed.push(tuple.checkpoint);
    expect(listed).toEqual([third, second, first]);
    expect(await rows(`${name}_blobs`).countDocuments({})).toBe(3);
    const stored = await rows(name).findOne({ checkpoint_id: third.id });
    expect(
      (
        await saver.serde.loadsTyped(
          stored!.type,
          stored!.checkpoint.value("utf8")
        )
      ).channel_values
    ).toEqual({});
    await saver.putWrites(c, [["pending", "write"]], "task");
    expect((await saver.getTuple(c))?.pendingWrites).toEqual([
      ["task", "pending", "write"],
    ]);
    const reopenedClient = new MongoClient(process.env.MONGODB_URL!, {
      auth: { username: "user", password: "password" },
    });
    try {
      const reopened = new MongoDBSaver({
        client: reopenedClient,
        dbName,
        checkpointCollectionName: name,
        checkpointWritesCollectionName: `${name}_writes`,
      });
      expect((await reopened.getTuple(c))?.checkpoint).toEqual(third);
      const history = [];
      for await (const tuple of reopened.list(config("one")))
        history.push(tuple.checkpoint);
      expect(history).toEqual([third, second, first]);
    } finally {
      await reopenedClient.close();
    }
  });

  it("backfills first partial/empty writes and preserves old full rows and unversioned values", async () => {
    const name = `legacy_${uuid6()}`;
    const saver = saverFor(name);
    await saver.setup();
    const value = checkpoint(
      { foo: "retained", unversioned: "inline" },
      { foo: 1 }
    );
    const old = await saver.put(config("old"), value, metadata);
    expect(
      (await rows(name).findOne({ thread_id: "old" }))?.channel_blobs
    ).toBeUndefined();
    const next = checkpoint({ ...value.channel_values }, { foo: 1 });
    const saved = await saver.put(old, next, metadata, {});
    expect((await saver.getTuple(saved))?.checkpoint).toEqual(next);
    expect((await saver.getTuple(old))?.checkpoint).toEqual(value);
    for (const [thread, versions] of [
      ["partial", { foo: 1 }],
      ["empty", {}],
    ] as const) {
      const initial = checkpoint(
        { foo: "first", baz: "also present" },
        { foo: 1, baz: 1 }
      );
      const c = await saver.put(config(thread), initial, metadata, versions);
      expect((await saver.getTuple(c))?.checkpoint).toEqual(initial);
    }
    // Replacing a row with an omitted-argument full write must remove old refs.
    await saver.put(saved, next, metadata);
    expect(
      (await rows(name).findOne({ checkpoint_id: next.id }))?.channel_blobs
    ).toBeUndefined();
    expect((await saver.getTuple(saved))?.checkpoint).toEqual(next);
  });

  it("does not revive absent channels from retained versions", async () => {
    const saver = saverFor(`absent_${uuid6()}`);
    await saver.setup();
    const first = checkpoint(
      { foo: "first", removed: "old" },
      { foo: 1, removed: 1 }
    );
    const a = await saver.put(
      config("one"),
      first,
      metadata,
      first.channel_versions
    );
    const second = checkpoint({ foo: "second" }, { foo: 2, removed: 1 });
    const b = await saver.put(a, second, metadata, { foo: 2 });
    expect((await saver.getTuple(b))?.checkpoint.channel_values).toEqual({
      foo: "second",
    });
    expect((await saver.getTuple(a))?.checkpoint.channel_values).toEqual(
      first.channel_values
    );
  });

  it("isolates forks, namespaces, threads and configured collections", async () => {
    const name = `isolation_${uuid6()}`;
    const saver = saverFor(name);
    const other = saverFor(`${name}_other`);
    await saver.setup();
    await other.setup();
    const first = checkpoint(
      { foo: "original", baz: "stable" },
      { foo: 1, baz: 1 }
    );
    const a = await saver.put(
      config("one"),
      first,
      metadata,
      first.channel_versions
    );
    const sibling = checkpoint(
      { foo: "sibling", baz: "stable" },
      { foo: 2, baz: 1 }
    );
    const b = await saver.put(a, sibling, metadata, { foo: 2 });
    const fork = checkpoint({ foo: "fork", baz: "stable" }, { foo: 2, baz: 1 });
    const c = await saver.put(a, fork, metadata, { foo: 2 });
    expect((await saver.getTuple(c))?.parentConfig).toEqual(a);
    expect((await saver.getTuple(c))?.checkpoint).toEqual(fork);
    expect((await saver.getTuple(b))?.checkpoint).toEqual(sibling);
    for (const [target, cfg, value] of [
      [saver, config("two"), "other thread"],
      [saver, config("one", "ns"), "other namespace"],
      [other, config("one"), "other collection"],
    ] as const) {
      const cp = checkpoint({ foo: value }, { foo: 1 });
      const saved = await target.put(cfg, cp, metadata, { foo: 1 });
      expect((await target.getTuple(saved))?.checkpoint.channel_values).toEqual(
        cp.channel_values
      );
    }
    expect((await saver.getTuple(a))?.checkpoint).toEqual(first);
    await saver.deleteThread("one");
    expect(
      await rows(`${name}_blobs`).countDocuments({ thread_id: "one" })
    ).toBe(0);
    expect(await saver.getTuple(a)).toBeUndefined();
    expect(
      (await saver.getTuple(config("two")))?.checkpoint.channel_values.foo
    ).toBe("other thread");
    expect(
      (await other.getTuple(config("one")))?.checkpoint.channel_values.foo
    ).toBe("other collection");
  });

  it("keeps typed version identities and custom serializer bytes", async () => {
    const name = `serde_${uuid6()}`;
    const original = saverFor(name).serde;
    const serde = {
      async dumpsTyped(value: unknown): Promise<[string, Uint8Array]> {
        const [type, bytes] = await original.dumpsTyped(value);
        return [`custom/${type}`, bytes];
      },
      loadsTyped(type: string, data: Uint8Array | string) {
        expect(type.startsWith("custom/")).toBe(true);
        return original.loadsTyped(type.slice(7), data);
      },
    };
    const saver = new MongoDBSaver(
      {
        client,
        dbName,
        checkpointCollectionName: name,
        checkpointWritesCollectionName: `${name}_writes`,
      },
      serde
    );
    await saver.setup();
    const first = checkpoint(
      { foo: new Uint8Array([0, 128, 255]) },
      { foo: 1 }
    );
    const a = await saver.put(config("one"), first, metadata, { foo: 1 });
    const second = checkpoint(
      { foo: new Uint8Array([0, 128, 255]) },
      { foo: "1" }
    );
    const b = await saver.put(a, second, metadata, { foo: "1" });
    expect((await saver.getTuple(a))?.checkpoint.channel_values.foo).toEqual(
      first.channel_values.foo
    );
    expect((await saver.getTuple(b))?.checkpoint.channel_values.foo).toEqual(
      second.channel_values.foo
    );
    expect(await rows(`${name}_blobs`).countDocuments({})).toBe(2);
    expect(
      (await rows(`${name}_blobs`).find().toArray()).map((x) => x.type)
    ).toEqual(["custom/bytes", "custom/bytes"]);
  });

  it("retains still-referenced version data for the lifetime of later TTL checkpoints", async () => {
    const name = `ttl_${uuid6()}`;
    const saver = saverFor(name, { ttl: 3600 });
    await saver.setup();
    const first = checkpoint({ foo: "unchanged" }, { foo: 1 });
    const a = await saver.put(config("one"), first, metadata, { foo: 1 });
    await rows(`${name}_blobs`).updateMany(
      {},
      { $set: { upserted_at: new Date(0) } }
    );
    const second = checkpoint({ foo: "unchanged" }, { foo: 1 });
    const b = await saver.put(a, second, metadata, {});
    const blob = await rows(`${name}_blobs`).findOne({});
    const doc = await rows(name).findOne({ checkpoint_id: second.id });
    expect(blob?.upserted_at.getTime()).toBeGreaterThanOrEqual(
      doc?.upserted_at.getTime()
    );
    expect(
      (await rows(`${name}_blobs`).indexes()).some(
        (x) => x.expireAfterSeconds === 3600
      )
    ).toBe(true);
    // Simulate expiration of the older checkpoint while the later one is live.
    await rows(name).deleteOne({ checkpoint_id: first.id });
    expect((await saver.getTuple(b))?.checkpoint).toEqual(second);
  });

  it("does not silently return truncated state when a referenced value is missing", async () => {
    const name = `missing_${uuid6()}`;
    const saver = saverFor(name);
    await saver.setup();
    const cp = checkpoint({ foo: "value" }, { foo: 1 });
    const c = await saver.put(config("one"), cp, metadata, { foo: 1 });
    await rows(`${name}_blobs`).deleteMany({});
    await expect(saver.getTuple(c)).rejects.toThrow("Missing channel value");
    await expect(async () => {
      for await (const _ of saver.list(config("one"))) {
        /* read */
      }
    }).rejects.toThrow("Missing channel value");
  });

  it("shares immutable versions across concurrent checkpoint writers", async () => {
    const name = `concurrent_${uuid6()}`;
    const saver = saverFor(name, { ttl: 3600 });
    await saver.setup();
    const checkpoints = Array.from({ length: 6 }, () =>
      checkpoint({ foo: "shared" }, { foo: 1 })
    );
    const configs = await Promise.all(
      checkpoints.map((cp) =>
        saver.put(config("one"), cp, metadata, { foo: 1 })
      )
    );
    expect(await rows(`${name}_blobs`).countDocuments({})).toBe(1);
    const blob = await rows(`${name}_blobs`).findOne({});
    for (const [i, c] of configs.entries()) {
      expect((await saver.getTuple(c))?.checkpoint).toEqual(checkpoints[i]);
      const doc = await rows(name).findOne({
        checkpoint_id: checkpoints[i].id,
      });
      expect(blob?.upserted_at.getTime()).toBeGreaterThanOrEqual(
        doc?.upserted_at.getTime()
      );
    }
  });
});
