import { GenericContainer, Wait } from "testcontainers";
import type { RedisClientType } from "redis";
import { createClient } from "redis";

/**
 * Creates a new isolated Redis container for a test.
 * Each test gets its own container to ensure complete isolation.
 * This follows TestContainers best practices for test isolation.
 */
export async function createRedisContainer(): Promise<{
  client: RedisClientType;
  url: string;
  cleanup: () => Promise<void>;
}> {
  // Use redis:8 which includes RedisJSON and RediSearch modules
  const container = await new GenericContainer("redis:8")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .withStartupTimeout(120000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(6379);
  const url = `redis://${host}:${port}`;

  const client = createClient({ url }) as RedisClientType;

  // Connect with retry logic
  let connected = false;
  let retries = 0;
  const maxRetries = 5;

  while (!connected && retries < maxRetries) {
    try {
      await client.connect();
      connected = true;
    } catch (error) {
      retries++;
      if (retries >= maxRetries) {
        throw error;
      }
      // Exponential backoff: 100ms, 200ms, 400ms, 800ms
      await new Promise((resolve) =>
        setTimeout(resolve, 100 * Math.pow(2, retries - 1))
      );
    }
  }

  return {
    client,
    url,
    cleanup: async () => {
      try {
        // Disconnect the client first
        if (client.isOpen) {
          await client.disconnect();
        }
      } catch (error) {
        // Client might already be closed
      }

      try {
        // Stop the container with a timeout
        await Promise.race([
          container.stop({ timeout: 10000 }), // 10 second timeout
          new Promise((resolve) => setTimeout(resolve, 10000)),
        ]);
      } catch (error) {
        // Container might already be stopped or error during cleanup
        console.error("Error stopping container:", error);
      }
    },
  };
}
