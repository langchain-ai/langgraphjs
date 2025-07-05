import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";

import {
  Checkpoint,
  uuid6,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import { FileCheckpointSaver } from "../index.js";

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

describe("FileCheckpointSaver", () => {
  it("should save and retrieve checkpoints correctly", async () => {
    // create test directory
    const testDir = mkdtempSync(join("./src/tests", "./tmp-checkpoints-"));

    const fileCheckpointSaver = new FileCheckpointSaver({
      basePath: testDir,
      fileExtension: ".json",
    });

    // save checkpoint
    const runnableConfig = await fileCheckpointSaver.put(
      { configurable: { thread_id: "1234", checkpoint_ns: "" } },
      checkpoint1,
      { source: "update", step: -1, writes: null, parents: {} }
    );
    expect(runnableConfig).toEqual({
      configurable: {
        thread_id: "1234",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });

    // get checkpoint tuple
    const checkpointTuple = await fileCheckpointSaver.getTuple({
      configurable: { thread_id: "1234", checkpoint_ns: "" },
    });

    console.log("checkpointTuple", checkpointTuple);
    expect(checkpointTuple?.config).toEqual({
      configurable: {
        thread_id: "1234",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });
    expect(checkpointTuple?.checkpoint).toEqual(checkpoint1);

    // save another checkpoint
    await fileCheckpointSaver.put(
      { configurable: { thread_id: "1234", checkpoint_ns: "" } },
      checkpoint2,
      {
        source: "update",
        step: -1,
        writes: null,
        parents: {},
      }
    );

    // list checkpoints
    const checkpointTupleGenerator = await fileCheckpointSaver.list({
      configurable: { thread_id: "1234", checkpoint_ns: "" },
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
