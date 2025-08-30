import {
  BaseCheckpointSaver,
  ChannelVersions,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import { createClient } from "redis";

export interface TTLConfig {
  defaultTTL?: number; // TTL in minutes
  refreshOnRead?: boolean; // Whether to refresh TTL when reading
}

// Helper function for deterministic object comparison
function deterministicStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return JSON.stringify(obj.map((item) => deterministicStringify(item)));
  }
  const sortedObj: Record<string, any> = {};
  const sortedKeys = Object.keys(obj).sort();
  for (const key of sortedKeys) {
    sortedObj[key] = obj[key];
  }
  return JSON.stringify(sortedObj, (_, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, any> = {};
      const keys = Object.keys(value).sort();
      for (const k of keys) {
        sorted[k] = value[k];
      }
      return sorted;
    }
    return value;
  });
}

const SCHEMAS = [
  {
    index: "checkpoints",
    prefix: "checkpoint:",
    schema: {
      "$.thread_id": { type: "TAG", AS: "thread_id" },
      "$.checkpoint_ns": { type: "TAG", AS: "checkpoint_ns" },
      "$.checkpoint_id": { type: "TAG", AS: "checkpoint_id" },
      "$.parent_checkpoint_id": { type: "TAG", AS: "parent_checkpoint_id" },
      "$.checkpoint_ts": { type: "NUMERIC", AS: "checkpoint_ts" },
      "$.has_writes": { type: "TAG", AS: "has_writes" },
      "$.source": { type: "TAG", AS: "source" },
      "$.step": { type: "NUMERIC", AS: "step" },
    },
  },
  {
    index: "checkpoint_writes",
    prefix: "checkpoint_write:",
    schema: {
      "$.thread_id": { type: "TAG", AS: "thread_id" },
      "$.checkpoint_ns": { type: "TAG", AS: "checkpoint_ns" },
      "$.checkpoint_id": { type: "TAG", AS: "checkpoint_id" },
      "$.task_id": { type: "TAG", AS: "task_id" },
      "$.idx": { type: "NUMERIC", AS: "idx" },
      "$.channel": { type: "TAG", AS: "channel" },
      "$.type": { type: "TAG", AS: "type" },
    },
  },
];

/**
 * ShallowRedisSaver - A Redis checkpoint saver that only keeps the latest checkpoint per thread.
 *
 * This is a memory-optimized variant that:
 * - Only stores the most recent checkpoint for each thread
 * - Stores channel values inline (no separate blob storage)
 * - Automatically cleans up old checkpoints and writes when new ones are added
 * - Reduces storage usage for applications that don't need checkpoint history
 */
export class ShallowRedisSaver extends BaseCheckpointSaver {
  private client: any;
  private ttlConfig?: TTLConfig;

  constructor(client: any, ttlConfig?: TTLConfig) {
    super();
    this.client = client;
    this.ttlConfig = ttlConfig;
  }

  static async fromUrl(
    url: string,
    ttlConfig?: TTLConfig
  ): Promise<ShallowRedisSaver> {
    const client = createClient({ url });
    await client.connect();
    const saver = new ShallowRedisSaver(client, ttlConfig);
    await saver.ensureIndexes();
    return saver;
  }

  async get(config: RunnableConfig): Promise<Checkpoint | undefined> {
    const tuple = await this.getTuple(config);
    return tuple?.checkpoint;
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    await this.ensureIndexes();

    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const parentCheckpointId = config.configurable?.checkpoint_id;

    if (!threadId) {
      throw new Error("thread_id is required");
    }

    const checkpointId = checkpoint.id || uuid6(0);

    // In shallow mode, we use a single key per thread (no checkpoint_id in key)
    const key = `checkpoint:${threadId}:${checkpointNs}:shallow`;

    // Get the previous checkpoint to know what to clean up
    let prevCheckpointData: any = null;
    let prevCheckpointId: string | null = null;
    try {
      prevCheckpointData = await this.client.json.get(key);
      if (prevCheckpointData && typeof prevCheckpointData === "object") {
        prevCheckpointId = prevCheckpointData.checkpoint_id;
      }
    } catch (error) {
      // Key doesn't exist yet, that's fine
    }

    // Clean up old checkpoint and related data if it exists
    if (prevCheckpointId && prevCheckpointId !== checkpointId) {
      await this.cleanupOldCheckpoint(threadId, checkpointNs, prevCheckpointId);
    }

    // Store channel values inline - no blob storage in shallow mode
    const checkpointCopy = {
      ...checkpoint,
      channel_values: checkpoint.channel_values || {},
      // Remove channel_blobs if present
      channel_blobs: undefined,
    };

    // Structure matching Python implementation
    const jsonDoc: any = {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
      checkpoint_id: checkpointId,
      parent_checkpoint_id: parentCheckpointId || null,
      checkpoint: checkpointCopy,
      metadata: this.sanitizeMetadata(metadata),
      checkpoint_ts: Date.now(),
      has_writes: "false",
    };

    // Store metadata fields at top-level for searching
    this.addSearchableMetadataFields(jsonDoc, metadata);

    // Use Redis JSON commands
    await this.client.json.set(key, "$", jsonDoc);

    // Apply TTL if configured
    if (this.ttlConfig?.defaultTTL) {
      await this.applyTTL(key);
    }

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
      },
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;

    if (!threadId) {
      return undefined;
    }

    // In shallow mode, we use a single key per thread
    const key = `checkpoint:${threadId}:${checkpointNs}:shallow`;
    const jsonDoc = await this.client.json.get(key);

    if (!jsonDoc) {
      return undefined;
    }

    // If a specific checkpoint_id was requested, check if it matches
    if (checkpointId && jsonDoc.checkpoint_id !== checkpointId) {
      return undefined;
    }

    // Refresh TTL if configured
    if (this.ttlConfig?.refreshOnRead && this.ttlConfig?.defaultTTL) {
      await this.applyTTL(key);
    }

    // Channel values are stored inline in shallow mode
    const checkpoint = {
      ...jsonDoc.checkpoint,
      channel_values: jsonDoc.checkpoint.channel_values || {},
    };

    // Load pending writes if they exist
    let pendingWrites: Array<[string, string, any]> | undefined;
    if (jsonDoc.has_writes === "true") {
      pendingWrites = await this.loadPendingWrites(
        jsonDoc.thread_id,
        jsonDoc.checkpoint_ns,
        jsonDoc.checkpoint_id
      );
    }

    return this.createCheckpointTuple(jsonDoc, checkpoint, pendingWrites);
  }

  async *list(
    config: RunnableConfig | null,
    options?: CheckpointListOptions & { filter?: CheckpointMetadata }
  ): AsyncGenerator<CheckpointTuple> {
    await this.ensureIndexes();

    // In shallow mode, we only return the latest checkpoint per thread
    if (config?.configurable?.thread_id) {
      // Single thread case
      const tuple = await this.getTuple(config);
      if (tuple) {
        // Apply filter if provided
        if (options?.filter) {
          if (this.checkMetadataFilterMatch(tuple.metadata, options.filter)) {
            yield tuple;
          }
        } else {
          yield tuple;
        }
      }
    } else {
      // All threads case - use search
      const queryParts: string[] = [];

      // Add metadata filters
      if (options?.filter) {
        for (const [key, value] of Object.entries(options.filter)) {
          if (value === undefined) {
            // Skip undefined filters
          } else if (value === null) {
            // Skip null values for RediSearch query, will handle in post-processing
          } else if (typeof value === "string") {
            queryParts.push(`(@${key}:{${value}})`);
          } else if (typeof value === "number") {
            queryParts.push(`(@${key}:[${value} ${value}])`);
          }
        }
      }

      if (queryParts.length === 0) {
        queryParts.push("*");
      }

      const query = queryParts.join(" ");
      const limit = options?.limit ?? 10;

      try {
        const results = await this.client.ft.search("checkpoints", query, {
          LIMIT: { from: 0, size: limit * 2 }, // Get more since we'll deduplicate
          SORTBY: { BY: "checkpoint_ts", DIRECTION: "DESC" },
        });

        // In shallow mode, deduplicate by thread_id
        const seenThreads = new Set<string>();
        let yieldCount = 0;

        for (const doc of results.documents) {
          if (yieldCount >= limit) break;

          const jsonDoc = doc.value;
          const threadKey = `${jsonDoc.thread_id}:${jsonDoc.checkpoint_ns}`;

          // Skip if we've already seen this thread
          if (seenThreads.has(threadKey)) {
            continue;
          }
          seenThreads.add(threadKey);

          // Check null filters manually if needed
          if (options?.filter) {
            if (
              !this.checkMetadataFilterMatch(jsonDoc.metadata, options.filter)
            ) {
              continue;
            }
          }

          // Channel values are inline in shallow mode
          const checkpoint = {
            ...jsonDoc.checkpoint,
            channel_values: jsonDoc.checkpoint.channel_values || {},
          };

          yield this.createCheckpointTuple(jsonDoc, checkpoint);
          yieldCount++;
        }
      } catch (error: any) {
        if (error.message?.includes("no such index")) {
          // Index doesn't exist yet, fall back to scanning all shallow checkpoints
          const pattern = `checkpoint:*:*:shallow`;
          const keys = await this.client.keys(pattern);

          if (keys.length === 0) {
            return;
          }

          // Sort keys to have consistent ordering
          keys.sort().reverse();

          // Get unique threads
          const seenThreads = new Set<string>();
          let yieldCount = 0;
          const limit = options?.limit ?? 10;

          for (const key of keys) {
            if (yieldCount >= limit) break;

            const jsonDoc = await this.client.json.get(key);
            if (!jsonDoc) continue;

            const threadKey = `${jsonDoc.thread_id}:${jsonDoc.checkpoint_ns}`;

            // Skip if we've already seen this thread
            if (seenThreads.has(threadKey)) {
              continue;
            }
            seenThreads.add(threadKey);

            // Check filter if provided
            if (options?.filter) {
              if (
                !this.checkMetadataFilterMatch(jsonDoc.metadata, options.filter)
              ) {
                continue;
              }
            }

            // Channel values are inline in shallow mode
            const checkpoint = {
              ...jsonDoc.checkpoint,
              channel_values: jsonDoc.checkpoint.channel_values || {},
            };

            yield this.createCheckpointTuple(jsonDoc, checkpoint);
            yieldCount++;
          }
          return;
        }
        throw error;
      }
    }
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    await this.ensureIndexes();

    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;

    if (!threadId || !checkpointId) {
      throw new Error("thread_id and checkpoint_id are required");
    }

    // In shallow mode, we overwrite all writes for the task
    // First, clean up old writes for this task
    const writePattern = `checkpoint_write:${threadId}:${checkpointNs}:${checkpointId}:${taskId}:*`;
    const oldWriteKeys = await this.client.keys(writePattern);
    if (oldWriteKeys.length > 0) {
      await this.client.del(oldWriteKeys);
    }

    // Store new writes
    const writeKeys: string[] = [];
    for (let idx = 0; idx < writes.length; idx++) {
      const [channel, value] = writes[idx];
      const writeKey = `checkpoint_write:${threadId}:${checkpointNs}:${checkpointId}:${taskId}:${idx}`;
      writeKeys.push(writeKey);

      const writeDoc = {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
        task_id: taskId,
        idx: idx,
        channel: channel,
        type: typeof value === "object" ? "json" : "string",
        value: value,
      };

      await this.client.json.set(writeKey, "$", writeDoc);
    }

    // Register write keys in sorted set for efficient retrieval
    if (writeKeys.length > 0) {
      const zsetKey = `write_keys_zset:${threadId}:${checkpointNs}:${checkpointId}`;

      // Clear existing entries for this task and add new ones
      const zaddArgs: Record<string, number> = {};
      writeKeys.forEach((key, idx) => {
        zaddArgs[key] = idx;
      });
      await this.client.zAdd(
        zsetKey,
        Object.entries(zaddArgs).map(([key, score]) => ({ score, value: key }))
      );

      // Apply TTL to write keys and zset if configured
      if (this.ttlConfig?.defaultTTL) {
        await this.applyTTL(...writeKeys, zsetKey);
      }
    }

    // Update checkpoint to indicate it has writes
    const checkpointKey = `checkpoint:${threadId}:${checkpointNs}:shallow`;
    const checkpointExists = await this.client.exists(checkpointKey);
    if (checkpointExists) {
      const currentDoc = await this.client.json.get(checkpointKey);
      if (currentDoc) {
        currentDoc.has_writes = "true";
        await this.client.json.set(checkpointKey, "$", currentDoc);
      }
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    // Delete shallow checkpoints
    const checkpointPattern = `checkpoint:${threadId}:*:shallow`;
    const checkpointKeys = await this.client.keys(checkpointPattern);

    if (checkpointKeys.length > 0) {
      await this.client.del(checkpointKeys);
    }

    // Delete writes
    const writesPattern = `checkpoint_write:${threadId}:*`;
    const writesKeys = await this.client.keys(writesPattern);

    if (writesKeys.length > 0) {
      await this.client.del(writesKeys);
    }

    // Delete write registries
    const zsetPattern = `write_keys_zset:${threadId}:*`;
    const zsetKeys = await this.client.keys(zsetPattern);

    if (zsetKeys.length > 0) {
      await this.client.del(zsetKeys);
    }
  }

  async end(): Promise<void> {
    await this.client.quit();
  }

  // Helper method to add searchable metadata fields
  private addSearchableMetadataFields(
    jsonDoc: any,
    metadata?: CheckpointMetadata
  ): void {
    if (!metadata) return;

    // Add common searchable fields at top level
    if ("source" in metadata) {
      jsonDoc.source = metadata.source;
    }
    if ("step" in metadata) {
      jsonDoc.step = metadata.step;
    }
    if ("writes" in metadata) {
      // Writes field needs to be JSON stringified for TAG search
      jsonDoc.writes =
        typeof metadata.writes === "object"
          ? JSON.stringify(metadata.writes)
          : metadata.writes;
    }
    if ("score" in metadata) {
      jsonDoc.score = metadata.score;
    }
  }

  // Helper method to create checkpoint tuple from json document
  private createCheckpointTuple(
    jsonDoc: any,
    checkpoint: Checkpoint,
    pendingWrites?: Array<[string, string, any]>
  ): CheckpointTuple {
    return {
      config: {
        configurable: {
          thread_id: jsonDoc.thread_id,
          checkpoint_ns: jsonDoc.checkpoint_ns,
          checkpoint_id: jsonDoc.checkpoint_id,
        },
      },
      checkpoint,
      metadata: jsonDoc.metadata,
      parentConfig: jsonDoc.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: jsonDoc.thread_id,
              checkpoint_ns: jsonDoc.checkpoint_ns,
              checkpoint_id: jsonDoc.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  // Helper method to apply TTL to keys
  private async applyTTL(...keys: string[]): Promise<void> {
    if (!this.ttlConfig?.defaultTTL) return;

    const ttlSeconds = Math.floor(this.ttlConfig.defaultTTL * 60);
    const results = await Promise.allSettled(
      keys.map((key) => this.client.expire(key, ttlSeconds))
    );

    // Log any failures but don't throw - TTL is best effort
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.warn(
          `Failed to set TTL for key ${keys[i]}:`,
          (results[i] as PromiseRejectedResult).reason
        );
      }
    }
  }

  // Helper method to load pending writes
  private async loadPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<Array<[string, string, any]> | undefined> {
    const zsetKey = `write_keys_zset:${threadId}:${checkpointNs}:${checkpointId}`;
    const writeKeys = await this.client.zRange(zsetKey, 0, -1);

    if (writeKeys.length === 0) {
      return undefined;
    }

    const pendingWrites: Array<[string, string, any]> = [];
    for (const writeKey of writeKeys) {
      const writeDoc = await this.client.json.get(writeKey);
      if (writeDoc) {
        pendingWrites.push([
          writeDoc.task_id,
          writeDoc.channel,
          writeDoc.value,
        ]);
      }
    }

    return pendingWrites;
  }

  // Helper method to check metadata filter matches
  private checkMetadataFilterMatch(
    metadata: any,
    filter: CheckpointMetadata
  ): boolean {
    for (const [key, value] of Object.entries(filter)) {
      const metadataValue = metadata?.[key];
      if (value === null) {
        if (!(key in (metadata || {})) || metadataValue !== null) {
          return false;
        }
      } else if (typeof value === "object" && !Array.isArray(value)) {
        // Deep comparison for objects with deterministic key ordering
        if (typeof metadataValue !== "object" || metadataValue === null) {
          return false;
        }
        if (
          deterministicStringify(value) !==
          deterministicStringify(metadataValue)
        ) {
          return false;
        }
      } else if (metadataValue !== value) {
        return false;
      }
    }
    return true;
  }

  private async cleanupOldCheckpoint(
    threadId: string,
    checkpointNs: string,
    oldCheckpointId: string
  ): Promise<void> {
    // Clean up old writes
    const writePattern = `checkpoint_write:${threadId}:${checkpointNs}:${oldCheckpointId}:*`;
    const oldWriteKeys = await this.client.keys(writePattern);
    if (oldWriteKeys.length > 0) {
      await this.client.del(oldWriteKeys);
    }

    // Clean up write registry
    const zsetKey = `write_keys_zset:${threadId}:${checkpointNs}:${oldCheckpointId}`;
    await this.client.del(zsetKey);

    // Note: We don't clean up blob keys in shallow mode since we store inline
    // But for completeness, clean up any legacy blob keys if they exist
    const blobPattern = `checkpoint_blob:${threadId}:${checkpointNs}:${oldCheckpointId}:*`;
    const oldBlobKeys = await this.client.keys(blobPattern);
    if (oldBlobKeys.length > 0) {
      await this.client.del(oldBlobKeys);
    }
  }

  private sanitizeMetadata(metadata: CheckpointMetadata): CheckpointMetadata {
    if (!metadata) return {} as CheckpointMetadata;

    const sanitized: any = {};
    for (const [key, value] of Object.entries(metadata)) {
      // Remove null characters from keys and string values
      // eslint-disable-next-line no-control-regex
      const sanitizedKey = key.replace(/\x00/g, "");
      sanitized[sanitizedKey] =
        // eslint-disable-next-line no-control-regex
        typeof value === "string" ? value.replace(/\x00/g, "") : value;
    }
    return sanitized as CheckpointMetadata;
  }

  private async ensureIndexes(): Promise<void> {
    for (const schema of SCHEMAS) {
      try {
        // Try to create the index
        await this.client.ft.create(schema.index, schema.schema, {
          ON: "JSON",
          PREFIX: schema.prefix,
        });
      } catch (error: any) {
        // Ignore if index already exists
        if (!error.message?.includes("Index already exists")) {
          console.error(
            `Failed to create index ${schema.index}:`,
            error.message
          );
        }
      }
    }
  }
}
