import { describe, it, expect } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  type Checkpoint,
  type CheckpointTuple,
  compareChannelVersions,
  deepCopy,
  emptyCheckpoint,
  maxChannelVersion,
} from "../base.js";
import { MemorySaver } from "../memory.js";
import { uuid6 } from "../id.js";
import { TASKS } from "../index.js";
import type { CheckpointMetadata } from "../types.js";

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
      { source: "update", step: -1, parents: {} }
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
        parents: {},
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

  it("should migrate pending sends", async () => {
    const memorySaver = new MemorySaver();
    let config: RunnableConfig = {
      configurable: { thread_id: "thread-1", checkpoint_ns: "" },
    };

    const checkpoint0: Checkpoint = {
      v: 1,
      id: uuid6(0),
      ts: "2024-04-19T17:19:07.952Z",
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };

    config = await memorySaver.put(config, checkpoint0, {
      source: "loop",
      parents: {},
      step: 0,
    });

    await memorySaver.putWrites(
      config,
      [
        [TASKS, "send-1"],
        [TASKS, "send-2"],
      ],
      "task-1"
    );
    await memorySaver.putWrites(config, [[TASKS, "send-3"]], "task-2");

    // check that fetching checkpount 0 doesn't attach pending sends
    // (they should be attached to the next checkpoint)
    const tuple0 = await memorySaver.getTuple(config);
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
    config = await memorySaver.put(config, checkpoint1, {
      source: "loop",
      parents: {},
      step: 1,
    });

    // check that pending sends are attached to checkpoint1
    const checkpoint1Tuple = await memorySaver.getTuple(config);
    expect.soft(checkpoint1Tuple?.checkpoint.channel_values).toEqual({
      [TASKS]: ["send-1", "send-2", "send-3"],
    });
    expect(checkpoint1Tuple?.checkpoint.channel_versions[TASKS]).toBeDefined();

    // check that the list also applies the migration
    const checkpointTupleGenerator = memorySaver.list({
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

  it("should delete thread", async () => {
    const memorySaver = new MemorySaver();
    const thread1 = { configurable: { thread_id: "1", checkpoint_ns: "" } };
    const thread2 = { configurable: { thread_id: "2", checkpoint_ns: "" } };

    const meta: CheckpointMetadata = {
      source: "update",
      step: -1,
      parents: {},
    };

    await memorySaver.put(thread1, emptyCheckpoint(), meta);
    await memorySaver.put(thread2, emptyCheckpoint(), meta);

    expect(await memorySaver.getTuple(thread1)).toBeDefined();

    await memorySaver.deleteThread("1");

    expect(await memorySaver.getTuple(thread1)).toBeUndefined();
    expect(await memorySaver.getTuple(thread2)).toBeDefined();
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
