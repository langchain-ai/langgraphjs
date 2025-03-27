import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import { RunnableConfig } from "@langchain/core/runnables";
import { Checkpoint } from "@langchain/langgraph-checkpoint";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { RedisSaver, TRedisClient, TCheckpointRedisOptions } from "../index.js";


describe("RedisSaver", () => {
  let service: RedisSaver;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let redisClient: any;

  // Create redis client mock
  const createRedisMock = () => {
    const multiMock = {
      set: jest.fn().mockReturnThis(),
      hSet: jest.fn().mockReturnThis(),
      lPush: jest.fn().mockReturnThis(),
      rPush: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      exec: jest.fn<any>().mockResolvedValue([]),
    };

    return {
      isOpen: true,
      connect: jest.fn<any>().mockResolvedValue(undefined),
      get: jest.fn(),
      set: jest.fn<any>().mockResolvedValue("OK"),
      lIndex: jest.fn(),
      lRange: jest.fn(),
      hGetAll: jest.fn(),
      lPush: jest.fn<any>().mockResolvedValue(1),
      rPush: jest.fn<any>().mockResolvedValue(1),
      hSet: jest.fn<any>().mockResolvedValue(1),
      expire: jest.fn<any>().mockResolvedValue(1),
      multi: jest.fn(() => multiMock),
      del: jest.fn<any>().mockResolvedValue(1),
      disconnect: jest.fn<any>().mockResolvedValue(undefined),
      quit: jest.fn<any>().mockResolvedValue(undefined),
      _multiMock: multiMock, // Store a reference to access in tests
    };
  };

  // Helper function to create the service with specific isCluster setting
  const createService = (isCluster: boolean) => {
    // Create fresh mock for each test
    redisClient = createRedisMock();

    // Create options
    const options: TCheckpointRedisOptions = {
      isCluster,
      prefix: "test-prefix",
      ttl: 86400000,
    };

    // Create service directly with constructor
    return new RedisSaver(redisClient as TRedisClient, options);
  };

  beforeEach(() => {
    // Default to non-cluster mode
    service = createService(false);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("isCluster", () => {
    it("should properly set cluster mode based on options", () => {
      // Test cluster mode
      const clusterService = createService(true);
      /* eslint-disable @typescript-eslint/no-explicit-any */
      expect((clusterService as any).options.isCluster).toBe(true);

      // Test non-cluster mode
      const nonClusterService = createService(false);
      expect((nonClusterService as any).options.isCluster).toBe(false);
    });
  });

  describe("getKeys", () => {
    it("should generate keys with hash tags", () => {
      // Use a private method accessor to test getKeys
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const getKeys = (service as any).getKeys.bind(service);
      const keys = getKeys("test-thread-id", "test-ns");

      // Check that all keys contain the hash tag pattern {prefix:thread:id:ns}
      const hashTagPattern = "{test-prefix:thread:test-thread-id:ns:test-ns}";
      expect(keys.checkpoints).toContain(hashTagPattern);
      expect(keys.checkpoint("test-checkpoint")).toContain(hashTagPattern);
      expect(keys.channelValues("test-checkpoint")).toContain(hashTagPattern);
      expect(keys.metadata("test-checkpoint")).toContain(hashTagPattern);
      expect(keys.pendingSends("test-checkpoint")).toContain(hashTagPattern);
      expect(keys.writes("test-checkpoint", "test-task")).toContain(
        hashTagPattern
      );
    });
  });

  describe("executeCommands", () => {
    it("should execute commands sequentially", async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const executeCommands = (service as any).executeCommands.bind(service);

      const commands = [
        jest.fn<any>().mockResolvedValue("first"),
        jest.fn<any>().mockResolvedValue("second"),
        jest.fn<any>().mockResolvedValue("third"),
      ];

      await executeCommands(commands);

      commands.forEach((cmd) => {
        expect(cmd).toHaveBeenCalled();
      });
    });
  });

  describe("getTuple", () => {
    const config: RunnableConfig = {
      configurable: {
        thread_id: "test-thread-id",
        checkpoint_ns: "test-ns",
      },
    };

    const checkpointId = "test-checkpoint-id";
    const checkpointData = {
      id: checkpointId,
      channel_values: {},
      pending_sends: [],
    };
    const validSerializedValue = JSON.stringify({
      type: "json",
      value: Buffer.from(JSON.stringify("deserialized-value")).toString(
        "base64"
      ),
    });

    beforeEach(() => {
      // Setup mocks for getTuple
      redisClient.lIndex.mockResolvedValue(checkpointId);
      redisClient.get
        .mockResolvedValueOnce(JSON.stringify(checkpointData)) // checkpoint data
        .mockResolvedValueOnce(JSON.stringify({ testMeta: "value" })); // metadata
      redisClient.hGetAll.mockResolvedValue({
        testChannel: validSerializedValue,
      });
      redisClient.lRange.mockResolvedValue([validSerializedValue]);
    });

    it("should return undefined when thread_id is not provided", async () => {
      const result = await service.getTuple({});
      expect(result).toBeUndefined();
    });

    it("should return the latest checkpoint when no checkpoint_id is provided", async () => {
      const result = await service.getTuple(config);

      expect(redisClient.lIndex).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.checkpoint).toBeDefined();
      expect(result.config.configurable?.checkpoint_id).toBe(checkpointId);
    });
  });

  describe("list", () => {
    const config: RunnableConfig = {
      configurable: {
        thread_id: "test-thread-id",
        checkpoint_ns: "test-ns",
      },
    };

    const checkpointIds = ["checkpoint1", "checkpoint2", "checkpoint3"];

    beforeEach(() => {
      // Setup mock for list
      redisClient.lRange.mockResolvedValue(checkpointIds);
      redisClient.get
        .mockResolvedValueOnce(JSON.stringify({ id: "checkpoint1" })) // checkpoint data
        .mockResolvedValueOnce(JSON.stringify({ tag: "test" })); // metadata for checkpoint1

      // Mock getTuple to return sample tuples
      jest
        .spyOn(service, "getTuple")
        .mockImplementation(async (cfg: RunnableConfig) => {
          const checkpointId = cfg.configurable?.checkpoint_id;
          return {
            config: {
              ...cfg,
              configurable: {
                ...cfg.configurable,
                checkpoint_id: checkpointId,
              },
            },
            checkpoint: { id: checkpointId },
            metadata: { tag: "test" },
          };
        });
    });

    it("should return early when thread_id is not provided", async () => {
      const iterator = service.list({});
      const result = await iterator.next();
      expect(result.done).toBe(true);
      expect(result.value).toBeUndefined();
    });

    it("should yield checkpoints when no filter is provided", async () => {
      const iterator = service.list(config, { limit: 1 });

      // First checkpoint
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value.checkpoint.id).toBe("checkpoint1");
    });
  });

  describe("put", () => {
    describe("put in non-cluster mode", () => {
      const config: RunnableConfig = {
        configurable: {
          thread_id: "test-thread-id",
          checkpoint_ns: "test-ns",
        },
      };

      const checkpointId = "test-checkpoint-id";
      const checkpoint = {
        id: checkpointId,
        channel_values: {
          testChannel: "test-value",
        },
        pending_sends: ["test-send"],
        v: 1,
        ts: "timestamp",
        channel_versions: {},
        versions_seen: {},
      } as unknown as Checkpoint;

      const metadata = { testMeta: "value" };

      it("should throw error when thread_id is not provided", async () => {
        await expect(service.put({}, checkpoint, metadata)).rejects.toThrow(
          "Thread ID is required"
        );
      });

      it("should use multi/transaction in non-cluster mode", async () => {
        const result = await service.put(config, checkpoint, metadata);

        // Verify multi was called to start a transaction
        expect(redisClient.multi).toHaveBeenCalled();

        // Verify transaction is executed
        expect(redisClient._multiMock.exec).toHaveBeenCalled();

        // Verify returns updated config with safe access
        if (result.configurable) {
          expect(result.configurable.thread_id).toBe("test-thread-id");
          expect(result.configurable.checkpoint_ns).toBe("test-ns");
          expect(result.configurable.checkpoint_id).toBe(checkpointId);
        }
      });
    });

    describe("put in cluster mode", () => {
      const config: RunnableConfig = {
        configurable: {
          thread_id: "test-thread-id",
          checkpoint_ns: "test-ns",
        },
      };

      const checkpointId = "test-checkpoint-id";
      const checkpoint = {
        id: checkpointId,
        channel_values: {
          testChannel: "test-value",
        },
        pending_sends: ["test-send"],
        v: 1,
        ts: "timestamp",
        channel_versions: {},
        versions_seen: {},
      } as unknown as Checkpoint;

      const metadata = { testMeta: "value" };

      let clusterService: RedisSaver;

      beforeEach(() => {
        clusterService = createService(true);
      });

      it("should use individual commands in cluster mode", async () => {
        // Create spy on the executeCommands method
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const executeCommandsSpy = jest.spyOn(
          clusterService as any,
          "executeCommands"
        );

        const result = await clusterService.put(config, checkpoint, metadata);

        // In cluster mode, should NOT use multi
        expect(redisClient.multi).not.toHaveBeenCalled();

        // Should use executeCommands instead
        expect(executeCommandsSpy).toHaveBeenCalled();

        // Individual set commands should be called directly
        expect(redisClient.set).toHaveBeenCalled();
        expect(redisClient.hSet).toHaveBeenCalled();
        expect(redisClient.lPush).toHaveBeenCalled();
        expect(redisClient.rPush).toHaveBeenCalled();
        expect(redisClient.expire).toHaveBeenCalled();

        // Verify returns updated config with safe access
        if (result.configurable) {
          expect(result.configurable.thread_id).toBe("test-thread-id");
          expect(result.configurable.checkpoint_ns).toBe("test-ns");
          expect(result.configurable.checkpoint_id).toBe(checkpointId);
        }
      });
    });
  });

  describe("putWrites", () => {
    describe("putWrites in non-cluster mode", () => {
      const config: RunnableConfig = {
        configurable: {
          thread_id: "test-thread-id",
          checkpoint_ns: "test-ns",
          checkpoint_id: "test-checkpoint-id",
        },
      };

      const taskId = "test-task-id";
      const writes = [
        {
          runId: "run-1",
          parentRunId: "parent-1",
          value: "test-value",
          error: null,
        },
        {
          runId: "run-2",
          parentRunId: "parent-1",
          value: "test-value-error",
          error: "test-error",
        },
      ];

      it("should throw error when thread_id or checkpoint_id is not provided", async () => {
        await expect(
          service.putWrites(
            { configurable: { thread_id: "test" } },
            writes,
            taskId
          )
        ).rejects.toThrow("Thread ID and checkpoint ID are required");

        await expect(
          service.putWrites(
            { configurable: { checkpoint_id: "test" } },
            writes,
            taskId
          )
        ).rejects.toThrow("Thread ID and checkpoint ID are required");
      });

      it("should do nothing when writes array is empty", async () => {
        await service.putWrites(config, [], taskId);

        expect(redisClient.multi).not.toHaveBeenCalled();
      });

      it("should use multi in non-cluster mode", async () => {
        await service.putWrites(config, writes, taskId);

        // Verify multi was called to start a transaction
        expect(redisClient.multi).toHaveBeenCalled();

        // Verify transaction is executed
        expect(redisClient._multiMock.exec).toHaveBeenCalled();
      });
    });

    describe("putWrites in cluster mode", () => {
      const config: RunnableConfig = {
        configurable: {
          thread_id: "test-thread-id",
          checkpoint_ns: "test-ns",
          checkpoint_id: "test-checkpoint-id",
        },
      };

      const taskId = "test-task-id";
      const writes = [
        {
          runId: "run-1",
          parentRunId: "parent-1",
          value: "test-value",
          error: null,
        },
        {
          runId: "run-2",
          parentRunId: "parent-1",
          value: "test-value-error",
          error: "test-error",
        },
      ];

      let clusterService: RedisSaver;

      beforeEach(() => {
        clusterService = createService(true);
      });

      it("should use individual commands in cluster mode", async () => {
        // Create spy on the executeCommands method
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const executeCommandsSpy = jest.spyOn(
          clusterService as any,
          "executeCommands"
        );

        await clusterService.putWrites(config, writes, taskId);

        // In cluster mode, should NOT use multi
        expect(redisClient.multi).not.toHaveBeenCalled();

        // Should use executeCommands instead
        expect(executeCommandsSpy).toHaveBeenCalled();

        // Individual commands should be called directly
        expect(redisClient.hSet).toHaveBeenCalled();
        expect(redisClient.expire).toHaveBeenCalled();
      });
    });
  });

  describe("clear", () => {
    describe("clear in non-cluster mode", () => {
      const threadId = "test-thread-id";
      const checkpointIds = ["checkpoint1", "checkpoint2", "checkpoint3"];

      beforeEach(() => {
        redisClient.lRange.mockResolvedValue(checkpointIds);
      });

      it("should use multi in non-cluster mode", async () => {
        await service.clear(threadId);

        // Verify checkpoints are retrieved
        expect(redisClient.lRange).toHaveBeenCalled();

        // Verify multi was called to start a transaction
        expect(redisClient.multi).toHaveBeenCalled();

        // Verify transaction is executed
        expect(redisClient._multiMock.exec).toHaveBeenCalled();
      });

      it("should do nothing when no checkpoints are found", async () => {
        redisClient.lRange.mockResolvedValue([]);
        await service.clear(threadId);

        // Verify checkpoints are retrieved
        expect(redisClient.lRange).toHaveBeenCalled();

        // Verify multi was not called
        expect(redisClient.multi).not.toHaveBeenCalled();
      });
    });

    describe("clear in cluster mode", () => {
      const threadId = "test-thread-id";
      const checkpointIds = ["checkpoint1", "checkpoint2", "checkpoint3"];

      let clusterService: RedisSaver;

      beforeEach(() => {
        clusterService = createService(true);
        redisClient.lRange.mockResolvedValue(checkpointIds);
      });

      it("should use individual commands in cluster mode", async () => {
        // Create spy on the executeCommands method
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const executeCommandsSpy = jest.spyOn(
          clusterService as any,
          "executeCommands"
        );

        await clusterService.clear(threadId);

        // Verify checkpoints are retrieved
        expect(redisClient.lRange).toHaveBeenCalled();

        // In cluster mode, should NOT use multi
        expect(redisClient.multi).not.toHaveBeenCalled();

        // Should use executeCommands instead
        expect(executeCommandsSpy).toHaveBeenCalled();

        // Individual commands should be called directly
        expect(redisClient.del).toHaveBeenCalled();
      });
    });
  });

  describe("ensureConnection", () => {
    beforeEach(() => {
      // Reset the mocks
      redisClient.disconnect = jest.fn<any>().mockResolvedValue(undefined);
      redisClient.quit = jest.fn<any>().mockResolvedValue(undefined);
    });

    it("should do nothing if the client is not open", async () => {
      // Set isOpen to false
      redisClient.isOpen = false;

      // Call the private method
      /* eslint-disable @typescript-eslint/no-explicit-any */
      await (service as any).ensureConnection();

      // Verify connect was called
      expect(redisClient.connect).toHaveBeenCalled();
    });

    it("should not call connect if client is already open", async () => {
      // Service is already open
      redisClient.isOpen = true;

      // Call the private method
      /* eslint-disable @typescript-eslint/no-explicit-any */
      await (service as any).ensureConnection();

      // Verify connect was not called
      expect(redisClient.connect).not.toHaveBeenCalled();
    });
  });

  describe("read", () => {
    const threadId = "test-thread-id";
    const checkpointId = "test-checkpoint-id";
    const humanMessage = new HumanMessage("test human message");
    const aiMessage = new AIMessage("test ai message");

    beforeEach(() => {
      // Setup mocks for read
      redisClient.lRange.mockResolvedValue([checkpointId]);

      // Mock getTuple to return a predefined response with actual LangChain message objects
      jest.spyOn(service, "getTuple").mockResolvedValue({
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_id: checkpointId,
          },
        },
        checkpoint: {
          channel_values: {
            messages: [humanMessage, aiMessage],
          },
        },
        metadata: {},
      });

      // Add multi capabilities to _multiMock
      redisClient._multiMock.lRange = jest.fn().mockReturnThis();
      redisClient._multiMock.exec = jest.fn<any>().mockResolvedValue([[]]);
    });

    it("should return an empty array when no checkpoints are found", async () => {
      redisClient.lRange.mockResolvedValue([]);
      const result = await service.read(threadId);
      expect(result).toEqual([]);
    });

    it("should return messages converted to TThreadMessage format", async () => {
      const result = await service.read(threadId);
      expect(result).toEqual([
        {
          role: "user",
          content: "test human message",
        },
        {
          role: "assistant",
          content: "test ai message",
        },
      ]);
    });

    it("should handle null channel values gracefully", async () => {
      jest.spyOn(service, "getTuple").mockResolvedValueOnce({
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_id: checkpointId,
          },
        },
        checkpoint: {
          channel_values: {
            messages: null,
          },
        },
        metadata: {},
      });
      const result = await service.read(threadId);
      expect(result).toEqual([]);
    });

    it("should handle empty tuple gracefully", async () => {
      jest.spyOn(service, "getTuple").mockResolvedValueOnce(undefined);
      const result = await service.read(threadId);
      expect(result).toEqual([]);
    });
  });
});
