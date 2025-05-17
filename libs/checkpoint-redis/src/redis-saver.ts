import type { RunnableConfig } from "@langchain/core/runnables";
import {
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
  BaseCheckpointSaver,
} from "@langchain/langgraph-checkpoint";
import type { Redis } from "ioredis";

import {
  type ICheckpointRedisRepository,
  CheckpointRedisRepository,
} from "./checkpoint-redis-repository.js";
import {
  dumpWrites,
  loadWrites,
  parseRedisCheckpointData,
  parseRedisCheckpointWritesKey,
} from "./utils.js";

export type RedisSaverParams = {
  connection: Redis;
  ttlSeconds?: number;
};

/**
 * Redis-based implementation of the BaseCheckpointSaver for LangGraph.
 * Provides persistence layer for storing and retrieving checkpoints and their associated
 * writes using Redis as the backend storage.
 *
 * @example
 * ```typescript
 * const redis = new Redis();
 * const saver = new RedisSaver({ connection: redis });
 * ```
 */
export class RedisSaver extends BaseCheckpointSaver {
  private readonly repository: ICheckpointRedisRepository;

  /**
   * Time-to-live for Redis keys in seconds (4 days)
   * @private
   */
  private readonly ttlSeconds?: number;

  /**
   * Creates a new RedisSaver instance.
   * @param connection - Redis connection instance
   * @param serde - Optional serializer protocol implementation
   */
  constructor(
    { connection, ttlSeconds }: RedisSaverParams,
    serde?: SerializerProtocol
  ) {
    super(serde);

    this.repository = new CheckpointRedisRepository(connection);
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Stores a checkpoint with its configuration and metadata in Redis.
   * @param config - Runnable configuration containing thread and checkpoint identifiers
   * @param checkpoint - Checkpoint data to store
   * @param metadata - Metadata associated with the checkpoint
   * @returns Promise resolving to updated configuration
   * @throws Error if checkpoint and metadata types don't match
   */
  public async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    // gather all the data needed to create the key
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id: parent_checkpoint_id,
    } = config.configurable ?? {};

    // serialize the checkpoint and metadata
    const [checkpointType, serializedCheckpoint] =
      this.serde.dumpsTyped(checkpoint);
    const [metadataType, serializedMetadata] = this.serde.dumpsTyped(metadata);

    if (checkpointType !== metadataType) {
      throw new Error("Mismatched checkpoint and metadata types.");
    }

    // create the data object to be stored in redis
    const data = {
      checkpoint: Array.from(serializedCheckpoint).join(","),
      type: checkpointType,
      metadata_type: metadataType,
      metadata: Array.from(serializedMetadata).join(","),
      parent_checkpoint_id: parent_checkpoint_id ?? "",
    };

    await this.repository.setCheckpoint(
      JSON.stringify(data),
      thread_id,
      checkpoint_ns,
      checkpoint.id,
      checkpoint.ts,
      this.ttlSeconds
    );

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /**
   * Stores intermediate writes linked to a checkpoint.
   * @param config - Runnable configuration
   * @param writes - Array of pending writes to store
   * @param task_id - Identifier for the task
   * @throws Error if required configuration fields are missing
   */
  public async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    task_id: string
  ): Promise<void> {
    const { thread_id, checkpoint_ns, checkpoint_id } =
      config.configurable ?? {};

    if (
      thread_id === undefined ||
      checkpoint_ns === undefined ||
      checkpoint_id === undefined
    ) {
      throw new Error(
        `The provided config must contain a configurable field with "thread_id", "checkpoint_ns" and "checkpoint_id" fields.`
      );
    }

    const dumpedWrites = dumpWrites(this.serde, writes);

    await this.repository.setWrites(
      dumpedWrites,
      task_id,
      thread_id,
      checkpoint_ns,
      checkpoint_id,
      this.ttlSeconds
    );
  }

  /**
   * Retrieves a checkpoint tuple for a given configuration.
   * @param config - Runnable configuration
   * @returns Promise resolving to checkpoint tuple or undefined if not found
   * @throws Error if thread_id is missing in configuration
   */
  public async getTuple(
    config: RunnableConfig
  ): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_ns = "" } = config.configurable ?? {};
    const { checkpoint_id } = config.configurable ?? {};

    if (thread_id === undefined) {
      throw new Error("thread_id is required in config.configurable");
    }

    const checkpointState = await this.repository.getCheckpointState(
      thread_id,
      checkpoint_ns,
      checkpoint_id
    );

    if (!checkpointState) {
      return;
    }

    const {
      serializedCheckpoint,
      checkpointKey,
      writeKeys,
      serializedPendingWrites = [],
    } = checkpointState;

    if (writeKeys.length === 0) {
      return parseRedisCheckpointData(
        this.serde,
        checkpointKey,
        serializedCheckpoint
      );
    }

    const pendingWrites = await loadWrites(
      this.serde,
      Object.fromEntries(
        writeKeys.map((key, i) => {
          const parsedKey = parseRedisCheckpointWritesKey(key);
          const result = serializedPendingWrites[i] ?? {};

          return [`${parsedKey.task_id},${parsedKey.idx}`, result];
        })
      )
    );

    return parseRedisCheckpointData(
      this.serde,
      checkpointKey,
      serializedCheckpoint,
      pendingWrites
    );
  }

  /**
   * Lists checkpoints matching given configuration and filter criteria.
   * @param config - Runnable configuration
   * @param options - Optional listing options (limit, before)
   * @yields CheckpointTuple for each matching checkpoint
   */
  public async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before } = options ?? {};
    const { thread_id, checkpoint_ns } = config.configurable ?? {};

    const checkpointKeyDataPairs =
      await this.repository.getCheckpointKeyDataPairs(
        thread_id,
        checkpoint_ns,
        before?.configurable?.checkpoint_id ?? "",
        limit
      );

    for (const { key, data } of checkpointKeyDataPairs) {
      const parsedData = data ? JSON.parse(data) : null;

      if (parsedData && parsedData.checkpoint && parsedData.metadata) {
        yield parseRedisCheckpointData(this.serde, key, parsedData);
      }
    }
  }
}
