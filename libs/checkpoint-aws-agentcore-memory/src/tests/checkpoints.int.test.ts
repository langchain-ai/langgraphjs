/* eslint-disable no-process-env */
import { config } from "dotenv";
import { describe, it, expect, beforeEach } from "vitest";
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import { emptyCheckpoint, uuid6 } from "@langchain/langgraph-checkpoint";
import { AgentCoreMemorySaver } from "../saver.js";

// Load environment variables from .env file
config();

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
};

const { AWS_REGION, AGENTCORE_MEMORY_ID } = process.env;
if (!AWS_REGION || !AGENTCORE_MEMORY_ID) {
  throw new Error(
    "AWS_REGION and AGENTCORE_MEMORY_ID environment variables are required"
  );
}

describe("AgentCoreMemorySaver", () => {
  let agentCoreSaver: AgentCoreMemorySaver;

  beforeEach(() => {
    agentCoreSaver = new AgentCoreMemorySaver({
      memoryId: AGENTCORE_MEMORY_ID,
      region: AWS_REGION,
    });
  });

  it("should save and retrieve checkpoints correctly", async () => {
    // Use unique thread ID to avoid conflicts with previous test runs
    const uniqueThreadId = `test-thread-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 11)}`;
    const config = {
      configurable: { thread_id: uniqueThreadId, actor_id: "test-actor" },
    };

    // get undefined checkpoint
    const undefinedCheckpoint = await agentCoreSaver.getTuple(config);
    expect(undefinedCheckpoint).toBeUndefined();

    // save first checkpoint
    const runnableConfig = await agentCoreSaver.put(
      config,
      checkpoint1,
      { source: "update", step: -1, parents: {} },
      checkpoint1.channel_versions
    );
    expect(runnableConfig).toEqual({
      configurable: {
        thread_id: uniqueThreadId,
        actor_id: "test-actor",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });

    // add some writes
    await agentCoreSaver.putWrites(
      {
        configurable: {
          checkpoint_id: checkpoint1.id,
          checkpoint_ns: "",
          thread_id: uniqueThreadId,
          actor_id: "test-actor",
        },
      },
      [["bar", "baz"]],
      "foo"
    );

    // get first checkpoint tuple
    const firstCheckpointTuple = await agentCoreSaver.getTuple(config);
    expect(firstCheckpointTuple?.config).toEqual({
      configurable: {
        thread_id: uniqueThreadId,
        actor_id: "test-actor",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });
    expect(firstCheckpointTuple?.checkpoint).toEqual(checkpoint1);
    expect(firstCheckpointTuple?.metadata).toEqual({
      source: "update",
      step: -1,
      parents: {},
    });
    expect(firstCheckpointTuple?.parentConfig).toBeUndefined();
    expect(firstCheckpointTuple?.pendingWrites).toEqual([
      ["foo", "bar", "baz"],
    ]);

    // save second checkpoint
    await agentCoreSaver.put(
      {
        configurable: {
          thread_id: uniqueThreadId,
          actor_id: "test-actor",
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      },
      checkpoint2,
      { source: "update", step: -1, parents: {} },
      checkpoint2.channel_versions
    );

    // verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await agentCoreSaver.getTuple(config);
    expect(secondCheckpointTuple?.metadata).toEqual({
      source: "update",
      step: -1,
      parents: {},
    });
    expect(secondCheckpointTuple?.parentConfig).toEqual({
      configurable: {
        thread_id: uniqueThreadId,
        actor_id: "test-actor",
        checkpoint_ns: "",
        checkpoint_id: "2024-04-18T17:19:07.952Z",
      },
    });

    // list checkpoints
    const checkpointTupleGenerator = agentCoreSaver.list(config);
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
    const uniqueThreadId1 = `test-thread-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 11)}`;
    const uniqueThreadId2 = `test-thread-${Date.now() + 1}-${Math.random()
      .toString(36)
      .substring(2, 11)}`;
    const thread1 = {
      configurable: {
        thread_id: uniqueThreadId1,
        actor_id: "test-actor",
        checkpoint_ns: "",
      },
    };
    const thread2 = {
      configurable: {
        thread_id: uniqueThreadId2,
        actor_id: "test-actor",
        checkpoint_ns: "",
      },
    };

    const meta: CheckpointMetadata = {
      source: "update",
      step: -1,
      parents: {},
    };

    await agentCoreSaver.put(thread1, emptyCheckpoint(), meta, {});
    await agentCoreSaver.put(thread2, emptyCheckpoint(), meta, {});

    expect(await agentCoreSaver.getTuple(thread1)).toBeDefined();

    await agentCoreSaver.deleteThread(uniqueThreadId1, "test-actor");

    expect(await agentCoreSaver.getTuple(thread1)).toBeUndefined();
    expect(await agentCoreSaver.getTuple(thread2)).toBeDefined();
  });
});
