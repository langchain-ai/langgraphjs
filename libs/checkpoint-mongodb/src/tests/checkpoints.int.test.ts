import { describe, it, expect, afterAll, afterEach } from "vitest";
import { MongoClient } from "mongodb";
import {
  Checkpoint,
  CheckpointTuple,
  emptyCheckpoint,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { MongoDBSaver } from "../index.js";

const checkpoint1: Checkpoint = {
  v: 4,
  id: uuid6(-1),
  ts: "2024-04-19T17:19:07.952Z",
  channel_values: {
    someKey1: "someValue1",
  },
  channel_versions: {
    someKey2: 1,
  },
  versions_seen: {
    someKey3: {
      someKey4: 1,
    },
  },
};

const checkpoint2: Checkpoint = {
  v: 4,
  id: uuid6(1),
  ts: "2024-04-20T17:19:07.952Z",
  channel_values: {
    someKey1: "someValue2",
  },
  channel_versions: {
    someKey2: 2,
  },
  versions_seen: {
    someKey3: {
      someKey4: 2,
    },
  },
};

const client = new MongoClient(getEnvironmentVariable("MONGODB_URL")!, {
  auth: { username: "user", password: "password" },
});

afterAll(async () => {
  const db = client.db();
  await db.dropCollection("checkpoints").catch(() => {});
  await db.dropCollection("checkpoint_writes").catch(() => {});
  await db.dropCollection("checkpoints_ttl").catch(() => {});
  await db.dropCollection("checkpoint_writes_ttl").catch(() => {});
  await client.close();
});

describe("MongoDBSaver", () => {
  it("should save and retrieve checkpoints correctly", async () => {
    const saver = new MongoDBSaver({ client });

    // get undefined checkpoint
    const undefinedCheckpoint = await saver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(undefinedCheckpoint).toBeUndefined();

    // save first checkpoint
    const runnableConfig = await saver.put(
      { configurable: { thread_id: "1" } },
      checkpoint1,
      { source: "update", step: -1, parents: {} }
    );
    expect(runnableConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });

    // add some writes
    await saver.putWrites(
      {
        configurable: {
          checkpoint_id: checkpoint1.id,
          checkpoint_ns: "",
          thread_id: "1",
        },
      },
      [["bar", "baz"]],
      "foo"
    );

    // get first checkpoint tuple
    const firstCheckpointTuple = await saver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(firstCheckpointTuple?.config).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });
    expect(firstCheckpointTuple?.checkpoint).toEqual(checkpoint1);
    expect(firstCheckpointTuple?.parentConfig).toBeUndefined();
    expect(firstCheckpointTuple?.pendingWrites).toEqual([
      ["foo", "bar", "baz"],
    ]);

    // save second checkpoint
    await saver.put(
      {
        configurable: {
          thread_id: "1",
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      },
      checkpoint2,
      { source: "update", step: -1, parents: {} }
    );

    // verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await saver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(secondCheckpointTuple?.parentConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: "2024-04-18T17:19:07.952Z",
      },
    });

    // list checkpoints
    const checkpointTupleGenerator = saver.list({
      configurable: { thread_id: "1" },
    });
    const checkpointTuples: CheckpointTuple[] = [];
    for await (const checkpoint of checkpointTupleGenerator) {
      checkpointTuples.push(checkpoint);
    }
    expect(checkpointTuples.length).toBe(2);

    const checkpointTuple1 = checkpointTuples[0];
    const checkpointTuple2 = checkpointTuples[1];
    expect(checkpointTuple1.checkpoint.ts).toBe("2024-04-20T17:19:07.952Z");
    expect(checkpointTuple2.checkpoint.ts).toBe("2024-04-19T17:19:07.952Z");
  });

  it("should delete thread", async () => {
    const saver = new MongoDBSaver({ client });
    await saver.put({ configurable: { thread_id: "1" } }, emptyCheckpoint(), {
      source: "update",
      step: -1,
      parents: {},
    });

    await saver.put({ configurable: { thread_id: "2" } }, emptyCheckpoint(), {
      source: "update",
      step: -1,
      parents: {},
    });

    await saver.deleteThread("1");

    expect(
      await saver.getTuple({ configurable: { thread_id: "1" } })
    ).toBeUndefined();
    expect(
      await saver.getTuple({ configurable: { thread_id: "2" } })
    ).toBeDefined();
  });

  describe("TTL support", () => {
    const ttlCheckpointCollection = "checkpoints_ttl";
    const ttlWritesCollection = "checkpoint_writes_ttl";

    afterEach(async () => {
      const db = client.db();
      await db.collection(ttlCheckpointCollection).deleteMany({});
      await db.collection(ttlWritesCollection).deleteMany({});
    });

    it("should create TTL indexes on setup()", async () => {
      const saver = new MongoDBSaver({
        client,
        ttl: 3600,
        checkpointCollectionName: ttlCheckpointCollection,
        checkpointWritesCollectionName: ttlWritesCollection,
      });

      await saver.setup();

      const db = client.db();
      const checkpointIndexes = await db
        .collection(ttlCheckpointCollection)
        .indexes();
      const writesIndexes = await db.collection(ttlWritesCollection).indexes();

      const checkpointTtlIndex = checkpointIndexes.find(
        (idx) => idx.key?.upserted_at === 1
      );
      const writesTtlIndex = writesIndexes.find(
        (idx) => idx.key?.upserted_at === 1
      );

      expect(checkpointTtlIndex).toBeDefined();
      expect(checkpointTtlIndex?.expireAfterSeconds).toBe(3600);
      expect(writesTtlIndex).toBeDefined();
      expect(writesTtlIndex?.expireAfterSeconds).toBe(3600);
    });

    it("should add upserted_at field to checkpoints when TTL is enabled", async () => {
      const saver = new MongoDBSaver({
        client,
        ttl: 3600,
        checkpointCollectionName: ttlCheckpointCollection,
        checkpointWritesCollectionName: ttlWritesCollection,
      });

      const beforePut = new Date();
      await saver.put(
        { configurable: { thread_id: "ttl-test-1" } },
        checkpoint1,
        { source: "update", step: -1, parents: {} }
      );
      const afterPut = new Date();

      const db = client.db();
      const doc = await db
        .collection(ttlCheckpointCollection)
        .findOne({ thread_id: "ttl-test-1" });

      expect(doc?.upserted_at).toBeDefined();
      expect(doc?.upserted_at).toBeInstanceOf(Date);
      expect(doc?.upserted_at.getTime()).toBeGreaterThanOrEqual(
        beforePut.getTime()
      );
      expect(doc?.upserted_at.getTime()).toBeLessThanOrEqual(afterPut.getTime());
    });

    it("should add upserted_at field to writes when TTL is enabled", async () => {
      const saver = new MongoDBSaver({
        client,
        ttl: 3600,
        checkpointCollectionName: ttlCheckpointCollection,
        checkpointWritesCollectionName: ttlWritesCollection,
      });

      const beforePut = new Date();
      await saver.putWrites(
        {
          configurable: {
            thread_id: "ttl-test-2",
            checkpoint_ns: "",
            checkpoint_id: checkpoint1.id,
          },
        },
        [["channel1", "value1"]],
        "task1"
      );
      const afterPut = new Date();

      const db = client.db();
      const doc = await db
        .collection(ttlWritesCollection)
        .findOne({ thread_id: "ttl-test-2" });

      expect(doc?.upserted_at).toBeDefined();
      expect(doc?.upserted_at).toBeInstanceOf(Date);
      expect(doc?.upserted_at.getTime()).toBeGreaterThanOrEqual(
        beforePut.getTime()
      );
      expect(doc?.upserted_at.getTime()).toBeLessThanOrEqual(afterPut.getTime());
    });

    it("should NOT add upserted_at field when TTL is not enabled", async () => {
      const saver = new MongoDBSaver({
        client,
        checkpointCollectionName: ttlCheckpointCollection,
        checkpointWritesCollectionName: ttlWritesCollection,
      });

      await saver.put(
        { configurable: { thread_id: "no-ttl-test" } },
        checkpoint1,
        { source: "update", step: -1, parents: {} }
      );

      const db = client.db();
      const doc = await db
        .collection(ttlCheckpointCollection)
        .findOne({ thread_id: "no-ttl-test" });

      expect(doc?.upserted_at).toBeUndefined();
    });
  });
});
