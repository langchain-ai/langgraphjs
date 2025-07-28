import { describe, it, expect } from "vitest";
import {
  Checkpoint,
  CheckpointTuple,
  emptyCheckpoint,
  TASKS,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { SqliteSaver } from "../index.js";

const checkpoint1: Checkpoint = {
  v: 1,
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
  v: 1,
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

describe("SqliteSaver", () => {
  it("should save and retrieve checkpoints correctly", async () => {
    const sqliteSaver = SqliteSaver.fromConnString(":memory:");

    // get undefined checkpoint
    const undefinedCheckpoint = await sqliteSaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(undefinedCheckpoint).toBeUndefined();

    // save first checkpoint
    const runnableConfig = await sqliteSaver.put(
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
    await sqliteSaver.putWrites(
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
    const firstCheckpointTuple = await sqliteSaver.getTuple({
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
    await sqliteSaver.put(
      {
        configurable: {
          thread_id: "1",
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      },
      checkpoint2,
      {
        source: "update",
        step: -1,
        parents: { "": checkpoint1.id },
      }
    );

    // verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await sqliteSaver.getTuple({
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
    const checkpointTupleGenerator = await sqliteSaver.list(
      {
        configurable: { thread_id: "1" },
      },
      {
        filter: {
          source: "update",
          step: -1,
          parents: { "": checkpoint1.id },
        },
      }
    );
    const checkpointTuples: CheckpointTuple[] = [];
    for await (const checkpoint of checkpointTupleGenerator) {
      checkpointTuples.push(checkpoint);
    }
    expect(checkpointTuples.length).toBe(1);

    const checkpointTuple1 = checkpointTuples[0];
    expect(checkpointTuple1.checkpoint.ts).toBe("2024-04-20T17:19:07.952Z");
  });

  it("should delete thread", async () => {
    const saver = SqliteSaver.fromConnString(":memory:");
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

  it("pending sends migration", async () => {
    const saver = SqliteSaver.fromConnString(":memory:");

    let config: RunnableConfig = {
      configurable: { thread_id: "thread-1", checkpoint_ns: "" },
    };

    const checkpoint0 = emptyCheckpoint();

    config = await saver.put(config, checkpoint0, {
      source: "loop",
      parents: {},
      step: 0,
    });

    await saver.putWrites(
      config,
      [
        [TASKS, "send-1"],
        [TASKS, "send-2"],
      ],
      "task-1"
    );
    await saver.putWrites(config, [[TASKS, "send-3"]], "task-2");

    // check that fetching checkpount 0 doesn't attach pending sends
    // (they should be attached to the next checkpoint)
    const tuple0 = await saver.getTuple(config);
    expect(tuple0?.checkpoint.channel_values).toEqual({});
    expect(tuple0?.checkpoint.channel_versions).toEqual({});

    // create second checkpoint
    const checkpoint1: Checkpoint = {
      v: 1,
      id: uuid6(1),
      ts: "2024-04-20T17:19:07.952Z",
      channel_values: {},
      channel_versions: checkpoint0.channel_versions,
      versions_seen: checkpoint0.versions_seen,
    };
    config = await saver.put(config, checkpoint1, {
      source: "loop",
      parents: {},
      step: 1,
    });

    // check that pending sends are attached to checkpoint1
    const checkpoint1Tuple = await saver.getTuple(config);
    expect(checkpoint1Tuple?.checkpoint.channel_values).toEqual({
      [TASKS]: ["send-1", "send-2", "send-3"],
    });
    expect(checkpoint1Tuple?.checkpoint.channel_versions[TASKS]).toBeDefined();

    // check that the list also applies the migration
    const checkpointTupleGenerator = saver.list({
      configurable: { thread_id: "thread-1" },
    });

    const checkpointTuples: CheckpointTuple[] = [];
    for await (const checkpoint of checkpointTupleGenerator) {
      checkpointTuples.push(checkpoint);
    }
    expect(checkpointTuples.length).toBe(2);
    expect(checkpointTuples[0].checkpoint.channel_values).toEqual({
      [TASKS]: ["send-1", "send-2", "send-3"],
    });
    expect(
      checkpointTuples[0].checkpoint.channel_versions[TASKS]
    ).toBeDefined();
  });
});
