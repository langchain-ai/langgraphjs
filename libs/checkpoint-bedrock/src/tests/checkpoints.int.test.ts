/* eslint-disable no-process-env */
import { describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import {
  Checkpoint,
  CheckpointTuple,
  uuid6,
} from "@langchain/langgraph-checkpoint";

import { BedrockSessionSaver } from "../index.js"; // Adjust the import path as needed

const checkpoint1: Checkpoint = {
  v: 1,
  id: uuid6(-1),
  ts: "2024-04-19T17:19:07.952Z",
  channel_values: {
    someKey1: "someValue1",
  },
  channel_versions: {
    someKey1: 1,
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
    someKey1: 1,
    someKey2: 2,
  },
  versions_seen: {
    someKey3: {
      someKey4: 2,
    },
  },
  pending_sends: [],
};

let bedrockSavers: BedrockSessionSaver[] = [];

describe("Bedrock with $description", () => {
  let bedrockSaver: BedrockSessionSaver;
  let sessionId: string;

  beforeEach(async () => {
    bedrockSaver = new BedrockSessionSaver("us-west-2");
    bedrockSavers.push(bedrockSaver);

    sessionId = await bedrockSaver.createSession();
  });

  afterAll(async () => {
    // clear the ended savers to clean up for the next test
    bedrockSavers = [];
  });

  it("should save and retrieve checkpoints correctly", async () => {
    // get undefined checkpoint
    const undefinedCheckpoint = await bedrockSaver.getTuple({
      configurable: { thread_id: sessionId },
    });
    expect(undefinedCheckpoint).toBeUndefined();

    // save first checkpoint
    const runnableConfig = await bedrockSaver.put(
      { configurable: { thread_id: sessionId } },
      checkpoint1,
      { source: "update", step: -1, writes: null, parents: {} },
      checkpoint1.channel_versions
    );
    expect(runnableConfig).toEqual({
      configurable: {
        thread_id: sessionId,
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });

    // add some writes
    await bedrockSaver.putWrites(
      {
        configurable: {
          checkpoint_id: checkpoint1.id,
          checkpoint_ns: "",
          thread_id: sessionId,
        },
      },
      [["bar", "baz"]],
      "foo"
    );

    // get first checkpoint tuple
    const firstCheckpointTuple = await bedrockSaver.getTuple({
      configurable: { thread_id: sessionId },
    });
    expect(firstCheckpointTuple?.config).toEqual({
      configurable: {
        thread_id: sessionId,
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });
    expect(firstCheckpointTuple?.checkpoint).toEqual(checkpoint1);
    expect(firstCheckpointTuple?.metadata).toEqual({
      source: "update",
      step: -1,
      writes: null,
      parents: {},
    });
    expect(firstCheckpointTuple?.parentConfig).toBeUndefined();
    expect(firstCheckpointTuple?.pendingWrites).toEqual([
      ["foo", "bar", "baz"],
    ]);

    // save second checkpoint
    await bedrockSaver.put(
      {
        configurable: {
          thread_id: sessionId,
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      },
      checkpoint2,
      { source: "update", step: -1, writes: null, parents: {} },
      checkpoint2.channel_versions
    );

    // verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await bedrockSaver.getTuple({
      configurable: { thread_id: sessionId },
    });
    expect(secondCheckpointTuple?.metadata).toEqual({
      source: "update",
      step: -1,
      writes: null,
      parents: {},
    });
    expect(secondCheckpointTuple?.parentConfig).toEqual({
      configurable: {
        thread_id: sessionId,
        checkpoint_ns: "",
        checkpoint_id: "2024-04-18T17:19:07.952Z",
      },
    });

    // list checkpoints
    const checkpointTupleGenerator = bedrockSaver.list({
      configurable: { thread_id: sessionId },
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
