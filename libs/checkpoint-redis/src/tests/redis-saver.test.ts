import { Redis } from "ioredis";
import {
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  uuid6,
} from "@langchain/langgraph-checkpoint";

import { RedisSaver } from "../index.js";

describe("RedisSaver", () => {
  let saver: RedisSaver;

  const redis = new Redis({ port: 6381 });

  const mockCheckpoint1: Checkpoint = {
    v: 1,
    id: uuid6(-1),
    ts: "2024-04-19T17:19:07.952Z",
    channel_values: {
      testKey1: "testValue1",
    },
    channel_versions: {
      testKey2: 1,
    },
    versions_seen: {
      testKey3: {
        testKey4: 1,
      },
    },
    pending_sends: [],
  };

  const mockCheckpoint2: Checkpoint = {
    v: 1,
    id: uuid6(1),
    ts: "2024-04-20T17:19:07.952Z",
    channel_values: {
      testKey1: "testValue2",
    },
    channel_versions: {
      testKey2: 2,
    },
    versions_seen: {
      testKey3: {
        testKey4: 2,
      },
    },
    pending_sends: [],
  };

  const mockMetadata: CheckpointMetadata = {
    source: "update",
    step: -1,
    writes: null,
    parents: {},
  };

  beforeEach(async () => {
    saver = new RedisSaver({ connection: redis });
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  describe("getTuple", () => {
    it("should return undefined for non-existent checkpoint", async () => {
      const result = await saver.getTuple({
        configurable: { thread_id: "test-thread" },
      });

      expect(result).toBeUndefined();
    });

    it("should throw error when thread_id is missing", async () => {
      await expect(
        saver.getTuple({
          configurable: {},
        })
      ).rejects.toThrow("thread_id is required in config.configurable");
    });
  });

  describe("put and getTuple", () => {
    it("should successfully save and retrieve a checkpoint", async () => {
      const config = {
        configurable: {
          thread_id: "test-thread",
          checkpoint_ns: "test-ns",
        },
      };

      const savedConfig = await saver.put(
        config,
        mockCheckpoint1,
        mockMetadata
      );

      expect(savedConfig).toEqual({
        configurable: {
          thread_id: "test-thread",
          checkpoint_ns: "test-ns",
          checkpoint_id: mockCheckpoint1.id,
        },
      });

      const retrievedTuple = await saver.getTuple(savedConfig);

      expect(retrievedTuple).not.toBeUndefined();
      expect(retrievedTuple?.checkpoint).toEqual(mockCheckpoint1);
      expect(retrievedTuple?.config).toEqual(savedConfig);
    });
  });

  describe("putWrites and getTuple", () => {
    it("should save and retrieve checkpoint with writes", async () => {
      const config = {
        configurable: {
          thread_id: "test-thread",
          checkpoint_ns: "test-ns",
          checkpoint_id: mockCheckpoint1.id,
        },
      };

      await saver.put(config, mockCheckpoint1, mockMetadata);

      const writes: PendingWrite[] = [
        ["test-channel", "test-value"] as PendingWrite,
      ];

      await saver.putWrites(config, writes, "test-task");

      const tuple = await saver.getTuple(config);

      expect(tuple).not.toBeUndefined();
      expect(tuple?.pendingWrites).toHaveLength(1);
      expect(tuple?.pendingWrites?.[0]).toEqual([
        "test-task",
        "test-channel",
        "test-value",
      ]);
    });

    it("should throw error when required config fields are missing", async () => {
      const writes: PendingWrite[] = [
        ["test-channel", "test-value"] as PendingWrite,
      ];

      await expect(
        saver.putWrites(
          {
            configurable: {},
          },
          writes,
          "test-task"
        )
      ).rejects.toThrow();
    });
  });

  describe("list", () => {
    it("should list checkpoints in chronological order", async () => {
      const config = {
        configurable: {
          thread_id: "test-thread",
          checkpoint_ns: "test-ns",
        },
      };

      // Save checkpoints in reverse chronological order
      await saver.put(config, mockCheckpoint2, mockMetadata);
      await saver.put(config, mockCheckpoint1, mockMetadata);

      const checkpoints: CheckpointTuple[] = [];

      for await (const checkpoint of saver.list(config)) {
        checkpoints.push(checkpoint);
      }

      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0].checkpoint.ts).toEqual("2024-04-19T17:19:07.952Z");
      expect(checkpoints[1].checkpoint.ts).toEqual("2024-04-20T17:19:07.952Z");
    });

    it("should respect the limit option", async () => {
      const config = {
        configurable: {
          thread_id: "test-thread",
          checkpoint_ns: "test-ns",
        },
      };

      await saver.put(config, mockCheckpoint1, mockMetadata);
      await saver.put(config, mockCheckpoint2, mockMetadata);

      const checkpoints: CheckpointTuple[] = [];

      for await (const checkpoint of saver.list(config, { limit: 1 })) {
        checkpoints.push(checkpoint);
      }

      expect(checkpoints).toHaveLength(1);
    });

    it("should handle the before option correctly", async () => {
      const config = {
        configurable: {
          thread_id: "test-thread",
          checkpoint_ns: "test-ns",
        },
      };

      await saver.put(config, mockCheckpoint1, mockMetadata);
      const checkpoint2Config = await saver.put(
        config,
        mockCheckpoint2,
        mockMetadata
      );

      const checkpoints: CheckpointTuple[] = [];

      for await (const checkpoint of saver.list(config, {
        before: checkpoint2Config,
      })) {
        checkpoints.push(checkpoint);
      }

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].checkpoint.ts).toEqual("2024-04-19T17:19:07.952Z");
    });
  });
});
