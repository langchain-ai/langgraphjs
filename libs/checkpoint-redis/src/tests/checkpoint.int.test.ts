import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointMetadata,
  emptyCheckpoint,
  PendingWrite,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import { RedisSaver } from "../index.js";
import { ShallowRedisSaver } from "../shallow.js";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { createClient } from "redis";
import { RunnableConfig } from "@langchain/core/runnables";

// ============================================================================
// BASIC CHECKPOINT TESTS (from checkpoint.test.ts)
// ============================================================================
describe("RedisSaver Basic", () => {
  it("should create an instance with a Redis client", () => {
    const mockClient = {} as any;
    const saver = new RedisSaver(mockClient);
    expect(saver).toBeDefined();
  });

  it("should extend BaseCheckpointSaver", () => {
    const mockClient = {} as any;
    const saver = new RedisSaver(mockClient);
    expect(saver).toBeInstanceOf(BaseCheckpointSaver);
  });

  it("should return undefined for non-existent checkpoint", async () => {
    const mockClient = {
      json: {
        get: async () => null,
      },
      ft: {
        info: async () => {
          throw new Error("Index not found");
        },
        create: async () => {},
      },
    } as any;
    const saver = new RedisSaver(mockClient);
    const result = await saver.getTuple({
      configurable: {
        thread_id: "test-thread",
        checkpoint_id: "non-existent",
      },
    });
    expect(result).toBeUndefined();
  });

  it("should retrieve an existing checkpoint", async () => {
    const jsonDoc = {
      thread_id: "test-thread",
      checkpoint_ns: "",
      checkpoint_id: "test-checkpoint",
      parent_checkpoint_id: null,
      checkpoint: {
        v: 1,
        id: "test-checkpoint",
        ts: "2024-01-01T00:00:00Z",
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      },
      metadata: {},
    };

    const mockClient = {
      json: {
        get: async (key: string) => {
          expect(key).toBe("checkpoint:test-thread::test-checkpoint");
          return jsonDoc;
        },
      },
      ft: {
        info: async () => {
          throw new Error("Index not found");
        },
        create: async () => {},
      },
    } as any;

    const saver = new RedisSaver(mockClient);
    const result = await saver.getTuple({
      configurable: {
        thread_id: "test-thread",
        checkpoint_id: "test-checkpoint",
      },
    });

    expect(result?.checkpoint).toEqual(jsonDoc.checkpoint);
    expect(result?.metadata).toEqual(jsonDoc.metadata);
  });

  it("should save a checkpoint with put method", async () => {
    let savedKey: string | undefined;
    let savedData: any;

    const mockClient = {
      json: {
        set: async (key: string, _path: string, data: any) => {
          savedKey = key;
          savedData = data;
          return "OK";
        },
      },
      ft: {
        info: async () => {
          throw new Error("Index not found");
        },
        create: async () => {},
      },
    } as any;

    const saver = new RedisSaver(mockClient);
    const checkpoint = {
      v: 1,
      id: "cp-123",
      ts: "2024-01-01T00:00:00Z",
      channel_values: { test: "value" },
      channel_versions: { test: 1 },
      versions_seen: {},
    };

    const config = {
      configurable: {
        thread_id: "thread-1",
        checkpoint_ns: "",
      },
    };

    const result = await saver.put(
      config,
      checkpoint,
      { source: "update", step: 0, parents: {} },
      undefined as any
    );

    expect(savedKey).toBe("checkpoint:thread-1::cp-123");
    expect(savedData.checkpoint.id).toBe(checkpoint.id);
    expect(savedData.checkpoint.channel_values).toEqual(
      checkpoint.channel_values
    );
    expect(savedData.metadata).toEqual({
      source: "update",
      step: 0,
      parents: {},
    });
    expect(result.configurable?.checkpoint_id).toBe("cp-123");
  });

  it("should list checkpoints for a thread", async () => {
    const checkpoints = [
      { id: "cp-1", ts: "2024-01-01T01:00:00Z" },
      { id: "cp-2", ts: "2024-01-01T02:00:00Z" },
      { id: "cp-3", ts: "2024-01-01T03:00:00Z" },
    ];

    const mockClient = {
      keys: async (pattern: string) => {
        expect(pattern).toBe("checkpoint:thread-1::*");
        return checkpoints.map((cp) => `checkpoint:thread-1::${cp.id}`);
      },
      json: {
        get: async (key: string) => {
          const id = key.split(":")[3];
          const checkpoint = checkpoints.find((cp) => cp.id === id);
          return {
            thread_id: "thread-1",
            checkpoint_ns: "",
            checkpoint_id: id,
            parent_checkpoint_id: null,
            checkpoint: {
              v: 1,
              id,
              ts: checkpoint?.ts,
              channel_values: {},
              channel_versions: {},
              versions_seen: {},
            },
            metadata: {},
          };
        },
      },
      ft: {
        info: async () => {
          throw new Error("Index not found");
        },
        create: async () => {},
        search: async () => {
          // Return the mocked checkpoints as search results, sorted by timestamp DESC (newest first)
          const docs = checkpoints
            .map((cp) => ({
              id: `checkpoint:thread-1::${cp.id}`,
              value: {
                thread_id: "thread-1",
                checkpoint_ns: "__empty__",
                checkpoint_id: cp.id,
                parent_checkpoint_id: null,
                checkpoint_ts: Date.parse(cp.ts),
                checkpoint: {
                  v: 1,
                  id: cp.id,
                  ts: cp.ts,
                  channel_values: {},
                  channel_versions: {},
                  versions_seen: {},
                },
                metadata: {},
                has_writes: "false",
              },
            }))
            .sort((a, b) => b.value.checkpoint_ts - a.value.checkpoint_ts);
          return { total: docs.length, documents: docs };
        },
      },
    } as any;

    const saver = new RedisSaver(mockClient);
    const results = [];

    for await (const checkpoint of saver.list({
      configurable: { thread_id: "thread-1" },
    })) {
      results.push(checkpoint);
    }

    expect(results).toHaveLength(3);
    expect(results[0].checkpoint.id).toBe("cp-3"); // Most recent first
  });

  it("should save pending writes with putWrites", async () => {
    const savedWrites: any[] = [];

    const mockClient = {
      json: {
        set: async (key: string, _path: string, data: any) => {
          if (key.startsWith("checkpoint_write:")) {
            savedWrites.push({ key, data });
          }
          return "OK";
        },
        get: async () => null, // Mock for checkpoint retrieval
      },
      ft: {
        info: async () => {
          throw new Error("Index not found");
        },
        create: async () => {},
      },
      zAdd: async () => {},
      zRange: async () => [],
      exists: async () => 0, // Mock checkpoint doesn't exist
      expire: async () => {}, // Mock TTL support
    } as any;

    const saver = new RedisSaver(mockClient);
    const writes: PendingWrite[] = [
      ["channel1", "value1"],
      ["channel2", "value2"],
    ];

    await saver.putWrites(
      {
        configurable: {
          thread_id: "thread-1",
          checkpoint_ns: "",
          checkpoint_id: "cp-1",
        },
      },
      writes,
      "task-1"
    );

    expect(savedWrites).toHaveLength(2);
    expect(savedWrites[0].key).toBe("checkpoint_write:thread-1::cp-1:task-1:0");
    expect(savedWrites[0].data.channel).toBe("channel1");
    expect(savedWrites[0].data.value).toBe("value1");
    expect(savedWrites[1].key).toBe("checkpoint_write:thread-1::cp-1:task-1:1");
    expect(savedWrites[1].data.channel).toBe("channel2");
    expect(savedWrites[1].data.value).toBe("value2");
  });

  it("should delete a thread with deleteThread", async () => {
    const deletedKeys: string[] = [];

    const mockClient = {
      keys: async (pattern: string) => {
        if (pattern === "checkpoint:thread-1:*") {
          return ["checkpoint:thread-1:cp-1", "checkpoint:thread-1:cp-2"];
        }
        if (pattern === "writes:thread-1:*") {
          return ["writes:thread-1:cp-1:task-1"];
        }
        return [];
      },
      del: async (keys: string[]) => {
        deletedKeys.push(...keys);
        return keys.length;
      },
    } as any;

    const saver = new RedisSaver(mockClient);
    await saver.deleteThread("thread-1");

    expect(deletedKeys).toContain("checkpoint:thread-1:cp-1");
    expect(deletedKeys).toContain("checkpoint:thread-1:cp-2");
    expect(deletedKeys).toContain("writes:thread-1:cp-1:task-1");
  });
});

// ============================================================================
// INTEGRATION TESTS (from integration.test.ts)
// ============================================================================
describe("RedisSaver Integration Tests", () => {
  let container: StartedTestContainer;
  let redisClient: any;
  let redisUrl: string;

  beforeAll(async () => {
    container = await new GenericContainer("redis/redis-stack-server:latest")
      .withExposedPorts(6379)
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(6379);
    redisUrl = `redis://${host}:${port}`;

    redisClient = createClient({ url: redisUrl });
    await redisClient.connect();
  }, 60000);

  afterAll(async () => {
    await redisClient?.quit();
    await container?.stop();
  });

  beforeEach(async () => {
    await redisClient.flushAll();
  });

  it("should handle basic integration workflow", async () => {
    const saver = new RedisSaver(redisClient);

    const config: RunnableConfig = {
      configurable: {
        thread_id: "integration-test",
        checkpoint_ns: "",
      },
    };

    const checkpoint: Checkpoint = {
      ...emptyCheckpoint(),
      id: uuid6(-1),
      channel_values: { test: "integration" },
    };

    // Save checkpoint
    const saved = await saver.put(
      config,
      checkpoint,
      { source: "update", step: 0, parents: {} },
      undefined as any
    );
    expect(saved.configurable?.checkpoint_id).toBe(checkpoint.id);

    // Retrieve checkpoint
    const retrieved = await saver.getTuple(saved);
    expect(retrieved?.checkpoint.id).toBe(checkpoint.id);
    expect(retrieved?.checkpoint.channel_values).toEqual({
      test: "integration",
    });
  });

  it("should work with fromUrl factory method", async () => {
    const fromUrlSaver = await RedisSaver.fromUrl(redisUrl);

    const config: RunnableConfig = {
      configurable: {
        thread_id: "fromurl-test",
        checkpoint_ns: "",
      },
    };

    const checkpoint: Checkpoint = {
      ...emptyCheckpoint(),
      id: uuid6(-1),
      channel_values: { test: "fromUrl" },
    };

    await fromUrlSaver.put(
      config,
      checkpoint,
      { source: "update", step: 0, parents: {} },
      undefined as any
    );

    const tuple = await fromUrlSaver.getTuple({
      configurable: {
        thread_id: "fromurl-test",
        checkpoint_ns: "",
        checkpoint_id: checkpoint.id,
      },
    });

    expect(tuple?.checkpoint.channel_values).toEqual({ test: "fromUrl" });
    await fromUrlSaver.end();
  });
});

// ============================================================================
// FROM URL TESTS (from test-from-url.test.ts)
// ============================================================================
describe("test_from_conn_string", () => {
  let container: StartedTestContainer;
  let redisUrl: string;

  beforeAll(async () => {
    container = await new GenericContainer("redis/redis-stack-server:latest")
      .withExposedPorts(6379)
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(6379);
    redisUrl = `redis://${host}:${port}`;
  }, 60000);

  afterAll(async () => {
    await container?.stop();
  });

  it("should create a RedisSaver with a connection URL", async () => {
    const saver = await RedisSaver.fromUrl(redisUrl);

    // Verify connection works by creating and retrieving a checkpoint
    const config: RunnableConfig = {
      configurable: {
        thread_id: "test-thread",
        checkpoint_ns: "",
      },
    };

    const checkpoint: Checkpoint = {
      ...emptyCheckpoint(),
      id: uuid6(-1),
    };

    const saved = await saver.put(
      config,
      checkpoint,
      { source: "update", step: 0, parents: {} },
      undefined as any
    );
    expect(saved.configurable?.checkpoint_id).toBe(checkpoint.id);

    const retrieved = await saver.getTuple(saved);
    expect(retrieved).toBeDefined();
    expect(retrieved?.checkpoint.id).toBe(checkpoint.id);

    await saver.end();
  });

  it("should handle multiple savers from same URL", async () => {
    const saver1 = await RedisSaver.fromUrl(redisUrl);
    const saver2 = await RedisSaver.fromUrl(redisUrl);

    const config1: RunnableConfig = {
      configurable: {
        thread_id: "test-thread-1",
        checkpoint_ns: "",
      },
    };

    const config2: RunnableConfig = {
      configurable: {
        thread_id: "test-thread-2",
        checkpoint_ns: "",
      },
    };

    const checkpoint1: Checkpoint = {
      ...emptyCheckpoint(),
      id: uuid6(-1),
    };

    const checkpoint2: Checkpoint = {
      ...emptyCheckpoint(),
      id: uuid6(-1),
    };

    // Save checkpoints with different savers
    await saver1.put(
      config1,
      checkpoint1,
      { source: "update", step: 0, parents: {} },
      undefined as any
    );
    await saver2.put(
      config2,
      checkpoint2,
      { source: "update", step: 1, parents: {} },
      undefined as any
    );

    // Retrieve with original savers
    const retrieved1 = await saver1.getTuple({
      configurable: {
        thread_id: "test-thread-1",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });

    const retrieved2 = await saver2.getTuple({
      configurable: {
        thread_id: "test-thread-2",
        checkpoint_ns: "",
        checkpoint_id: checkpoint2.id,
      },
    });

    expect(retrieved1?.checkpoint.id).toBe(checkpoint1.id);
    expect(retrieved2?.checkpoint.id).toBe(checkpoint2.id);

    await saver1.end();
    await saver2.end();
  });

  it("should handle cross-saver retrieval", async () => {
    const saver1 = await RedisSaver.fromUrl(redisUrl);
    const saver2 = await RedisSaver.fromUrl(redisUrl);

    const config: RunnableConfig = {
      configurable: {
        thread_id: "shared-thread",
        checkpoint_ns: "",
      },
    };

    const checkpoint: Checkpoint = {
      ...emptyCheckpoint(),
      id: uuid6(-1),
    };

    // Save with saver1
    await saver1.put(
      config,
      checkpoint,
      { source: "update", step: 0, parents: {} },
      undefined as any
    );

    // Retrieve with saver2
    const retrieved = await saver2.getTuple({
      configurable: {
        thread_id: "shared-thread",
        checkpoint_ns: "",
        checkpoint_id: checkpoint.id,
      },
    });

    expect(retrieved?.checkpoint.id).toBe(checkpoint.id);
    expect(retrieved?.metadata).toEqual({
      source: "update",
      step: 0,
      parents: {},
    });

    await saver1.end();
    await saver2.end();
  });
});

// ============================================================================
// SYNC TESTS (from test-sync.test.ts)
// ============================================================================
describe("test_sync_redis_checkpointer", () => {
  let container: StartedTestContainer;
  let redisClient: any;
  let redisUrl: string;

  beforeAll(async () => {
    container = await new GenericContainer("redis/redis-stack-server:latest")
      .withExposedPorts(6379)
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(6379);
    redisUrl = `redis://${host}:${port}`;

    redisClient = createClient({ url: redisUrl });
    await redisClient.connect();
  }, 60000);

  afterAll(async () => {
    await redisClient?.quit();
    await container?.stop();
  });

  beforeEach(async () => {
    await redisClient.flushAll();
  });

  it("should handle basic checkpoint operations", async () => {
    const saver = await RedisSaver.fromUrl(redisUrl);

    const config: RunnableConfig = {
      configurable: {
        thread_id: "test-thread-1",
        checkpoint_ns: "",
      },
    };

    // Create checkpoint
    const checkpoint: Checkpoint = {
      v: 1,
      id: uuid6(0),
      ts: new Date().toISOString(),
      channel_values: {
        messages: [
          { type: "human", content: "what's the weather in sf?" },
          { type: "ai", content: "I'll check the weather for you" },
          { type: "tool", content: "get_weather(city='sf')" },
          { type: "ai", content: "It's always sunny in sf" },
        ],
      },
      channel_versions: { messages: "1" },
      versions_seen: {},
    };

    // Store checkpoint
    const nextConfig = await saver.put(
      config,
      checkpoint,
      { source: "update", step: 1, parents: {} },
      { messages: "1" }
    );

    expect(nextConfig.configurable).toBeDefined();
    expect(nextConfig.configurable?.thread_id).toBe("test-thread-1");
    expect(nextConfig.configurable?.checkpoint_id).toBe(checkpoint.id);

    // Get latest checkpoint
    const latest = await saver.get(config);

    expect(latest).toBeDefined();
    expect(latest?.id).toBe(checkpoint.id);
    expect(latest?.channel_values.messages).toHaveLength(4);

    // Get checkpoint tuple
    const tuple = await saver.getTuple(config);

    expect(tuple).toBeDefined();
    expect(tuple?.checkpoint.id).toBe(checkpoint.id);
    expect(tuple?.metadata?.source).toBe("update");
    expect(tuple?.metadata?.step).toBe(1);
    expect(tuple?.metadata?.parents).toEqual({});

    // List checkpoints
    const checkpoints = [];
    for await (const cp of saver.list(config)) {
      checkpoints.push(cp);
    }

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].checkpoint.id).toBe(checkpoint.id);

    await saver.end();
  });

  it("should handle multiple checkpoints in sequence", async () => {
    const saver = await RedisSaver.fromUrl(redisUrl);

    const config: RunnableConfig = {
      configurable: {
        thread_id: "sequence-thread",
        checkpoint_ns: "",
      },
    };

    // Create and store multiple checkpoints
    const checkpoint1 = emptyCheckpoint();
    checkpoint1.id = uuid6(0);

    await saver.put(
      config,
      checkpoint1,
      { source: "input", step: 0, parents: {} },
      undefined as any
    );

    const checkpoint2 = {
      ...checkpoint1,
      id: uuid6(1),
      ts: new Date().toISOString(),
      channel_versions: { ...checkpoint1.channel_versions, count: "1" },
      channel_values: { ...checkpoint1.channel_values, count: 1 },
    };

    await saver.put(
      {
        ...config,
        configurable: { ...config.configurable, checkpoint_id: checkpoint1.id },
      },
      checkpoint2,
      { source: "loop", step: 1, parents: {} },
      undefined as any
    );

    const checkpoint3 = {
      ...checkpoint2,
      id: uuid6(2),
      ts: new Date().toISOString(),
      channel_versions: { ...checkpoint2.channel_versions, output: "1" },
      channel_values: { ...checkpoint2.channel_values, output: "result" },
    };

    await saver.put(
      {
        ...config,
        configurable: { ...config.configurable, checkpoint_id: checkpoint2.id },
      },
      checkpoint3,
      { source: "loop", step: 2, parents: {} },
      undefined as any
    );

    // Get latest should return checkpoint3
    const latest = await saver.get(config);
    expect(latest?.id).toBe(checkpoint3.id);

    // List should return all 3 in reverse order
    const checkpoints = [];
    for await (const cp of saver.list(config)) {
      checkpoints.push(cp);
    }

    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0].checkpoint.id).toBe(checkpoint3.id);
    expect(checkpoints[1].checkpoint.id).toBe(checkpoint2.id);
    expect(checkpoints[2].checkpoint.id).toBe(checkpoint1.id);

    // Check parent relationships
    expect(checkpoints[0].parentConfig?.configurable?.checkpoint_id).toBe(
      checkpoint2.id
    );
    expect(checkpoints[1].parentConfig?.configurable?.checkpoint_id).toBe(
      checkpoint1.id
    );
    expect(checkpoints[2].parentConfig).toBeUndefined();

    await saver.end();
  });

  it("should handle namespace isolation", async () => {
    const saver = await RedisSaver.fromUrl(redisUrl);

    // Thread 1 with default namespace
    const config1: RunnableConfig = {
      configurable: {
        thread_id: "namespace-thread",
        checkpoint_ns: "",
      },
    };

    // Thread 1 with inner namespace
    const config2: RunnableConfig = {
      configurable: {
        thread_id: "namespace-thread",
        checkpoint_ns: "inner",
      },
    };

    // Different thread
    const config3: RunnableConfig = {
      configurable: {
        thread_id: "other-thread",
        checkpoint_ns: "",
      },
    };

    const checkpoint1 = emptyCheckpoint();
    checkpoint1.id = uuid6(0);

    const checkpoint2 = emptyCheckpoint();
    checkpoint2.id = uuid6(1);

    const checkpoint3 = emptyCheckpoint();
    checkpoint3.id = uuid6(2);

    // Store checkpoints in different namespaces
    await saver.put(
      config1,
      checkpoint1,
      { source: "update", step: 0, parents: {} },
      undefined as any
    );
    await saver.put(
      config2,
      checkpoint2,
      { source: "update", step: 0, parents: {} },
      undefined as any
    );
    await saver.put(
      config3,
      checkpoint3,
      { source: "update", step: 0, parents: {} },
      undefined as any
    );

    // Verify namespace isolation
    const latest1 = await saver.get(config1);
    const latest2 = await saver.get(config2);
    const latest3 = await saver.get(config3);

    expect(latest1?.id).toBe(checkpoint1.id);
    expect(latest2?.id).toBe(checkpoint2.id);
    expect(latest3?.id).toBe(checkpoint3.id);

    // List should only return checkpoints from the same namespace
    const list1 = [];
    for await (const cp of saver.list(config1)) {
      list1.push(cp);
    }
    expect(list1).toHaveLength(1);
    expect(list1[0].checkpoint.id).toBe(checkpoint1.id);

    const list2 = [];
    for await (const cp of saver.list(config2)) {
      list2.push(cp);
    }
    expect(list2).toHaveLength(1);
    expect(list2[0].checkpoint.id).toBe(checkpoint2.id);

    await saver.end();
  });

  it("should handle checkpoint retrieval by ID", async () => {
    const saver = await RedisSaver.fromUrl(redisUrl);

    const config: RunnableConfig = {
      configurable: {
        thread_id: "id-retrieval-thread",
        checkpoint_ns: "",
      },
    };

    // Create multiple checkpoints
    const checkpoint1 = emptyCheckpoint();
    checkpoint1.id = uuid6(0);

    const checkpoint2 = emptyCheckpoint();
    checkpoint2.id = uuid6(1);
    checkpoint2.channel_values = { count: 42 };

    await saver.put(
      config,
      checkpoint1,
      { source: "update", step: 1, parents: {} },
      undefined as any
    );
    await saver.put(
      config,
      checkpoint2,
      { source: "update", step: 2, parents: {} },
      undefined as any
    );

    // Get latest (should be checkpoint2)
    const latest = await saver.get(config);
    expect(latest?.id).toBe(checkpoint2.id);

    // Get specific checkpoint by ID
    const specific = await saver.get({
      configurable: {
        thread_id: "id-retrieval-thread",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });

    expect(specific?.id).toBe(checkpoint1.id);
    expect(specific?.channel_values.count).toBeUndefined();

    // Get tuple for specific checkpoint
    const tuple = await saver.getTuple({
      configurable: {
        thread_id: "id-retrieval-thread",
        checkpoint_ns: "",
        checkpoint_id: checkpoint2.id,
      },
    });

    expect(tuple?.checkpoint.id).toBe(checkpoint2.id);
    expect(tuple?.checkpoint.channel_values.count).toBe(42);
    expect(tuple?.metadata?.step).toBe(2);

    await saver.end();
  });

  it("should handle before parameter in list", async () => {
    const saver = await RedisSaver.fromUrl(redisUrl);

    const config: RunnableConfig = {
      configurable: {
        thread_id: "before-test-thread",
        checkpoint_ns: "",
      },
    };

    // Create checkpoints with timestamps
    const checkpoints = [];
    for (let i = 0; i < 5; i++) {
      const cp = emptyCheckpoint();
      cp.id = uuid6(i);
      cp.ts = new Date(Date.now() + i * 1000).toISOString(); // Incremental timestamps
      checkpoints.push(cp);

      await saver.put(
        config,
        cp,
        { source: "update", step: i, parents: {} },
        undefined as any
      );
    }

    // List all checkpoints
    const allCps = [];
    for await (const cp of saver.list(config)) {
      allCps.push(cp);
    }
    expect(allCps).toHaveLength(5);

    // List checkpoints before the 3rd one
    const beforeCps = [];
    for await (const cp of saver.list(config, {
      before: {
        configurable: {
          ...config.configurable,
          checkpoint_id: checkpoints[2].id,
        },
      },
    })) {
      beforeCps.push(cp);
    }

    // Should only return checkpoints 0 and 1
    expect(beforeCps).toHaveLength(2);
    expect(beforeCps[0].checkpoint.id).toBe(checkpoints[1].id);
    expect(beforeCps[1].checkpoint.id).toBe(checkpoints[0].id);

    await saver.end();
  });
});

// ============================================================================
// SHALLOW REDIS SAVER TESTS (from test-shallow.test.ts)
// ============================================================================
describe("ShallowRedisSaver", () => {
  let container: StartedTestContainer;
  let client: any;
  let saver: ShallowRedisSaver;

  beforeEach(async () => {
    container = await new GenericContainer("redis/redis-stack-server:latest")
      .withExposedPorts(6379)
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(6379);

    client = createClient({
      url: `redis://${host}:${port}`,
    });

    await client.connect();
    saver = new ShallowRedisSaver(client);
  });

  afterEach(async () => {
    if (client && client.isOpen) {
      await client.disconnect();
    }
    if (container) {
      await container.stop();
    }
  });

  it("should only keep the latest checkpoint per thread", async () => {
    const threadId = "test-thread";
    const checkpointNs = "";

    // Create first checkpoint
    const config1: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
      },
    };

    const checkpoint1: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: uuid6(0),
      channel_values: { counter: 1 },
      channel_versions: { counter: "1.0" },
      versions_seen: {},
    };

    const metadata1: CheckpointMetadata = {
      source: "input",
      step: 1,
      parents: {},
    };

    await saver.put(config1, checkpoint1, metadata1, { counter: "1.0" });

    // Create second checkpoint for same thread
    const checkpoint2: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: uuid6(1),
      channel_values: { counter: 2 },
      channel_versions: { counter: "2.0" },
      versions_seen: {},
    };

    const metadata2: CheckpointMetadata = {
      source: "loop",
      step: 2,
      parents: {},
    };

    await saver.put(config1, checkpoint2, metadata2, { counter: "2.0" });

    // List checkpoints - should only have the latest one
    const results = [];
    for await (const tuple of saver.list(null)) {
      results.push(tuple);
    }

    expect(results).toHaveLength(1);
    expect(results[0].checkpoint?.id).toBe(checkpoint2.id);
    expect(results[0].checkpoint?.channel_values?.counter).toBe(2);
  });

  it("should support search with metadata filters", async () => {
    // Create checkpoints with different metadata
    const config1: RunnableConfig = {
      configurable: {
        thread_id: "thread-1",
        checkpoint_ns: "",
      },
    };

    const config2: RunnableConfig = {
      configurable: {
        thread_id: "thread-2",
        checkpoint_ns: "",
      },
    };

    const checkpoint1: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: uuid6(0),
      channel_values: { value: "a" },
      channel_versions: { value: "1.0" },
      versions_seen: {},
    };

    const checkpoint2: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: uuid6(1),
      channel_values: { value: "b" },
      channel_versions: { value: "1.0" },
      versions_seen: {},
    };

    const metadata1: CheckpointMetadata<{ writes?: any; score?: number }> = {
      source: "input",
      step: 2,
      parents: {},
      writes: {},
      score: 1,
    };

    const metadata2: CheckpointMetadata<{ writes?: any; score?: any }> = {
      source: "loop",
      step: 1,
      parents: {},
      writes: { foo: "bar" },
      score: null,
    };

    await saver.put(config1, checkpoint1, metadata1, { value: "1.0" });
    await saver.put(config2, checkpoint2, metadata2, { value: "1.0" });

    // Test various search queries
    const testCases = [
      {
        filter: { source: "input", step: 2, parents: {} } as CheckpointMetadata,
        expectedCount: 1,
      },
      {
        filter: { source: "loop", step: 1, parents: {} } as CheckpointMetadata,
        expectedCount: 1,
      },
      {
        filter: undefined, // Search all
        expectedCount: 2,
      },
      {
        filter: {
          source: "update",
          step: 1,
          parents: {},
        } as CheckpointMetadata,
        expectedCount: 0,
      },
    ];

    for (const { filter, expectedCount } of testCases) {
      const results = [];
      const options = filter ? { filter } : undefined;
      for await (const tuple of saver.list(null, options)) {
        results.push(tuple);
      }
      expect(results).toHaveLength(expectedCount);
    }
  });

  it("should overwrite writes, not append them", async () => {
    const config: RunnableConfig = {
      configurable: {
        thread_id: "test-thread",
        checkpoint_ns: "",
      },
    };

    const checkpoint: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: uuid6(0),
      channel_values: { value: "test" },
      channel_versions: { value: "1.0" },
      versions_seen: {},
    };

    const metadata: CheckpointMetadata = {
      source: "input",
      step: 1,
      parents: {},
    };

    // Store initial checkpoint
    const savedConfig = await saver.put(config, checkpoint, metadata, {
      value: "1.0",
    });

    // Add initial writes
    await saver.putWrites(savedConfig, [["channel1", "value1"]], "task1");

    // Add more writes for the same task (should overwrite)
    await saver.putWrites(savedConfig, [["channel2", "value2"]], "task1");

    // Verify only latest writes exist
    const result = await saver.getTuple(savedConfig);
    expect(result).not.toBeNull();
    expect(result?.pendingWrites).toHaveLength(1);
    expect(result?.pendingWrites?.[0]).toEqual(["task1", "channel2", "value2"]);
  });

  it("should handle null characters in metadata", async () => {
    const config: RunnableConfig = {
      configurable: {
        thread_id: "test-thread",
        checkpoint_ns: "",
      },
    };

    const checkpoint: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: uuid6(0),
      channel_values: { value: "test" },
      channel_versions: { value: "1.0" },
      versions_seen: {},
    };

    const metadata: CheckpointMetadata<{ my_key?: string }> = {
      source: "input",
      step: 0,
      parents: {},
      my_key: "\x00abc", // Null character in value
    };

    // Store checkpoint with null character in metadata
    const savedConfig = await saver.put(config, checkpoint, metadata, {
      value: "1.0",
    });

    // Retrieve and verify null character is handled
    const result = await saver.getTuple(savedConfig);
    expect(result).not.toBeNull();
    // Null characters should be sanitized
    expect((result?.metadata as any)?.my_key).toBe("abc");
  });

  it("should support fromUrl factory method", async () => {
    const host = container.getHost();
    const port = container.getMappedPort(6379);
    const url = `redis://${host}:${port}`;

    const shallowSaver = await ShallowRedisSaver.fromUrl(url);

    // Test basic operation
    const config: RunnableConfig = {
      configurable: {
        thread_id: "factory-thread",
        checkpoint_ns: "",
      },
    };

    const checkpoint: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: uuid6(0),
      channel_values: { test: "value" },
      channel_versions: { test: "1.0" },
      versions_seen: {},
    };

    await shallowSaver.put(
      config,
      checkpoint,
      { source: "input", step: 0, parents: {} },
      { test: "1.0" }
    );

    const result = await shallowSaver.getTuple(config);
    expect(result).not.toBeNull();
    expect(result?.checkpoint?.channel_values?.test).toBe("value");

    await shallowSaver.end();
  });

  it("should store channel values inline, not as blobs", async () => {
    const threadId = `test_thread_${uuid6(0)}`;
    const checkpointNs = "";

    const config: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
      },
    };

    const checkpoint: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: uuid6(0),
      channel_values: {
        test_channel: ["test_value"],
        another_channel: { key: "value" },
      },
      channel_versions: {
        test_channel: "1",
        another_channel: "2",
      },
      versions_seen: {},
    };

    const metadata: CheckpointMetadata = {
      source: "input",
      step: 1,
      parents: {},
    };

    await saver.put(config, checkpoint, metadata, {
      test_channel: "1",
      another_channel: "2",
    });

    // Check that no blob keys were created
    const allKeys = await client.keys("*");
    const blobKeys = allKeys.filter((k: string) =>
      k.includes("checkpoint_blob")
    );
    expect(blobKeys).toHaveLength(0);

    // Verify channel values are stored inline
    const checkpointKeys = allKeys.filter(
      (k: string) => k.startsWith("checkpoint:") && k.includes(threadId)
    );
    expect(checkpointKeys).toHaveLength(1);

    const checkpointData = await client.json.get(checkpointKeys[0]);
    expect(checkpointData.checkpoint.channel_values).toBeDefined();
    expect(checkpointData.checkpoint.channel_values.test_channel).toEqual([
      "test_value",
    ]);
    expect(checkpointData.checkpoint.channel_values.another_channel).toEqual({
      key: "value",
    });
  });

  it("should clean up old writes when putting new checkpoint", async () => {
    const threadId = `test_thread_${uuid6(0)}`;
    const checkpointNs = "";

    // First checkpoint with writes
    const config1: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: uuid6(0),
      },
    };

    const checkpoint1: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: config1.configurable!.checkpoint_id!,
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };

    await saver.put(
      config1,
      checkpoint1,
      { source: "input", step: 1, parents: {} },
      undefined as any
    );
    await saver.putWrites(
      config1,
      [
        ["channel1", "value1"],
        ["channel2", "value2"],
      ],
      "task1"
    );

    // Check write keys exist
    let writeKeys = await client.keys(`checkpoint_write:${threadId}:*`);
    expect(writeKeys.length).toBe(2);

    // Second checkpoint with different writes
    const config2: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: uuid6(1),
      },
    };

    const checkpoint2: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: config2.configurable!.checkpoint_id!,
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };

    await saver.put(
      config2,
      checkpoint2,
      { source: "loop", step: 2, parents: {} },
      undefined as any
    );
    await saver.putWrites(
      config2,
      [
        ["channel3", "value3"],
        ["channel4", "value4"],
      ],
      "task2"
    );

    // Check that old writes are cleaned up
    writeKeys = await client.keys(`checkpoint_write:${threadId}:*`);
    expect(writeKeys.length).toBe(2); // Only new writes should exist

    // Verify these are the new writes
    for (const key of writeKeys) {
      expect(key).toContain(config2.configurable!.checkpoint_id);
    }
  });

  it("should clean up old checkpoints when putting new one", async () => {
    const threadId = `test_thread_${uuid6(0)}`;
    const checkpointNs = "";

    // Create first checkpoint
    const config: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
      },
    };

    const checkpoint1: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: uuid6(0),
      channel_values: { value: 1 },
      channel_versions: { value: "1.0" },
      versions_seen: {},
    };

    await saver.put(
      config,
      checkpoint1,
      { source: "input", step: 1, parents: {} },
      { value: "1.0" }
    );

    // Check that checkpoint exists (in shallow mode, key doesn't contain checkpoint_id)
    let checkpointKeys = await client.keys(`checkpoint:${threadId}:*`);
    expect(checkpointKeys.length).toBe(1);
    expect(checkpointKeys[0]).toBe(`checkpoint:${threadId}::shallow`);

    // Verify it contains checkpoint1's data
    let checkpointData = await client.json.get(checkpointKeys[0]);
    expect(checkpointData.checkpoint_id).toBe(checkpoint1.id);

    // Create second checkpoint
    const checkpoint2: Checkpoint = {
      v: 1,
      ts: new Date().toISOString(),
      id: uuid6(1),
      channel_values: { value: 2 },
      channel_versions: { value: "2.0" },
      versions_seen: {},
    };

    await saver.put(
      config,
      checkpoint2,
      { source: "loop", step: 2, parents: {} },
      { value: "2.0" }
    );

    // Check that still only one checkpoint key exists (shallow mode reuses same key)
    checkpointKeys = await client.keys(`checkpoint:${threadId}:*`);
    expect(checkpointKeys.length).toBe(1);
    expect(checkpointKeys[0]).toBe(`checkpoint:${threadId}::shallow`);

    // Verify it now contains checkpoint2's data
    checkpointData = await client.json.get(checkpointKeys[0]);
    expect(checkpointData.checkpoint_id).toBe(checkpoint2.id);
    expect(checkpointData.checkpoint_id).not.toBe(checkpoint1.id);
  });
});
