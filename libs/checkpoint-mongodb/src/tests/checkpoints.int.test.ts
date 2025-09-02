import { describe, it, expect, afterEach, afterAll } from "vitest";
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

afterEach(async () => {
  const db = client.db();
  await db.dropCollection("checkpoints");
  await db.dropCollection("checkpoint_writes");
});

afterAll(async () => {
  await client.close();
});

describe("MongoDBSaver", () => {
  it.each([{ ttl: undefined }, { ttl: { expireAfterSeconds: 60 * 60 } }])(
    "should save and retrieve checkpoints correctly (%s)",
    async ({ ttl }) => {
      const saver = new MongoDBSaver({ client, ttl });
      await saver.setup();

      const threadId = crypto.randomUUID();

      // get undefined checkpoint
      const undefinedCheckpoint = await saver.getTuple({
        configurable: { thread_id: threadId },
      });
      expect(undefinedCheckpoint).toBeUndefined();

      // save first checkpoint
      const runnableConfig = await saver.put(
        { configurable: { thread_id: threadId } },
        checkpoint1,
        { source: "update", step: -1, parents: {} }
      );
      expect(runnableConfig).toEqual({
        configurable: {
          thread_id: threadId,
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
            thread_id: threadId,
          },
        },
        [["bar", "baz"]],
        "foo"
      );

      // get first checkpoint tuple
      const firstCheckpointTuple = await saver.getTuple({
        configurable: { thread_id: threadId },
      });
      expect(firstCheckpointTuple?.config).toEqual({
        configurable: {
          thread_id: threadId,
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
            thread_id: threadId,
            checkpoint_id: "2024-04-18T17:19:07.952Z",
          },
        },
        checkpoint2,
        { source: "update", step: -1, parents: {} }
      );

      // verify that parentTs is set and retrieved correctly for second checkpoint
      const secondCheckpointTuple = await saver.getTuple({
        configurable: { thread_id: threadId },
      });
      expect(secondCheckpointTuple?.parentConfig).toEqual({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: "",
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      });

      // list checkpoints
      const checkpointTupleGenerator = saver.list({
        configurable: { thread_id: threadId },
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
    }
  );

  it("should delete thread", async () => {
    const threadId1 = crypto.randomUUID();
    const threadId2 = crypto.randomUUID();

    const saver = new MongoDBSaver({ client });

    await saver.put(
      { configurable: { thread_id: threadId1 } },
      emptyCheckpoint(),
      {
        source: "update",
        step: -1,
        parents: {},
      }
    );

    await saver.put(
      { configurable: { thread_id: threadId2 } },
      emptyCheckpoint(),
      {
        source: "update",
        step: -1,
        parents: {},
      }
    );

    await saver.deleteThread(threadId1);

    expect(
      await saver.getTuple({ configurable: { thread_id: threadId1 } })
    ).toBeUndefined();
    expect(
      await saver.getTuple({ configurable: { thread_id: threadId2 } })
    ).toBeDefined();
  });
});
