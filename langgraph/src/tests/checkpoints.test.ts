import { describe, it, expect } from "@jest/globals";
import { Checkpoint, CheckpointTuple, deepCopy } from "../checkpoint/base.js";
import { MemorySaver } from "../checkpoint/memory.js";
import { SqliteSaver } from "../checkpoint/sqlite.js";

const checkpoint1: Checkpoint = {
  v: 1,
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

describe("Base", () => {
  it("should deep copy a simple object", () => {
    const obj = { a: 1, b: { c: 2 } };
    const copiedObj = deepCopy(obj);

    // Check if the copied object is equal to the original object
    expect(copiedObj).toEqual(obj);

    // Check if the copied object is not the same object reference as the original object
    expect(copiedObj).not.toBe(obj);

    // Check if the nested object is also deep copied
    expect(copiedObj.b).toEqual(obj.b);
    expect(copiedObj.b).not.toBe(obj.b);
  });

  it("should deep copy an array", () => {
    const arr = [1, 2, 3];
    const copiedArr = deepCopy(arr);

    // Check if the copied array is equal to the original array
    expect(copiedArr).toEqual(arr);
  });

  it("should deep copy an array of objects", () => {
    const arr = [{ a: 1 }, { b: 2 }];
    const copiedArr = deepCopy(arr);

    // Check if the copied array is equal to the original array
    expect(copiedArr).toEqual(arr);

    // Check if the copied array is not the same array reference as the original array
    expect(copiedArr).not.toBe(arr);

    // Check if the nested objects in the array are also deep copied
    expect(copiedArr[0]).toEqual(arr[0]);
    expect(copiedArr[0]).not.toBe(arr[0]);
  });
});

describe("MemorySaver", () => {
  it("should save and retrieve checkpoints correctly", async () => {
    const memorySaver = new MemorySaver();

    // save checkpoint
    const runnableConfig = await memorySaver.put(
      { configurable: { thread_id: "1" } },
      checkpoint1,
      { source: "update", step: -1 }
    );
    expect(runnableConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_id: "2024-04-19T17:19:07.952Z",
      },
    });

    // get checkpoint tuple
    const checkpointTuple = await memorySaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(checkpointTuple?.config).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_id: "2024-04-19T17:19:07.952Z",
      },
    });
    expect(checkpointTuple?.checkpoint).toEqual(checkpoint1);

    // save another checkpoint
    await memorySaver.put({ configurable: { thread_id: "1" } }, checkpoint2, {
      source: "update",
      step: -1,
    });

    // list checkpoints
    const checkpointTupleGenerator = await memorySaver.list({
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
      { source: "update", step: -1 }
    );
    expect(runnableConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_id: "2024-04-19T17:19:07.952Z",
      },
    });

    // get first checkpoint tuple
    const firstCheckpointTuple = await sqliteSaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(firstCheckpointTuple?.config).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_id: "2024-04-19T17:19:07.952Z",
      },
    });
    expect(firstCheckpointTuple?.checkpoint).toEqual(checkpoint1);
    expect(firstCheckpointTuple?.parentConfig).toBeUndefined();

    // save second checkpoint
    await sqliteSaver.put(
      {
        configurable: {
          thread_id: "1",
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      },
      checkpoint2,
      { source: "update", step: -1 }
    );

    // verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await sqliteSaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(secondCheckpointTuple?.parentConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_id: "2024-04-18T17:19:07.952Z",
      },
    });

    // list checkpoints
    const checkpointTupleGenerator = await sqliteSaver.list({
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
