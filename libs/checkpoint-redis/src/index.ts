import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
} from "@langchain/langgraph-checkpoint";

import { createClient, createCluster } from "redis";

export type TRedisClient =
  | ReturnType<typeof createClient>
  | ReturnType<typeof createCluster>;
export type TCheckpointRedisOptions = {
  isCluster: boolean;
  prefix: string;
  ttl: number;
};
export type TThreadMessage = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Redis-backed checkpoint saver for LangGraph
 *
 * This class provides persistence for LangGraph checkpoints using Redis,
 * allowing for stateful conversations across sessions and service restarts.
 */
export class RedisSaver extends BaseCheckpointSaver {
  private readonly client: TRedisClient;

  private readonly options: TCheckpointRedisOptions;

  constructor(client: TRedisClient, options: TCheckpointRedisOptions) {
    // Initialize the base class
    super();
    // Set the client
    this.client = client;
    // Set the options
    this.options = options;
  }

  /**
   * Internal helper to create Redis keys for different data types
   *
   * Uses Redis hash tags to ensure that all keys for a specific thread
   * are stored in the same hash slot in a Redis Cluster environment.
   *
   * Hash tags are enclosed in {} and determine which part of the key is used
   * for hash slot calculation. Keys with the same hash tag will be stored
   * in the same slot.
   */
  private getKeys(threadId: string, checkpointNs = "") {
    const nsPath = checkpointNs ? `:ns:${checkpointNs}` : "";

    // In Redis Cluster, keys that share the same hash tag (the string inside {})
    // will be stored in the same hash slot
    const hashKey = `{${this.options.prefix}:thread:${threadId}${nsPath}}`;

    return {
      checkpoints: `${hashKey}:checkpoints`,
      checkpoint: (checkpointId: string) =>
        `${hashKey}:checkpoint:${checkpointId}`,
      channelValues: (checkpointId: string) =>
        `${hashKey}:values:${checkpointId}`,
      metadata: (checkpointId: string) => `${hashKey}:metadata:${checkpointId}`,
      pendingSends: (checkpointId: string) =>
        `${hashKey}:sends:${checkpointId}`,
      writes: (checkpointId: string, taskId: string) =>
        `${hashKey}:writes:${checkpointId}:${taskId}`,
    };
  }

  /**
   * Ensure Redis connection is active
   */
  private async ensureConnection(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  /**
   * Execute commands sequentially without using a transaction
   * For use with Redis Cluster when transactions are unsupported across slots
   */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private async executeCommands(
    commands: Array<() => Promise<any>>
  ): Promise<void> {
    for (const command of commands) {
      await command();
    }
  }

  /**
   * Get a checkpoint tuple from Redis
   *
   * This method retrieves a checkpoint tuple from Redis storage
   * based on the provided config. If the config contains a checkpoint_id,
   * that specific checkpoint is retrieved. Otherwise, the latest checkpoint
   * for the given thread_id is retrieved.
   */
  async getTuple(config: RunnableConfig): Promise<any> {
    await this.ensureConnection();

    // Extract thread ID and namespace from config
    const threadId = config.configurable?.thread_id as string;
    const checkpointNs = (config.configurable?.checkpoint_ns as string) || "";
    const checkpointId = config.configurable?.checkpoint_id as string;

    if (!threadId) {
      return undefined;
    }

    const keys = this.getKeys(threadId, checkpointNs);
    let targetCheckpointId = checkpointId;

    // If no specific checkpoint ID is provided, get the latest
    if (!targetCheckpointId) {
      const latestCheckpoint = await this.client.lIndex(keys.checkpoints, 0);
      if (!latestCheckpoint) {
        return undefined;
      }
      targetCheckpointId = latestCheckpoint;
    }

    // Retrieve the checkpoint data
    const checkpointKey = keys.checkpoint(targetCheckpointId);
    const checkpointData = await this.client.get(checkpointKey);

    if (!checkpointData) {
      return undefined;
    }

    // Parse checkpoint data
    const checkpoint = JSON.parse(checkpointData) as Checkpoint;

    // Retrieve channel values
    const channelValuesKey = keys.channelValues(targetCheckpointId);
    const serializedChannelValues = await this.client.hGetAll(channelValuesKey);

    // Deserialize channel values
    checkpoint.channel_values = checkpoint.channel_values || {};
    for (const [channel, serializedValue] of Object.entries(
      serializedChannelValues
    )) {
      try {
        // Get the type and value from the serialized JSON
        const { type, value } = JSON.parse(serializedValue as string);
        checkpoint.channel_values[channel] = await this.serde.loadsTyped(
          type,
          new Uint8Array(Buffer.from(value, "base64"))
        );
      } catch (error) {
        console.error(
          `Error deserializing channel value for ${channel}:`,
          error
        );
      }
    }

    // Retrieve metadata
    const metadataKey = keys.metadata(targetCheckpointId);
    const metadataStr = await this.client.get(metadataKey);
    const metadata = metadataStr ? JSON.parse(metadataStr) : {};

    // Retrieve pending sends
    const pendingSendsKey = keys.pendingSends(targetCheckpointId);
    const pendingSendsData = await this.client.lRange(pendingSendsKey, 0, -1);
    checkpoint.pending_sends = await Promise.all(
      pendingSendsData.map(async (send: any) => {
        const { type, value } = JSON.parse(send);
        return this.serde.loadsTyped(
          type,
          new Uint8Array(Buffer.from(value, "base64"))
        );
      })
    );

    // Create a new config with the checkpoint ID
    const newConfig: RunnableConfig = {
      ...config,
      configurable: {
        ...config.configurable,
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: targetCheckpointId,
      },
    };

    // Return the checkpoint tuple
    return {
      config: newConfig,
      checkpoint,
      metadata,
      parentConfig: config.configurable?.checkpoint_id ? config : undefined,
    };
  }

  /**
   * List checkpoints from Redis
   *
   * This method retrieves a list of checkpoint tuples from Redis
   * based on the provided config and options.
   */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  async *list(config: RunnableConfig, options: any = {}): AsyncGenerator<any> {
    await this.ensureConnection();

    const threadId = config.configurable?.thread_id as string;
    const checkpointNs = (config.configurable?.checkpoint_ns as string) || "";

    if (!threadId) {
      return;
    }

    const keys = this.getKeys(threadId, checkpointNs);
    const { limit = 10, before } = options;

    // Get all checkpoint IDs for the thread
    const allCheckpointIds = await this.client.lRange(keys.checkpoints, 0, -1);

    // Apply filtering by 'before' parameter
    let filteredCheckpointIds = allCheckpointIds;
    if (before?.configurable?.checkpoint_id) {
      const beforeId = before.configurable.checkpoint_id as string;
      const beforeIndex = allCheckpointIds.indexOf(beforeId);
      if (beforeIndex !== -1) {
        filteredCheckpointIds = allCheckpointIds.slice(beforeIndex + 1);
      }
    }

    // Apply limit
    const limitedCheckpointIds = filteredCheckpointIds.slice(0, limit);

    // Apply filter if specified
    if (options.filter) {
      for (const checkpointId of limitedCheckpointIds) {
        const metadataKey = keys.metadata(checkpointId);
        const metadataStr = await this.client.get(metadataKey);
        if (!metadataStr) continue;

        const metadata = JSON.parse(metadataStr);
        let matches = true;

        // Check if metadata matches all filter criteria
        for (const [key, value] of Object.entries(options.filter)) {
          if (metadata[key] !== value) {
            matches = false;
            break;
          }
        }

        if (matches) {
          const checkpointConfig: RunnableConfig = {
            ...config,
            configurable: {
              ...config.configurable,
              checkpoint_id: checkpointId,
            },
          };

          const tuple = await this.getTuple(checkpointConfig);
          if (tuple) {
            yield tuple;
          }
        }
      }
    } else {
      // No filter, yield all matching checkpoints
      for (const checkpointId of limitedCheckpointIds) {
        const checkpointConfig: RunnableConfig = {
          ...config,
          configurable: {
            ...config.configurable,
            checkpoint_id: checkpointId,
          },
        };

        const tuple = await this.getTuple(checkpointConfig);
        if (tuple) {
          yield tuple;
        }
      }
    }
  }

  /**
   * Store a checkpoint in Redis
   *
   * This method saves a checkpoint to Redis storage with its associated
   * metadata, channel values, and configurations.
   */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: any
  ): Promise<RunnableConfig> {
    await this.ensureConnection();

    const threadId = config.configurable?.thread_id as string;
    const checkpointNs = (config.configurable?.checkpoint_ns as string) || "";

    if (!threadId) {
      throw new Error("Thread ID is required");
    }

    const checkpointId = checkpoint.id;
    const keys = this.getKeys(threadId, checkpointNs);

    // Store the checkpoint data (without channel values and pending sends)
    const checkpointCopy = { ...checkpoint };
    const channelValues = { ...checkpointCopy.channel_values };
    const pendingSends = [...checkpointCopy.pending_sends];

    // Remove values that will be stored separately
    checkpointCopy.channel_values = {};
    checkpointCopy.pending_sends = [];

    const checkpointKey = keys.checkpoint(checkpointId);
    const channelValuesKey = keys.channelValues(checkpointId);
    const metadataKey = keys.metadata(checkpointId);
    const pendingSendsKey = keys.pendingSends(checkpointId);

    if (this.options.isCluster) {
      // Use individual commands for Redis Cluster
      const commands: Array<() => Promise<any>> = [];

      // Store checkpoint
      commands.push(() =>
        this.client.set(checkpointKey, JSON.stringify(checkpointCopy))
      );

      // Store channel values
      for (const [channel, value] of Object.entries(channelValues)) {
        if (value !== undefined) {
          commands.push(async () => {
            try {
              const [type, serializedValue] = this.serde.dumpsTyped(value);
              await this.client.hSet(
                channelValuesKey,
                channel,
                JSON.stringify({
                  type,
                  value: Buffer.from(serializedValue).toString("base64"),
                })
              );
            } catch (error) {
              console.error(
                `Error serializing channel value for ${channel}:`,
                error
              );
            }
          });
        }
      }

      // Store metadata
      commands.push(() =>
        this.client.set(metadataKey, JSON.stringify(metadata))
      );

      // Store pending sends
      for (const send of pendingSends) {
        commands.push(async () => {
          try {
            const [type, serializedValue] = this.serde.dumpsTyped(send);
            await this.client.rPush(
              pendingSendsKey,
              JSON.stringify({
                type,
                value: Buffer.from(serializedValue).toString("base64"),
              })
            );
          } catch (error) {
            console.error("Error serializing pending send:", error);
          }
        });
      }

      // Add checkpoint ID to the list of checkpoints
      commands.push(() => this.client.lPush(keys.checkpoints, checkpointId));

      // Apply TTL if configured
      if (this.options.ttl > 0) {
        commands.push(() =>
          this.client.expire(checkpointKey, this.options.ttl)
        );
        commands.push(() =>
          this.client.expire(channelValuesKey, this.options.ttl)
        );
        commands.push(() => this.client.expire(metadataKey, this.options.ttl));
        commands.push(() =>
          this.client.expire(pendingSendsKey, this.options.ttl)
        );
        commands.push(() =>
          this.client.expire(keys.checkpoints, this.options.ttl)
        );
      }

      // Execute commands sequentially
      await this.executeCommands(commands);
    } else {
      // Use transactions for a single Redis instance
      const multi = this.client.multi();

      // Store checkpoint
      multi.set(checkpointKey, JSON.stringify(checkpointCopy));

      // Store channel values
      for (const [channel, value] of Object.entries(channelValues)) {
        if (value !== undefined) {
          try {
            const [type, serializedValue] = this.serde.dumpsTyped(value);
            multi.hSet(
              channelValuesKey,
              channel,
              JSON.stringify({
                type,
                value: Buffer.from(serializedValue).toString("base64"),
              })
            );
          } catch (error) {
            console.error(
              `Error serializing channel value for ${channel}:`,
              error
            );
          }
        }
      }

      // Store metadata
      multi.set(metadataKey, JSON.stringify(metadata));

      // Store pending sends
      for (const send of pendingSends) {
        try {
          const [type, serializedValue] = this.serde.dumpsTyped(send);
          multi.rPush(
            pendingSendsKey,
            JSON.stringify({
              type,
              value: Buffer.from(serializedValue).toString("base64"),
            })
          );
        } catch (error) {
          console.error("Error serializing pending send:", error);
        }
      }

      // Add checkpoint ID to the list of checkpoints
      multi.lPush(keys.checkpoints, checkpointId);

      // Apply TTL if configured
      if (this.options.ttl > 0) {
        multi.expire(checkpointKey, this.options.ttl);
        multi.expire(channelValuesKey, this.options.ttl);
        multi.expire(metadataKey, this.options.ttl);
        multi.expire(pendingSendsKey, this.options.ttl);
        multi.expire(keys.checkpoints, this.options.ttl);
      }

      // Execute the transaction
      await multi.exec();
    }

    // Return the updated config with the new checkpoint ID
    return {
      ...config,
      configurable: {
        ...config.configurable,
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
      },
    };
  }

  /**
   * Store intermediate writes linked to a checkpoint
   *
   * This method saves intermediate writes associated with a checkpoint to Redis.
   */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  async putWrites(
    config: RunnableConfig,
    writes: any[],
    taskId: string
  ): Promise<void> {
    await this.ensureConnection();

    const threadId = config.configurable?.thread_id as string;
    const checkpointNs = (config.configurable?.checkpoint_ns as string) || "";
    const checkpointId = config.configurable?.checkpoint_id as string;

    if (!threadId || !checkpointId) {
      throw new Error("Thread ID and checkpoint ID are required");
    }

    if (writes.length === 0) {
      return;
    }

    const keys = this.getKeys(threadId, checkpointNs);
    const writesKey = keys.writes(checkpointId, taskId);

    if (this.options.isCluster) {
      // Use individual commands for Redis Cluster
      const commands: Array<() => Promise<any>> = [];

      // Store each write
      for (let i = 0; i < writes.length; i += 1) {
        const write = writes[i];
        // Use negative index for special writes with errors
        const index = write.error ? -1 * (i + 1) : i;

        commands.push(async () => {
          try {
            const [type, serializedValue] = this.serde.dumpsTyped(write.value);
            const writeData = {
              index,
              runId: write.runId,
              parentRunId: write.parentRunId,
              channel: write.runId,
              type,
              value: Buffer.from(serializedValue).toString("base64"),
              error: write.error,
            };

            await this.client.hSet(
              writesKey,
              index.toString(),
              JSON.stringify(writeData)
            );
          } catch (error) {
            console.error(`Error serializing write at index ${i}:`, error);
          }
        });
      }

      // Apply TTL if configured
      if (this.options.ttl > 0) {
        commands.push(() => this.client.expire(writesKey, this.options.ttl));
      }

      // Execute commands sequentially
      await this.executeCommands(commands);
    } else {
      // Use transactions for a single Redis instance
      const multi = this.client.multi();

      // Store each write
      for (let i = 0; i < writes.length; i += 1) {
        const write = writes[i];
        // Use negative index for special writes with errors
        const index = write.error ? -1 * (i + 1) : i;

        try {
          const [type, serializedValue] = this.serde.dumpsTyped(write.value);
          const writeData = {
            index,
            runId: write.runId,
            parentRunId: write.parentRunId,
            channel: write.runId,
            type,
            value: Buffer.from(serializedValue).toString("base64"),
            error: write.error,
          };

          multi.hSet(writesKey, index.toString(), JSON.stringify(writeData));
        } catch (error) {
          console.error(`Error serializing write at index ${i}:`, error);
        }
      }

      // Apply TTL if configured
      if (this.options.ttl > 0) {
        multi.expire(writesKey, this.options.ttl);
      }

      // Execute the transaction
      await multi.exec();
    }
  }

  /**
   * Clear all checkpoints for a given thread
   *
   * This method deletes all checkpoints for a given thread from Redis.
   */
  async clear(threadId: string) {
    await this.ensureConnection();

    // Get all checkpoint IDs for the thread
    const keys = this.getKeys(threadId);

    // First get all checkpoint IDs in the thread
    const checkpointIds = await this.client.lRange(keys.checkpoints, 0, -1);

    if (checkpointIds.length > 0) {
      if (this.options.isCluster) {
        // Use individual commands for Redis Cluster
        const commands: Array<() => Promise<any>> = [];

        // For each checkpoint, delete all associated data
        for (const checkpointId of checkpointIds) {
          commands.push(() => this.client.del(keys.checkpoint(checkpointId)));
          commands.push(() =>
            this.client.del(keys.channelValues(checkpointId))
          );
          commands.push(() => this.client.del(keys.metadata(checkpointId)));
          commands.push(() => this.client.del(keys.pendingSends(checkpointId)));
          // Note: We can't delete writes keys easily without task IDs
        }

        // Delete the main checkpoints list
        commands.push(() => this.client.del(keys.checkpoints));

        // Execute commands sequentially
        await this.executeCommands(commands);
      } else {
        // Use transactions for a single Redis instance
        const multi = this.client.multi();

        // For each checkpoint, delete all associated data
        for (const checkpointId of checkpointIds) {
          multi.del(keys.checkpoint(checkpointId));
          multi.del(keys.channelValues(checkpointId));
          multi.del(keys.metadata(checkpointId));
          multi.del(keys.pendingSends(checkpointId));
          // Note: We can't delete writes keys easily without task IDs
        }

        // Delete the main checkpoints list
        multi.del(keys.checkpoints);

        // Execute all deletion commands in a batch
        await multi.exec();
      }
    }
  }

  /**
   * Read a checkpoint from Redis
   *
   * This method reads a checkpoint from Redis storage based on the provided thread ID
   */
  async read(threadId: string): Promise<TThreadMessage[]> {
    await this.ensureConnection();

    // First try with the exact thread ID
    const keys = this.getKeys(threadId);
    let checkpointIds = await this.client.lRange(keys.checkpoints, 0, -1);

    // If no results, check if threadId might be a UUID that's part of a longer key
    if (checkpointIds.length === 0 && threadId.includes("-")) {
      // Try to create a key pattern that includes the UUID part of a course thread
      // Using the prefix to construct a valid key
      const threadKeyBase = `${this.options.prefix}:thread:${threadId}`;

      // Use a multi command to check all values
      const multi = this.client.multi();

      // First, try to get values directly with just the UUID
      multi.lRange(`${threadKeyBase}:checkpoints`, 0, -1);

      // Then try the same pattern with course info suffix (similar to Redis screenshot)
      multi.lRange(`${threadKeyBase}:*:checkpoints`, 0, -1);

      // Execute all commands
      const results = await multi.exec();

      // Process results from the multi command
      // Find first non-empty result
      for (const result of results) {
        if (Array.isArray(result) && result.length > 0) {
          checkpointIds = result.map((id) => id?.toString() || "");
          break;
        }
      }

      // If still no results, return empty
      if (checkpointIds.length === 0) {
        return [];
      }
    }

    // Messages will be stored in reverse chronological order in Redis
    // We'll process them in chronological order
    const messages: TThreadMessage[] = [];

    // Process only the latest checkpoint
    const checkpointId = checkpointIds[0];
    if (checkpointId) {
      // Create a config for getTuple
      const config: RunnableConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_id: checkpointId,
        },
      };

      // Get the checkpoint tuple
      const tuple = await this.getTuple(config);

      if (tuple && tuple.checkpoint && tuple.checkpoint.channel_values) {
        // Extract messages from channel values
        const channelValues = tuple.checkpoint.channel_values;

        /* eslint-disable @typescript-eslint/no-unused-vars */
        for (const [_, value] of Object.entries(channelValues)) {
          // Skip non-message channels or undefined values
          if (!value || !Array.isArray(value)) continue;
          // Extract message data based on the expected structure
          for (const message of value) {
            if (
              (message instanceof HumanMessage ||
                message instanceof AIMessage) &&
              message.content
            ) {
              messages.push({
                role: message instanceof HumanMessage ? "user" : "assistant",
                content: message.content as string,
              });
            }
          }
        }
      }
    }

    // Return the formatted messages
    return messages;
  }
}
