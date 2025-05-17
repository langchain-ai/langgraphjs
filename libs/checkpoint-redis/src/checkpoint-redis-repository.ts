import type { Redis } from "ioredis";

import {
  makeRedisCheckpointKey,
  makeRedisCheckpointWritesKey,
  makeRedisWritesIndexKey,
  makeRedisCheckpointIndexKey,
} from "./utils.js";

/**
 * Interface defining Redis repository operations for checkpoint management
 */
export interface ICheckpointRedisRepository {
  setCheckpoint(
    data: string,
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string,
    checkpoint_ts: string,
    ttl?: number
  ): Promise<void>;

  setWrites(
    writes: Array<{ channel: string; type: string; value: string }>,
    task_id: string,
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string,
    ttl?: number
  ): Promise<void>;

  getCheckpointState(
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string
  ): Promise<
    | {
        serializedCheckpoint: Record<string, string>;
        checkpointKey: string;
        writeKeys: string[];
        serializedPendingWrites?: Record<string, string>[];
      }
    | undefined
  >;

  getCheckpointKeyDataPairs(
    thread_id: string,
    checkpoint_ns: string,
    before?: string,
    limit?: number
  ): Promise<{ key: string; data: string }[]>;
}

/**
 * Redis repository implementation for checkpoint data persistence
 */
export class CheckpointRedisRepository implements ICheckpointRedisRepository {
  constructor(private readonly connection: Redis) {}

  /**
   * Sets a checkpoint in Redis with TTL and creates an index entry atomically
   * @param key - Redis key for the checkpoint
   * @param data - Checkpoint data to store
   * @param indexKey - Key for the sorted set index
   * @param score - Score for the sorted set member
   * @param member - Member to add to the sorted set
   * @param ttl - Time-to-live in seconds
   */
  public async setCheckpoint(
    data: string,
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string,
    checkpoint_ts: string,
    ttl?: number
  ): Promise<void> {
    const indexKey = makeRedisCheckpointIndexKey(
      thread_id ?? "",
      checkpoint_ns ?? ""
    );
    const key = makeRedisCheckpointKey(
      thread_id ?? "",
      checkpoint_ns,
      checkpoint_id
    );

    const score = new Date(checkpoint_ts).getTime();

    const multi = this.connection.multi();

    multi.set(key, data, ...(ttl ? ["EX", ttl] : []));
    multi.zadd(indexKey, score, checkpoint_id);
    multi.expire(indexKey, ttl);
    await multi.exec();
  }

  /**
   * Sets multiple writes in Redis with TTL
   * @param writes - Array of key-value pairs to write
   * @param indexKey - Key for the sorted set index
   * @param ttl - Time-to-live in seconds
   */
  public async setWrites(
    writes: Array<{ channel: string; type: string; value: string }>,
    task_id: string,
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string,
    ttl: number
  ): Promise<void> {
    const indexKey = makeRedisWritesIndexKey(
      thread_id,
      checkpoint_ns,
      checkpoint_id
    );

    const writesWithKeys = writes.map((write, idx) => ({
      key: makeRedisCheckpointWritesKey(
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        task_id,
        idx
      ),
      value: JSON.stringify(write),
    }));

    const multi = this.connection.multi();

    writesWithKeys.forEach(({ key, value }, idx) => {
      multi.set(key, value, ...(ttl ? ["EX", ttl] : []));
      multi.zadd(indexKey, idx, key);
    });

    multi.expire(indexKey, ttl);
    await multi.exec();
  }

  public async getWriteKeysByCheckpoint(
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string
  ): Promise<string[]> {
    const indexKey = makeRedisWritesIndexKey(
      thread_id,
      checkpoint_ns,
      checkpoint_id
    );

    const writeKeys = await this.connection.zrange(indexKey, 0, -1);

    return writeKeys;
  }

  /**
   * Gets the checkpoint state from Redis
   * @param thread_id - Thread identifier
   * @param checkpoint_ns - Checkpoint namespace
   * @param checkpoint_id - Checkpoint identifier
   * @returns Promise resolving to checkpoint state or undefined if not found
   */
  public async getCheckpointState(
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string
  ): Promise<
    | {
        serializedCheckpoint: Record<string, string>;
        checkpointKey: string;
        writeKeys: string[];
        serializedPendingWrites?: Record<string, string>[];
      }
    | undefined
  > {
    const { checkpoint, checkpointKey } =
      (await this._getCheckpointData(
        thread_id,
        checkpoint_ns,
        checkpoint_id
      )) || {};

    if (!checkpoint || !checkpointKey) {
      return;
    }

    const writeKeys = await this._getWriteKeys(
      thread_id,
      checkpoint_ns,
      checkpoint_id
    );

    if (writeKeys.length === 0) {
      return { serializedCheckpoint: checkpoint, checkpointKey, writeKeys };
    }

    const pendingWrites = await this.connection.mget(writeKeys);

    const parsedPendingWrites = pendingWrites
      .filter(Boolean)
      .map((write: string) => JSON.parse(write));

    return {
      serializedCheckpoint: checkpoint,
      checkpointKey,
      writeKeys,
      serializedPendingWrites: parsedPendingWrites,
    };
  }

  /**
   * Gets checkpoint key data pairs from Redis
   * @param thread_id - Thread identifier
   * @param checkpoint_ns - Checkpoint namespace
   * @param before - Member to get checkpoints before
   * @param limit - Maximum number of checkpoints to return
   * @returns Array of checkpoint key data pairs
   */
  public async getCheckpointKeyDataPairs(
    thread_id: string,
    checkpoint_ns: string,
    before?: string,
    limit?: number
  ): Promise<{ key: string; data: string }[]> {
    const indexKey = makeRedisCheckpointIndexKey(
      thread_id ?? "",
      checkpoint_ns ?? ""
    );

    const checkpointIds: string[] = before
      ? await this._getCheckpointsBefore(indexKey, before, limit)
      : await this.connection.zrange(indexKey, 0, limit ? limit - 1 : -1);

    const checkpointKeys = checkpointIds.map((id: string) =>
      makeRedisCheckpointKey(thread_id ?? "", checkpoint_ns ?? "", id)
    );

    const checkpointData = await this.connection.mget(checkpointKeys);

    return checkpointKeys
      .map((key: string, idx: number) =>
        checkpointData[idx] ? { key, data: checkpointData[idx] } : null
      )
      .filter(Boolean) as { key: string; data: string }[];
  }

  /**
   * Gets checkpoint from Redis by key
   * @param thread_id - Thread identifier
   * @param checkpoint_ns - Checkpoint namespace
   * @param checkpoint_id - Checkpoint identifier
   * @returns Promise resolving to parsed checkpoint data with key or undefined if not found
   */
  private async _getCheckpointData(
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string
  ): Promise<
    { checkpoint: Record<string, string>; checkpointKey: string } | undefined
  > {
    const checkpointKey = await this._getCheckpointKey(
      thread_id,
      checkpoint_ns,
      checkpoint_id
    );

    if (!checkpointKey) {
      return;
    }

    const checkpoint = await this.connection.get(checkpointKey);

    if (!checkpoint) {
      return;
    }

    return {
      checkpoint: JSON.parse(checkpoint) as Record<string, string>,
      checkpointKey,
    };
  }

  private async _getWriteKeys(
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string
  ): Promise<string[]> {
    const writesIndexKey = makeRedisWritesIndexKey(
      thread_id,
      checkpoint_ns,
      checkpoint_id
    );

    return await this.connection.zrange(writesIndexKey, 0, -1);
  }

  /**
   * Gets checkpoints before a given member from the sorted set
   * @param indexKey - Key for the sorted set index
   * @param before - Member to get checkpoints before
   * @param limit - Maximum number of checkpoints to return
   * @returns Array of checkpoint IDs before the given member
   */
  private async _getCheckpointsBefore(
    indexKey: string,
    before: string,
    limit?: number
  ): Promise<string[]> {
    const score = await this._getScoreFromIndex(indexKey, before);

    if (!score) {
      return [];
    }

    return await this._getCheckpointsByScore(
      indexKey,
      "-inf",
      String(Number(score) - 1),
      limit
    );
  }

  /**
   * Gets the Redis key for a checkpoint based on configuration.
   * @param thread_id - Thread identifier
   * @param checkpoint_ns - Checkpoint namespace
   * @param checkpoint_id - Optional checkpoint identifier
   * @returns Promise resolving to Redis key or null if not found
   * @private
   */
  private async _getCheckpointKey(
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string | undefined
  ): Promise<string | null> {
    if (checkpoint_id) {
      return makeRedisCheckpointKey(thread_id, checkpoint_ns, checkpoint_id);
    }

    const indexKey = makeRedisCheckpointIndexKey(thread_id, checkpoint_ns);
    const latestCheckpointId = await this.connection.zrange(indexKey, -1, -1);

    if (!latestCheckpointId.length) {
      return null;
    }

    return makeRedisCheckpointKey(
      thread_id,
      checkpoint_ns,
      latestCheckpointId[0]
    );
  }

  /**
   * Gets checkpoints by score range from the sorted set
   */
  private async _getCheckpointsByScore(
    indexKey: string,
    min: string,
    max: string,
    limit?: number
  ): Promise<string[]> {
    return await this.connection.zrangebyscore(
      indexKey,
      min,
      max,
      "LIMIT",
      0,
      limit ?? -1
    );
  }

  /**
   * Gets score for a member from the sorted set
   */
  private async _getScoreFromIndex(
    indexKey: string,
    member: string
  ): Promise<string | null> {
    return await this.connection.zscore(indexKey, member);
  }
}
