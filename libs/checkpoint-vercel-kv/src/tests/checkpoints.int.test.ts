import { describe, test, expect } from "@jest/globals";
import {
  Checkpoint,
  CheckpointTuple,
  uuid6,
} from "@langchain/langgraph-checkpoint";

import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { VercelKVSaver } from "../index.js";

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
  pending_sends: [],
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
  pending_sends: [],
};

describe("VercelKVSaver", () => {
  const vercelSaver = new VercelKVSaver({
    url: getEnvironmentVariable("KV_REST_API_URL")!,
    token: getEnvironmentVariable("KV_REST_API_TOKEN")!,
  });

  test("should save and retrieve checkpoints correctly", async () => {
    await vercelSaver.flush();

    // get undefined checkpoint
    const undefinedCheckpoint = await vercelSaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(undefinedCheckpoint).toBeUndefined();

    // save first checkpoint
    const runnableConfig = await vercelSaver.put(
      { configurable: { thread_id: "1" } },
      checkpoint1,
      { source: "update", step: -1, writes: null, parents: {} }
    );
    expect(runnableConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });

    // add writes
    await vercelSaver.putWrites(
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
    const firstCheckpointTuple = await vercelSaver.getTuple({
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
    await vercelSaver.put(
      {
        configurable: {
          thread_id: "1",
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      },
      checkpoint2,
      { source: "update", step: -1, writes: null, parents: {} }
    );

    // verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await vercelSaver.getTuple({
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
    const checkpointTupleGenerator = vercelSaver.list({
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
});
