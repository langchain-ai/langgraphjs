import {
  BaseCheckpointSaver,
  ChannelVersions,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
  uuid6,
  TASKS,
  maxChannelVersion,
  copyCheckpoint,
} from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import { createClient, createCluster } from "redis";

// Type for Redis client - supports both standalone and cluster
export type RedisClientType =
  | ReturnType<typeof createClient>
  | ReturnType<typeof createCluster>;

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
    index: "checkpoint_blobs",
    prefix: "checkpoint_blob:",
    schema: {
      "$.thread_id": { type: "TAG", AS: "thread_id" },
      "$.checkpoint_ns": { type: "TAG", AS: "checkpoint_ns" },
      "$.checkpoint_id": { type: "TAG", AS: "checkpoint_id" },
      "$.channel": { type: "TAG", AS: "channel" },
      "$.version": { type: "TAG", AS: "version" },
      "$.type": { type: "TAG", AS: "type" },
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

export interface TTLConfig {
  defaultTTL?: number; // TTL in minutes
  refreshOnRead?: boolean; // Whether to refresh TTL when reading
}

interface CheckpointDocument {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint: Checkpoint & {
    channel_values?: Record<string, any>;
    channel_blobs?: Record<string, { __blob__: boolean; key: string }>;
  };
  metadata: CheckpointMetadata;
  checkpoint_ts: number;
  has_writes: string;
  source?: string;
  step?: number;
  [key: string]: any; // Allow additional fields for metadata
}

export class RedisSaver extends BaseCheckpointSaver {
  private client: RedisClientType;
  private ttlConfig?: TTLConfig;

  constructor(client: RedisClientType, ttlConfig?: TTLConfig) {
    super();
    this.client = client;
    this.ttlConfig = ttlConfig;
  }

  static async fromUrl(
    url: string,
    ttlConfig?: TTLConfig
  ): Promise<RedisSaver> {
    const client = createClient({ url });
    await client.connect();
    const saver = new RedisSaver(client, ttlConfig);
    await saver.ensureIndexes();
    return saver;
  }

  static async fromCluster(
    rootNodes: Array<{ url: string }>,
    ttlConfig?: TTLConfig
  ): Promise<RedisSaver> {
    const client = createCluster({ rootNodes });
    await client.connect();
    const saver = new RedisSaver(client, ttlConfig);
    await saver.ensureIndexes();
    return saver;
  }

  async get(config: RunnableConfig): Promise<Checkpoint | undefined> {
    const tuple = await this.getTuple(config);
    return tuple?.checkpoint;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;

    if (!threadId) {
      return undefined;
    }

    let key: string;
    let jsonDoc: CheckpointDocument | null;

    if (checkpointId) {
      // Get specific checkpoint
      key = `checkpoint:${threadId}:${checkpointNs}:${checkpointId}`;
      jsonDoc = (await this.client.json.get(key)) as CheckpointDocument | null;
    } else {
      // Get latest checkpoint - need to search
      const pattern = `checkpoint:${threadId}:${checkpointNs}:*`;
      // Use keys for simplicity - scan would be better for large datasets
      const keys = await (this.client as any).keys(pattern);

      if (keys.length === 0) {
        return undefined;
      }

      // Sort by key to get latest
      keys.sort();
      key = keys[keys.length - 1];
      jsonDoc = (await this.client.json.get(key)) as CheckpointDocument | null;
    }

    if (!jsonDoc) {
      return undefined;
    }

    // Refresh TTL if configured
    if (this.ttlConfig?.refreshOnRead && this.ttlConfig?.defaultTTL) {
      await this.applyTTL(key);
    }

    // Load checkpoint with pending writes
    const { checkpoint, pendingWrites } = await this.loadCheckpointWithWrites(
      jsonDoc
    );

    return await this.createCheckpointTuple(jsonDoc, checkpoint, pendingWrites);
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    await this.ensureIndexes();

    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const parentCheckpointId = config.configurable?.checkpoint_id;

    if (!threadId) {
      throw new Error("thread_id is required");
    }

    const checkpointId = checkpoint.id || uuid6(0);
    const key = `checkpoint:${threadId}:${checkpointNs}:${checkpointId}`;

    // Copy checkpoint and filter channel_values to only include changed channels
    const storedCheckpoint = copyCheckpoint(checkpoint);

    // If newVersions is provided and has keys, only store those channels that changed
    // If newVersions is empty {}, store no channel values
    // If newVersions is not provided (undefined), keep all channel_values as-is
    if (storedCheckpoint.channel_values && newVersions !== undefined) {
      if (Object.keys(newVersions).length === 0) {
        // Empty newVersions means no channels changed - store empty channel_values
        storedCheckpoint.channel_values = {};
      } else {
        // Only store the channels that are in newVersions
        const filteredChannelValues: Record<string, any> = {};
        for (const channel of Object.keys(newVersions)) {
          if (channel in storedCheckpoint.channel_values) {
            filteredChannelValues[channel] =
              storedCheckpoint.channel_values[channel];
          }
        }
        storedCheckpoint.channel_values = filteredChannelValues;
      }
    }
    // If newVersions is undefined, keep all channel_values as-is (for backward compatibility)

    // Structure matching Python implementation
    const jsonDoc: CheckpointDocument = {
      thread_id: threadId,
      // Store empty namespace as "__empty__" for RediSearch compatibility
      checkpoint_ns: checkpointNs === "" ? "__empty__" : checkpointNs,
      checkpoint_id: checkpointId,
      parent_checkpoint_id: parentCheckpointId || null,
      checkpoint: storedCheckpoint,
      metadata: metadata,
      checkpoint_ts: Date.now(),
      has_writes: "false",
    };

    // Store metadata fields at top-level for searching
    this.addSearchableMetadataFields(jsonDoc, metadata);

    // Use Redis JSON commands
    await this.client.json.set(key, "$", jsonDoc as any);

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

  async *list(
    config: RunnableConfig | null,
    options?: CheckpointListOptions & { filter?: CheckpointMetadata }
  ): AsyncGenerator<CheckpointTuple> {
    await this.ensureIndexes();

    // If filter is provided (even if empty), use search functionality
    if (options?.filter !== undefined) {
      // Check if we have null values in the filter which RediSearch can't handle
      const hasNullFilter = Object.values(options.filter).some(
        (v) => v === null
      );

      // Build search query
      const queryParts: string[] = [];

      // Add thread_id constraint if provided
      if (config?.configurable?.thread_id) {
        const threadId = config.configurable.thread_id.replace(
          /[-.@]/g,
          "\\$&"
        );
        queryParts.push(`(@thread_id:{${threadId}})`);
      }

      // Add checkpoint_ns constraint if provided
      if (config?.configurable?.checkpoint_ns !== undefined) {
        const checkpointNs = config.configurable.checkpoint_ns;
        if (checkpointNs === "") {
          // Empty string needs special handling in RediSearch
          // We'll store it as "__empty__" in the index
          queryParts.push(`(@checkpoint_ns:{__empty__})`);
        } else {
          const escapedNs = checkpointNs.replace(/[-.@]/g, "\\$&");
          queryParts.push(`(@checkpoint_ns:{${escapedNs}})`);
        }
      }

      // Skip metadata filters in search query when 'before' parameter is used
      // We'll apply them after the before filtering to get correct results
      if (!options?.before && options?.filter) {
        // Add metadata filters (but skip null values)
        for (const [key, value] of Object.entries(options.filter)) {
          if (value === undefined) {
            // Skip undefined filters
          } else if (value === null) {
            // Skip null values for RediSearch query, will handle in post-processing
          } else if (typeof value === "string") {
            // Don't escape, just wrap in braces for exact match
            queryParts.push(`(@${key}:{${value}})`);
          } else if (typeof value === "number") {
            queryParts.push(`(@${key}:[${value} ${value}])`);
          } else if (
            typeof value === "object" &&
            Object.keys(value).length === 0
          ) {
            // Skip empty objects
          }
        }
      }

      if (queryParts.length === 0) {
        queryParts.push("*");
      }

      const query = queryParts.join(" ");
      const limit = options?.limit ?? 10;

      try {
        // Fetch more results than the limit to handle post-filtering for 'before'
        // When no thread_id is specified but 'before' is used, we need to fetch all results
        const fetchLimit =
          options?.before && !config?.configurable?.thread_id
            ? 1000 // Fetch many results for global search with 'before' filtering
            : options?.before
            ? limit * 10
            : limit;

        const results = await this.client.ft.search("checkpoints", query, {
          LIMIT: { from: 0, size: fetchLimit },
          SORTBY: { BY: "checkpoint_ts", DIRECTION: "DESC" },
        });

        let documents = results.documents;

        let yieldedCount = 0;

        for (const doc of documents) {
          if (yieldedCount >= limit) break;

          // Handle 'before' parameter - filter based on checkpoint_id comparison
          // UUID6 IDs are time-sortable, so string comparison works for ordering
          if (options?.before?.configurable?.checkpoint_id) {
            const currentCheckpointId = doc.value.checkpoint_id as string;
            const beforeCheckpointId =
              options.before.configurable.checkpoint_id;

            // Skip checkpoints that are not before the specified checkpoint
            if (currentCheckpointId >= beforeCheckpointId) {
              continue;
            }
          }

          const jsonDoc = doc.value;

          // Apply metadata filters manually (either for null filters or when before parameter was used)
          let matches = true;
          if ((hasNullFilter || options?.before) && options?.filter) {
            for (const [filterKey, filterValue] of Object.entries(
              options.filter
            )) {
              if (filterValue === null) {
                // Check if the field exists and is null in metadata
                // This should only match explicit null, not missing fields
                const metadataValue = (jsonDoc.metadata as any)?.[filterKey];
                if (metadataValue !== null) {
                  matches = false;
                  break;
                }
              } else if (filterValue !== undefined) {
                // Check other metadata values
                const metadataValue = (jsonDoc.metadata as any)?.[filterKey];
                // For objects, do deep equality check with deterministic key ordering
                if (typeof filterValue === "object" && filterValue !== null) {
                  if (
                    deterministicStringify(metadataValue) !==
                    deterministicStringify(filterValue)
                  ) {
                    matches = false;
                    break;
                  }
                } else if (metadataValue !== filterValue) {
                  matches = false;
                  break;
                }
              }
            }
            if (!matches) continue;
          }

          // Load checkpoint with pending writes and migrate sends
          const { checkpoint, pendingWrites } =
            await this.loadCheckpointWithWrites(jsonDoc);
          yield await this.createCheckpointTuple(
            jsonDoc,
            checkpoint,
            pendingWrites
          );
          yieldedCount++;
        }

        // Search succeeded, return without falling through
        return;
      } catch (error: any) {
        if (error.message?.includes("no such index")) {
          // Index doesn't exist yet, fall through to regular listing
        } else {
          throw error;
        }
      }

      // If search failed due to missing index, fall through to regular listing
      if (config?.configurable?.thread_id) {
        // Fall back to regular listing with manual filtering when thread_id is specified
        const threadId = config.configurable.thread_id;
        const checkpointNs = config.configurable.checkpoint_ns ?? "";
        const pattern = `checkpoint:${threadId}:${checkpointNs}:*`;
        // Use scan for better performance and cluster compatibility
        // Use keys for simplicity - scan would be better for large datasets
        const keys = await (this.client as any).keys(pattern);

        keys.sort().reverse();

        let filteredKeys = keys;

        // Handle 'before' parameter
        if (options?.before?.configurable?.checkpoint_id) {
          const beforeThreadId =
            options.before.configurable.thread_id || threadId;
          const beforeCheckpointNs =
            options.before.configurable.checkpoint_ns ?? checkpointNs;
          const beforeKey = `checkpoint:${beforeThreadId}:${beforeCheckpointNs}:${options.before.configurable.checkpoint_id}`;

          const beforeIndex = keys.indexOf(beforeKey);
          if (beforeIndex > 0) {
            // Return all items that come after the found index (i.e., before in time)
            filteredKeys = keys.slice(beforeIndex + 1);
          } else if (beforeIndex === 0) {
            // Nothing before the first item (most recent)
            filteredKeys = [];
          }
          // If not found, return all
        }

        const limit = options?.limit ?? 10;
        const limitedKeys = filteredKeys.slice(0, limit);

        for (const key of limitedKeys) {
          const jsonDoc = (await this.client.json.get(
            key
          )) as CheckpointDocument | null;
          if (jsonDoc) {
            // Check if metadata matches filter
            let matches = true;
            for (const [filterKey, filterValue] of Object.entries(
              options.filter
            )) {
              const metadataValue = (jsonDoc.metadata as any)?.[filterKey];
              if (filterValue === null) {
                if (metadataValue !== null) {
                  matches = false;
                  break;
                }
              } else if (metadataValue !== filterValue) {
                matches = false;
                break;
              }
            }

            if (!matches) continue;

            // Load checkpoint with pending writes and migrate sends
            const { checkpoint, pendingWrites } =
              await this.loadCheckpointWithWrites(jsonDoc);
            yield await this.createCheckpointTuple(
              jsonDoc,
              checkpoint,
              pendingWrites
            );
          }
        }
      } else {
        // Fall back to global search when thread_id is undefined
        // This is needed for validation tests that search globally with 'before' parameter
        const globalPattern =
          config?.configurable?.checkpoint_ns !== undefined
            ? `checkpoint:*:${
                config.configurable.checkpoint_ns === ""
                  ? "__empty__"
                  : config.configurable.checkpoint_ns
              }:*`
            : "checkpoint:*";

        const allKeys = await (this.client as any).keys(globalPattern);
        const allDocuments: { key: string; doc: CheckpointDocument }[] = [];

        // Load all matching documents
        for (const key of allKeys) {
          const jsonDoc = (await this.client.json.get(
            key
          )) as CheckpointDocument | null;
          if (jsonDoc) {
            allDocuments.push({ key, doc: jsonDoc });
          }
        }

        // Sort by timestamp (descending) to match the search behavior
        allDocuments.sort((a, b) => b.doc.checkpoint_ts - a.doc.checkpoint_ts);

        let yieldedCount = 0;
        const limit = options?.limit ?? 10;

        for (const { doc: jsonDoc } of allDocuments) {
          if (yieldedCount >= limit) break;

          // Handle 'before' parameter - filter based on checkpoint_id comparison
          if (options?.before?.configurable?.checkpoint_id) {
            const currentCheckpointId = jsonDoc.checkpoint_id;
            const beforeCheckpointId =
              options.before.configurable.checkpoint_id;

            // Skip checkpoints that are not before the specified checkpoint
            if (currentCheckpointId >= beforeCheckpointId) {
              continue;
            }
          }

          // Apply metadata filters manually
          let matches = true;
          if (options?.filter) {
            for (const [filterKey, filterValue] of Object.entries(
              options.filter
            )) {
              if (filterValue === null) {
                // Check if the field exists and is null in metadata
                const metadataValue = (jsonDoc.metadata as any)?.[filterKey];
                if (metadataValue !== null) {
                  matches = false;
                  break;
                }
              } else if (filterValue !== undefined) {
                // Check other metadata values
                const metadataValue = (jsonDoc.metadata as any)?.[filterKey];
                // For objects, do deep equality check with deterministic key ordering
                if (typeof filterValue === "object" && filterValue !== null) {
                  if (
                    deterministicStringify(metadataValue) !==
                    deterministicStringify(filterValue)
                  ) {
                    matches = false;
                    break;
                  }
                } else if (metadataValue !== filterValue) {
                  matches = false;
                  break;
                }
              }
            }
            if (!matches) continue;
          }

          // Load checkpoint with pending writes and migrate sends
          const { checkpoint, pendingWrites } =
            await this.loadCheckpointWithWrites(jsonDoc);
          yield await this.createCheckpointTuple(
            jsonDoc,
            checkpoint,
            pendingWrites
          );
          yieldedCount++;
        }
      }

      return;
    }

    // Regular listing without filter - use search with empty filter instead
    // This ensures consistent behavior between filter={} and filter=undefined
    const searchOptions: CheckpointListOptions & {
      filter?: CheckpointMetadata;
    } = {
      ...options,
      filter: {} as CheckpointMetadata,
    };

    // Delegate to the search path
    yield* this.list(config, searchOptions);
    return;
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

    // Collect write keys for sorted set tracking
    const writeKeys: string[] = [];

    // Use high-resolution timestamp to ensure unique ordering across putWrites calls
    const baseTimestamp = performance.now() * 1000; // Microsecond precision

    // Store each write as a separate indexed JSON document
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
        timestamp: baseTimestamp,
        global_idx: baseTimestamp + idx, // Add microseconds for sub-millisecond ordering
      };

      await this.client.json.set(writeKey, "$", writeDoc as any);
    }

    // Register write keys in sorted set for efficient retrieval
    if (writeKeys.length > 0) {
      const zsetKey = `write_keys_zset:${threadId}:${checkpointNs}:${checkpointId}`;

      // Use timestamp + idx for scoring to maintain correct order
      const zaddArgs: Record<string, number> = {};
      writeKeys.forEach((key, idx) => {
        zaddArgs[key] = baseTimestamp + idx;
      });
      await this.client.zAdd(
        zsetKey,
        Object.entries(zaddArgs).map(([key, score]) => ({ score, value: key }))
      );

      // Apply TTL to write keys and zset if configured
      if (this.ttlConfig?.defaultTTL) {
        // Apply TTL to write keys and zset
        await this.applyTTL(...writeKeys, zsetKey);
      }
    }

    // Update checkpoint to indicate it has writes
    const checkpointKey = `checkpoint:${threadId}:${checkpointNs}:${checkpointId}`;
    const checkpointExists = await this.client.exists(checkpointKey);
    if (checkpointExists) {
      // Get the current document and update it
      const currentDoc = (await this.client.json.get(
        checkpointKey
      )) as CheckpointDocument | null;
      if (currentDoc) {
        currentDoc.has_writes = "true";
        await this.client.json.set(checkpointKey, "$", currentDoc as any);
      }
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    // Delete checkpoints
    const checkpointPattern = `checkpoint:${threadId}:*`;
    // Use scan for better performance and cluster compatibility
    // Use keys for simplicity - scan would be better for large datasets
    const checkpointKeys = await (this.client as any).keys(checkpointPattern);

    if (checkpointKeys.length > 0) {
      await this.client.del(checkpointKeys);
    }

    // Delete writes
    const writesPattern = `writes:${threadId}:*`;
    // Use scan for better performance and cluster compatibility
    // Use keys for simplicity - scan would be better for large datasets
    const writesKeys = await (this.client as any).keys(writesPattern);

    if (writesKeys.length > 0) {
      await this.client.del(writesKeys);
    }
  }

  async end(): Promise<void> {
    await this.client.quit();
  }

  // Helper method to load channel blobs (simplified - no blob support for now)
  // private async loadChannelBlobs(
  //   checkpoint: Checkpoint & { channel_blobs?: any }
  // ): Promise<Checkpoint> {
  //   // Since we're not using blobs anymore, just return the checkpoint as-is
  //   return checkpoint;
  // }

  // Helper method to load pending writes
  private async loadPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<Array<[string, string, any]> | undefined> {
    // Search for all write documents for this checkpoint
    const pattern = `checkpoint_write:${threadId}:${checkpointNs}:${checkpointId}:*`;
    const writeKeys = await (this.client as any).keys(pattern);

    if (writeKeys.length === 0) {
      return undefined;
    }

    const writeDocuments: any[] = [];
    for (const writeKey of writeKeys) {
      const writeDoc = (await this.client.json.get(writeKey)) as any;
      if (writeDoc) {
        writeDocuments.push(writeDoc);
      }
    }

    // Sort by global_idx (which represents insertion order across all putWrites calls)
    // This matches how SQLite would naturally order by insertion time + idx
    writeDocuments.sort((a, b) => (a.global_idx || 0) - (b.global_idx || 0));

    const pendingWrites: Array<[string, string, any]> = [];
    for (const writeDoc of writeDocuments) {
      // Deserialize write value using serde to restore LangChain objects
      const deserializedValue = await this.serde.loadsTyped(
        "json",
        JSON.stringify(writeDoc.value)
      );
      pendingWrites.push([
        writeDoc.task_id,
        writeDoc.channel,
        deserializedValue,
      ]);
    }

    return pendingWrites;
  }

  // Helper method to load checkpoint with pending writes
  private async loadCheckpointWithWrites(jsonDoc: any): Promise<{
    checkpoint: Checkpoint;
    pendingWrites?: Array<[string, string, any]>;
  }> {
    // Deserialize checkpoint using serde to restore LangChain objects
    const checkpoint: Checkpoint = await this.serde.loadsTyped(
      "json",
      JSON.stringify(jsonDoc.checkpoint)
    );

    // Migrate pending sends ONLY for OLD checkpoint versions (v < 4) with parents
    // Modern checkpoints (v >= 4) should NEVER have pending sends migrated
    if (checkpoint.v < 4 && jsonDoc.parent_checkpoint_id != null) {
      // Convert back from "__empty__" to empty string for migration
      const actualNs =
        jsonDoc.checkpoint_ns === "__empty__" ? "" : jsonDoc.checkpoint_ns;
      await this.migratePendingSends(
        checkpoint,
        jsonDoc.thread_id,
        actualNs,
        jsonDoc.parent_checkpoint_id
      );
    }

    // Load this checkpoint's own pending writes (but don't migrate them)
    let pendingWrites: Array<[string, string, any]> | undefined;
    if (jsonDoc.has_writes === "true") {
      // Convert back from "__empty__" to empty string for key lookup
      const actualNs =
        jsonDoc.checkpoint_ns === "__empty__" ? "" : jsonDoc.checkpoint_ns;
      pendingWrites = await this.loadPendingWrites(
        jsonDoc.thread_id,
        actualNs,
        jsonDoc.checkpoint_id
      );
    }

    return { checkpoint, pendingWrites };
  }

  // Migrate pending sends from parent checkpoint (matches SQLite implementation)
  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string
  ): Promise<void> {
    // Load pending writes from parent checkpoint that have TASKS channel
    const parentWrites = await this.loadPendingWrites(
      threadId,
      checkpointNs,
      parentCheckpointId
    );

    if (!parentWrites || parentWrites.length === 0) {
      return;
    }

    // Filter for TASKS channel writes only
    const taskWrites = parentWrites.filter(([, channel]) => channel === TASKS);

    if (taskWrites.length === 0) {
      return;
    }

    // Collect all task values in order
    const allTasks: any[] = [];
    for (const [, , value] of taskWrites) {
      allTasks.push(value);
    }

    // Add pending sends to checkpoint
    checkpoint.channel_values ??= {};
    checkpoint.channel_values[TASKS] = allTasks;

    // Add to versions (matches SQLite logic)
    checkpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : 1;
  }

  // Helper method to create checkpoint tuple from json document
  private async createCheckpointTuple(
    jsonDoc: any,
    checkpoint: Checkpoint,
    pendingWrites?: Array<[string, string, any]>
  ): Promise<CheckpointTuple> {
    // Convert back from "__empty__" to empty string
    const checkpointNs =
      jsonDoc.checkpoint_ns === "__empty__" ? "" : jsonDoc.checkpoint_ns;

    // Deserialize metadata using serde
    const metadata = (await this.serde.loadsTyped(
      "json",
      JSON.stringify(jsonDoc.metadata)
    )) as CheckpointMetadata;

    return {
      config: {
        configurable: {
          thread_id: jsonDoc.thread_id,
          checkpoint_ns: checkpointNs,
          checkpoint_id: jsonDoc.checkpoint_id,
        },
      },
      checkpoint,
      metadata,
      parentConfig: jsonDoc.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: jsonDoc.thread_id,
              checkpoint_ns: checkpointNs,
              checkpoint_id: jsonDoc.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
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

  private async ensureIndexes(): Promise<void> {
    for (const schema of SCHEMAS) {
      try {
        // Try to create the index
        await this.client.ft.create(schema.index, schema.schema as any, {
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
