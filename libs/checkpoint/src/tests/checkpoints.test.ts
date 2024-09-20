import { describe, it, expect } from "@jest/globals";
import {
  Checkpoint,
  CheckpointTuple,
  compareChannelVersions,
  deepCopy,
  maxChannelVersion,
} from "../base.js";
import { MemorySaver } from "../memory.js";
import { uuid6 } from "../id.js";

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
      { configurable: { thread_id: "1", checkpoint_ns: "" } },
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

    // get checkpoint tuple
    const checkpointTuple = await memorySaver.getTuple({
      configurable: { thread_id: "1", checkpoint_ns: "" },
    });
    expect(checkpointTuple?.config).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });
    expect(checkpointTuple?.checkpoint).toEqual(checkpoint1);

    // save another checkpoint
    await memorySaver.put(
      { configurable: { thread_id: "1", checkpoint_ns: "" } },
      checkpoint2,
      {
        source: "update",
        step: -1,
        writes: null,
        parents: {}
      }
    );

    // list checkpoints
    const checkpointTupleGenerator = await memorySaver.list({
      configurable: { thread_id: "1", checkpoint_ns: "" },
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

describe("id", () => {
  it("should accept clockseq -1", () => {
    const regex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-6[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    const uuid = uuid6(-1);
    expect(uuid).toMatch(regex);
    expect(uuid.includes("u")).toBe(false);
  });
});

describe("channel versions", () => {
  it("comparison", () => {
    expect(compareChannelVersions(1, 2)).toBe(-1);
    expect(compareChannelVersions(1, 1)).toBe(0);
    expect(compareChannelVersions(2, 1)).toBe(1);

    expect(compareChannelVersions("1.abc", "2")).toBe(-1);
    expect(compareChannelVersions("10.a", "10.b")).toBe(-1);

    expect(maxChannelVersion("01.a", "02.a", "10.a")).toBe("10.a");
  });
});
