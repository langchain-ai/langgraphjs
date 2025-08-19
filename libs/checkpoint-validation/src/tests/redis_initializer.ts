/* eslint-disable import/no-extraneous-dependencies */
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { createClient } from "redis";

import type { CheckpointerTestInitializer } from "../types.js";

// Use Redis 8 which includes all required modules (RedisJSON, RediSearch)
const container = new GenericContainer("redis:8").withExposedPorts(6379);

let startedContainer: StartedTestContainer;

export const initializer: CheckpointerTestInitializer<RedisSaver> = {
  checkpointerName: "@langchain/langgraph-checkpoint-redis",

  async beforeAll() {
    startedContainer = await container.start();
  },

  beforeAllTimeout: 300_000, // five minutes, to pull docker container

  async createCheckpointer() {
    const redisUrl = `redis://${startedContainer.getHost()}:${startedContainer.getMappedPort(
      6379
    )}`;

    // Create a Redis client to flush the database for clean state
    const client = createClient({ url: redisUrl });
    await client.connect();
    await client.flushDb();
    await client.quit();

    // Create and return a fresh checkpointer
    const checkpointer = await RedisSaver.fromUrl(redisUrl);
    return checkpointer;
  },

  async destroyCheckpointer(checkpointer: RedisSaver) {
    // Clean up the Redis connection
    await checkpointer.end();
  },

  async afterAll() {
    await startedContainer.stop();
  },
};

export default initializer;
