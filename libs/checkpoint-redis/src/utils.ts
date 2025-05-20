/**
 * @fileoverview Utility functions for Redis-based checkpoint management in LangGraph.
 * These utilities handle key formatting, parsing, and data serialization/deserialization
 * for storing checkpoints and their associated writes in Redis.
 */

import {
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
  CheckpointPendingWrite,
} from "@langchain/langgraph-checkpoint";

/** Separator used for Redis key components */
const REDIS_KEY_SEPARATOR = ":";

const CHECKPOINT_INDEX_KEY = "checkpoint_index:";
const WRITES_INDEX_KEY = "writes_index:";

/**
 * Creates a Redis key for storing checkpoint data by combining components with a separator.
 * Format: 'checkpoint:threadId:checkpointNs:checkpointId'
 *
 * @param threadId - Unique identifier for the execution thread
 * @param checkpointNs - Namespace for the checkpoint
 * @param checkpointId - Unique identifier for the checkpoint
 * @returns {string} Formatted Redis key string using ':' as separator
 * @example
 * ```typescript
 * const key = makeRedisCheckpointKey('thread-1', 'default', 'cp-123');
 * // Returns: 'checkpoint:thread-1:default:cp-123'
 * ```
 */
export function makeRedisCheckpointKey(
  threadId: string,
  checkpointNs: string,
  checkpointId: string
): string {
  return ["checkpoint", threadId, checkpointNs, checkpointId].join(
    REDIS_KEY_SEPARATOR
  );
}

/**
 * Creates a Redis key for storing checkpoint writes data.
 * Format: 'writes:threadId:checkpointNs:checkpointId:taskId[:idx]'
 *
 * @param threadId - Unique identifier for the execution thread
 * @param checkpointNs - Namespace for the checkpoint
 * @param checkpointId - Unique identifier for the checkpoint
 * @param taskId - Identifier for the specific task
 * @param idx - Optional index for the write operation. If null, it's omitted from the key
 * @returns {string} Formatted Redis key string for writes
 * @example
 * ```typescript
 * const key = makeRedisCheckpointWritesKey('thread-1', 'default', 'cp-123', 'task-1', 0);
 * // Returns: 'writes:thread-1:default:cp-123:task-1:0'
 * ```
 */
export function makeRedisCheckpointWritesKey(
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
  taskId: string,
  idx: number | null
): string {
  const key = ["writes", threadId, checkpointNs, checkpointId, taskId];

  if (idx === null) {
    return key.join(REDIS_KEY_SEPARATOR);
  }

  return [...key, idx?.toString()].join(REDIS_KEY_SEPARATOR);
}

/**
 * Parses a Redis key for checkpoint writes into its component parts.
 * Expected format: 'writes:threadId:checkpointNs:checkpointId:taskId:idx'
 *
 * @param redisKey - Redis key string to parse
 * @returns {Record<string, string>} Object containing parsed components:
 *   - thread_id: Thread identifier
 *   - checkpoint_ns: Checkpoint namespace
 *   - checkpoint_id: Checkpoint identifier
 *   - task_id: Task identifier
 *   - idx: Write operation index
 * @throws {Error} If key doesn't start with 'writes'
 * @example
 * ```typescript
 * const components = parseRedisCheckpointWritesKey('writes:thread-1:default:cp-123:task-1:0');
 * // Returns: {
 * //   thread_id: 'thread-1',
 * //   checkpoint_ns: 'default',
 * //   checkpoint_id: 'cp-123',
 * //   task_id: 'task-1',
 * //   idx: '0'
 * // }
 * ```
 */
export function parseRedisCheckpointWritesKey(
  redisKey: string
): Record<string, string> {
  const [namespace, thread_id, checkpoint_ns, checkpoint_id, task_id, idx] =
    redisKey.split(REDIS_KEY_SEPARATOR);

  if (namespace !== "writes") {
    throw new Error("Expected checkpoint key to start with 'writes'");
  }

  return {
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    task_id,
    idx,
  };
}

/**
 * Serializes an array of pending writes using the provided serializer.
 * Converts each write into a format suitable for Redis storage.
 *
 * @param serde - Serializer protocol implementation for type-safe serialization
 * @param writes - Array of pending writes to serialize, each containing a channel and value
 * @returns {Array} Array of serialized write objects containing:
 *   - channel: The write channel identifier
 *   - type: The serialized type information
 *   - value: The serialized value as a string of comma-separated numbers
 * @example
 * ```typescript
 * const writes = [['channel1', someValue], ['channel2', anotherValue]];
 * const serialized = dumpWrites(serializerInstance, writes);
 * ```
 */
export function dumpWrites(
  serde: SerializerProtocol,
  writes: PendingWrite[]
): { channel: string; type: string; value: string }[] {
  return writes.map(([channel, value]) => {
    const [type, serializedValue] = serde.dumpsTyped(value);

    return {
      channel,
      type,
      value: Array.from(serializedValue).join(","),
    };
  });
}

/**
 * Deserializes writes data from Redis storage format back into checkpoint pending writes.
 *
 * @param serde - Serializer protocol implementation for type-safe deserialization
 * @param taskIdToData - Record mapping task IDs to their associated write data
 * @returns {Promise<CheckpointPendingWrite[]>} Promise resolving to array of checkpoint pending writes
 * @example
 * ```typescript
 * const taskData = {
 *   'task1,0': { channel: 'ch1', type: 'string', value: '...' },
 *   'task1,1': { channel: 'ch2', type: 'number', value: '...' }
 * };
 * const writes = await loadWrites(serializerInstance, taskData);
 * ```
 */
export async function loadWrites(
  serde: SerializerProtocol,
  taskIdToData: Record<string, Record<string, string>>
): Promise<CheckpointPendingWrite[]> {
  const writesPromises = Object.entries(taskIdToData).map(
    async ([taskId, data]) =>
      [
        taskId.split(",")[0],
        data.channel,
        await serde.loadsTyped(
          data.type,
          Uint8Array.from(data.value.split(",").map((num) => parseInt(num, 10)))
        ),
      ] as CheckpointPendingWrite
  );

  return Promise.all(writesPromises);
}

/**
 * Parses Redis checkpoint data into a complete CheckpointTuple.
 * Combines checkpoint data, metadata, and optional pending writes into a unified structure.
 *
 * @param serde - Serializer protocol implementation
 * @param key - Redis key for the checkpoint
 * @param data - Raw checkpoint data from Redis containing serialized checkpoint and metadata
 * @param pendingWrites - Optional array of pending writes associated with the checkpoint
 * @returns {Promise<CheckpointTuple>} Promise resolving to parsed CheckpointTuple containing:
 *   - config: Configuration with thread, namespace, and checkpoint identifiers
 *   - checkpoint: Deserialized checkpoint data
 *   - metadata: Deserialized metadata
 *   - parentConfig: Optional parent checkpoint configuration
 *   - pendingWrites: Optional array of pending writes
 * @example
 * ```typescript
 * const tuple = await parseRedisCheckpointData(
 *   serializerInstance,
 *   'checkpoint:thread-1:default:cp-123',
 *   { type: 'json', checkpoint: '...', metadata_type: 'json', metadata: '...' }
 * );
 * ```
 */
export async function parseRedisCheckpointData(
  serde: SerializerProtocol,
  key: string,
  data: Record<string, string>,
  pendingWrites?: CheckpointPendingWrite[]
): Promise<CheckpointTuple> {
  const parsedKey = parseRedisCheckpointKey(key);
  const { thread_id, checkpoint_ns = "", checkpoint_id } = parsedKey;

  const config = {
    configurable: {
      thread_id,
      checkpoint_ns,
      checkpoint_id,
    },
  };

  const checkpoint = await serde.loadsTyped(
    data.type,
    Uint8Array.from(data.checkpoint.split(",").map((num) => parseInt(num, 10)))
  );

  const metadata = await serde.loadsTyped(
    data.metadata_type,
    Uint8Array.from(data.metadata.split(",").map((num) => parseInt(num, 10)))
  );
  const parentCheckpointId = data.parent_checkpoint_id;
  const parentConfig = parentCheckpointId
    ? {
        configurable: {
          thread_id,
          checkpoint_ns,
          checkpoint_id: parentCheckpointId,
        },
      }
    : undefined;

  return { config, checkpoint, metadata, parentConfig, pendingWrites };
}

/**
 * Parses a Redis checkpoint key into its component parts.
 * Expected format: 'checkpoint:threadId:checkpointNs:checkpointId'
 *
 * @param redisKey - Redis key string to parse
 * @returns {Record<string, string>} Object containing parsed components:
 *   - thread_id: Thread identifier
 *   - checkpoint_ns: Checkpoint namespace
 *   - checkpoint_id: Checkpoint identifier
 * @throws {Error} If key doesn't start with 'checkpoint'
 * @example
 * ```typescript
 * const components = parseRedisCheckpointKey('checkpoint:thread-1:default:cp-123');
 * // Returns: {
 * //   thread_id: 'thread-1',
 * //   checkpoint_ns: 'default',
 * //   checkpoint_id: 'cp-123'
 * // }
 * ```
 */
export function parseRedisCheckpointKey(
  redisKey: string
): Record<string, string> {
  const [namespace, thread_id, checkpoint_ns, checkpoint_id] =
    redisKey.split(REDIS_KEY_SEPARATOR);

  if (namespace !== "checkpoint") {
    throw new Error("Expected checkpoint key to start with 'checkpoint'");
  }

  return {
    thread_id,
    checkpoint_ns,
    checkpoint_id,
  };
}

/**
 * Generates the Redis key for checkpoint index
 * @param threadId - Thread identifier
 * @param checkpointNs - Checkpoint namespace
 * @returns Formatted Redis key for checkpoint index
 */
export function makeRedisCheckpointIndexKey(
  threadId: string,
  checkpointNs: string
): string {
  return `${CHECKPOINT_INDEX_KEY}${threadId}:${checkpointNs}`;
}

/**
 * Generates the Redis key for writes index
 * @param threadId - Thread identifier
 * @param checkpointNs - Checkpoint namespace
 * @param checkpointId - Checkpoint identifier
 * @returns Formatted Redis key for writes index
 */
export function makeRedisWritesIndexKey(
  threadId: string,
  checkpointNs: string,
  checkpointId: string
): string {
  return `${WRITES_INDEX_KEY}${threadId}:${checkpointNs}:${checkpointId}`;
}
