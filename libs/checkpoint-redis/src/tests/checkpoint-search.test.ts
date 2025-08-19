import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { createClient } from "redis";
import { RedisSaver } from "../index.js";
import {
  CheckpointMetadata,
  emptyCheckpoint,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";

// ============================================================================
// SEARCH INDEX TESTS (from search-index.test.ts)
// ============================================================================
describe("RediSearch Index Creation", () => {
  let container: StartedTestContainer;
  let redisClient: any;

  beforeAll(async () => {
    container = await new GenericContainer("redis/redis-stack-server:latest")
      .withExposedPorts(6379)
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(6379);
    const redisUrl = `redis://${host}:${port}`;

    redisClient = createClient({ url: redisUrl });
    await redisClient.connect();
  }, 60000);

  afterAll(async () => {
    await redisClient?.quit();
    await container?.stop();
  });

  it("should create search indexes on initialization", async () => {
    const saver = new RedisSaver(redisClient);
    await (saver as any).ensureIndexes();

    // Verify checkpoint index exists
    const checkpointIndexInfo = await redisClient.ft.info("checkpoints");
    expect(checkpointIndexInfo).toBeDefined();
    expect(checkpointIndexInfo.indexName).toBe("checkpoints");

    // Verify it has the right fields - fields are aliased
    const fields = checkpointIndexInfo.attributes.map(
      (attr: any) => attr.attribute || attr.identifier
    );
    expect(fields).toContain("thread_id");
    expect(fields).toContain("checkpoint_ns");
    expect(fields).toContain("checkpoint_id");
    expect(fields).toContain("parent_checkpoint_id");
    expect(fields).toContain("checkpoint_ts");
    expect(fields).toContain("has_writes");
    expect(fields).toContain("source");
    expect(fields).toContain("step");
  });

  it("should create checkpoint_blobs index", async () => {
    const saver = new RedisSaver(redisClient);
    await (saver as any).ensureIndexes();

    const blobIndexInfo = await redisClient.ft.info("checkpoint_blobs");
    expect(blobIndexInfo).toBeDefined();
    expect(blobIndexInfo.indexName).toBe("checkpoint_blobs");

    const fields = blobIndexInfo.attributes.map(
      (attr: any) => attr.attribute || attr.identifier
    );
    expect(fields).toContain("thread_id");
    expect(fields).toContain("checkpoint_ns");
    expect(fields).toContain("checkpoint_id");
    expect(fields).toContain("channel");
    expect(fields).toContain("version");
    expect(fields).toContain("type");
  });

  it("should create checkpoint_writes index", async () => {
    const saver = new RedisSaver(redisClient);
    await (saver as any).ensureIndexes();

    const writesIndexInfo = await redisClient.ft.info("checkpoint_writes");
    expect(writesIndexInfo).toBeDefined();
    expect(writesIndexInfo.indexName).toBe("checkpoint_writes");

    const fields = writesIndexInfo.attributes.map(
      (attr: any) => attr.attribute || attr.identifier
    );
    expect(fields).toContain("thread_id");
    expect(fields).toContain("checkpoint_ns");
    expect(fields).toContain("checkpoint_id");
    expect(fields).toContain("task_id");
    expect(fields).toContain("idx");
    expect(fields).toContain("channel");
    expect(fields).toContain("type");
  });
});

// ============================================================================
// SEARCH TESTS (from test-search.test.ts)
// ============================================================================
describe("test_search", () => {
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
    // Don't use flushAll as it removes indexes
    // Instead, delete checkpoint keys specifically
    const keys = await redisClient.keys("checkpoint*");
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  });

  it("should search checkpoints by metadata", async () => {
    const saver = await RedisSaver.fromUrl(redisUrl);

    const config1: RunnableConfig = {
      configurable: {
        thread_id: "search-thread-1",
        checkpoint_ns: "",
      },
    };

    const config2: RunnableConfig = {
      configurable: {
        thread_id: "search-thread-2",
        checkpoint_ns: "",
      },
    };

    const config3: RunnableConfig = {
      configurable: {
        thread_id: "search-thread-2",
        checkpoint_ns: "inner",
      },
    };

    const checkpoint1 = emptyCheckpoint();
    checkpoint1.id = uuid6(0);

    const checkpoint2 = emptyCheckpoint();
    checkpoint2.id = uuid6(1);
    checkpoint2.channel_values = { count: 1 };

    const checkpoint3 = emptyCheckpoint();
    checkpoint3.id = uuid6(2);

    const metadata1: CheckpointMetadata<{ score?: number }> = {
      source: "input",
      step: 2,
      parents: {},
      score: 1,
    };

    const metadata2: CheckpointMetadata<{ score?: null }> = {
      source: "loop",
      step: 1,
      parents: {},
      score: null,
    };

    const metadata3: CheckpointMetadata = {
      source: "update",
      step: 0,
      parents: {},
    };

    // Store checkpoints with different metadata
    await saver.put(config1, checkpoint1, metadata1, {});
    await saver.put(config2, checkpoint2, metadata2, {});
    await saver.put(config3, checkpoint3, metadata3, {});

    // Wait a bit for indexing to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Search by single metadata field
    const searchBySource = [];
    for await (const cp of saver.list(null, {
      filter: { source: "input", step: 2, parents: {} } as CheckpointMetadata,
    })) {
      searchBySource.push(cp);
    }
    expect(searchBySource).toHaveLength(1);
    expect(searchBySource[0].checkpoint.id).toBe(checkpoint1.id);
    expect(searchBySource[0].metadata?.source).toBe("input");

    // Search by step
    const searchByStep = [];
    for await (const cp of saver.list(null, {
      filter: { source: "loop", step: 1, parents: {} } as CheckpointMetadata,
    })) {
      searchByStep.push(cp);
    }
    expect(searchByStep).toHaveLength(1);
    expect(searchByStep[0].checkpoint.id).toBe(checkpoint2.id);
    expect(searchByStep[0].metadata?.step).toBe(1);

    // Search by multiple fields
    const searchMultiple = [];
    for await (const cp of saver.list(null, {
      filter: { source: "loop", step: 1, parents: {} } as CheckpointMetadata,
    })) {
      searchMultiple.push(cp);
    }
    expect(searchMultiple).toHaveLength(1);
    expect(searchMultiple[0].checkpoint.id).toBe(checkpoint2.id);

    // Search with no matches
    const searchNoMatch = [];
    for await (const cp of saver.list(null, {
      filter: { source: "fork", step: 99, parents: {} } as CheckpointMetadata,
    })) {
      searchNoMatch.push(cp);
    }
    expect(searchNoMatch).toHaveLength(0);

    // Search with null value
    const searchNull = [];
    for await (const cp of saver.list(null, {
      filter: {
        source: "loop",
        step: 1,
        parents: {},
        score: null,
      } as CheckpointMetadata<{ score?: null }>,
    })) {
      searchNull.push(cp);
    }
    expect(searchNull).toHaveLength(1);
    expect(searchNull[0].checkpoint.id).toBe(checkpoint2.id);

    await saver.end();
  });

  it("should search checkpoints with limit and before", async () => {
    const saver = await RedisSaver.fromUrl(redisUrl);

    const config: RunnableConfig = {
      configurable: {
        thread_id: "limit-search-thread",
        checkpoint_ns: "",
      },
    };

    // Create multiple checkpoints with same metadata
    const checkpoints = [];
    for (let i = 0; i < 10; i++) {
      const cp = emptyCheckpoint();
      cp.id = uuid6(i);
      checkpoints.push(cp);

      await saver.put(
        config,
        cp,
        { source: "update", step: i % 3, parents: {} }, // Creates groups with same step
        {}
      );
    }

    // Search with limit
    const searchWithLimit = [];
    for await (const cp of saver.list(null, {
      filter: { source: "update", step: 0, parents: {} } as CheckpointMetadata,
      limit: 3,
    })) {
      searchWithLimit.push(cp);
    }
    expect(searchWithLimit).toHaveLength(3);

    // Search with specific step value (should get multiple results)
    const searchByStepVal = [];
    for await (const cp of saver.list(null, {
      filter: { source: "update", step: 0, parents: {} } as CheckpointMetadata,
    })) {
      searchByStepVal.push(cp);
    }
    expect(searchByStepVal.length).toBeGreaterThan(1);

    // Verify all results have the correct step
    searchByStepVal.forEach((result) => {
      expect(result.metadata?.step).toBe(0);
    });

    await saver.end();
  });

  it("should handle search with empty metadata", async () => {
    const saver = await RedisSaver.fromUrl(redisUrl);

    const config: RunnableConfig = {
      configurable: {
        thread_id: "empty-metadata-thread",
        checkpoint_ns: "test-ns",
      },
    };

    const checkpoint1 = emptyCheckpoint();
    checkpoint1.id = uuid6(0);

    const checkpoint2 = emptyCheckpoint();
    checkpoint2.id = uuid6(1);

    // Store one checkpoint with metadata and one without
    await saver.put(
      config,
      checkpoint1,
      { source: "input", step: 0, parents: {} },
      {}
    );
    await saver.put(
      config,
      checkpoint2,
      { source: "loop", step: 1, parents: {} },
      {}
    );

    // Search for all checkpoints in the thread should work
    const searchEmpty = [];
    for await (const cp of saver.list(config)) {
      searchEmpty.push(cp);
    }
    expect(searchEmpty).toHaveLength(2);

    // Search for specific field should only return matching
    const searchSpecific = [];
    for await (const cp of saver.list(config, {
      filter: { source: "input", step: 0, parents: {} } as CheckpointMetadata,
    })) {
      searchSpecific.push(cp);
    }
    expect(searchSpecific).toHaveLength(1);
    expect(searchSpecific[0].checkpoint.id).toBe(checkpoint1.id);

    await saver.end();
  });
});
