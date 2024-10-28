import { type VercelKV, createClient } from "@vercel/kv";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
  type CheckpointMetadata,
  CheckpointPendingWrite,
} from "@langchain/langgraph-checkpoint";

// snake_case is used to match Python implementation
interface KVRow {
  parent_checkpoint_id: string;
  type: string;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
}

interface KVConfig {
  url: string;
  token: string;
}

/**
 * A LangGraph checkpoint saver backed by a Vercel KV database.
 */
export class VercelKVSaver extends BaseCheckpointSaver {
  private kv: VercelKV;

  constructor(config: KVConfig, serde?: SerializerProtocol) {
    super(serde);
    this.kv = createClient(config);
  }

  /**
   * Retrieves a checkpoint from the Vercel KV database based on the
   * provided config. If the config contains a "checkpoint_id" key, the checkpoint with
   * the matching thread ID and checkpoint ID is retrieved. Otherwise, the latest checkpoint
   * for the given thread ID is retrieved.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_id } = config.configurable ?? {};

    if (!thread_id) {
      return undefined;
    }

    const key = checkpoint_id
      ? `${thread_id}:${checkpoint_id}`
      : `${thread_id}:last`;

    const row: KVRow | null = await this.kv.get(key);

    if (!row) {
      return undefined;
    }

    const checkpointP = this.serde.loadsTyped(row.type, row.checkpoint);
    const metadataP = this.serde.loadsTyped(row.type, row.metadata);

    const [checkpoint, metadata] = await Promise.all([
      checkpointP as Checkpoint,
      metadataP as CheckpointMetadata,
    ]);

    const pendingWrites: CheckpointPendingWrite[] = [];

    // PENDING WRITES
    // const serializedWrites = await this.kv.mget(
    //   `${thread_id}:${checkpoint_id}`
    // );

    // const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
    //   serializedWrites.map(async (serializedWrite) => {
    //     return [
    //       serializedWrite.task_id,
    //       serializedWrite.channel,
    //       await this.serde.loadsTyped(
    //         serializedWrite.type,
    //         serializedWrite.value
    //       ),
    //     ] as CheckpointPendingWrite;
    //   })
    // );

    return {
      checkpoint,
      metadata,
      pendingWrites,
      config: {
        configurable: {
          thread_id,
          checkpoint_id: (checkpoint as Checkpoint).id,
        },
      },
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const thread_id: string = config.configurable?.thread_id;
    const { limit, before, filter } = options ?? {};

    // LUA script to get keys excluding those starting with "last"
    const luaScript = `
      local prefix = ARGV[1]
      local cursor = '0'
      local result = {}
      repeat
        local scanResult = redis.call('SCAN', cursor, 'MATCH', prefix .. '*', 'COUNT', 1000)
        cursor = scanResult[1]
        local keys = scanResult[2]
        for _, key in ipairs(keys) do
          if key:sub(-5) ~= ':last' then
            table.insert(result, key)
          end
        end
      until cursor == '0'
      return result
    `;

    // Execute the LUA script with the thread_id as an argument
    const keys: string[] = await this.kv.eval(luaScript, [], [thread_id]);

    // Filter keys based on the before parameter
    const filteredKeys = keys.filter((key: string) => {
      const [, checkpoint_id] = key.split(":");

      return !before || checkpoint_id < before?.configurable?.checkpoint_id;
    });

    // TODO: Implement filter by metadata in the KV query.

    const sortedKeys = filteredKeys
      .sort((a: string, b: string) => b.localeCompare(a))
      .slice(0, limit);

    const rows: (KVRow | null)[] = await this.kv.mget(...sortedKeys);

    for (const row of rows) {
      if (row) {
        const checkpointP = this.serde.loadsTyped(row.type, row.checkpoint);
        const metadataP = this.serde.loadsTyped(row.type, row.metadata);

        const [checkpoint, metadata] = await Promise.all([
          checkpointP as Checkpoint,
          metadataP as CheckpointMetadata,
        ]);

        yield {
          config: {
            configurable: {
              thread_id,
              checkpoint_id: (checkpoint as Checkpoint).id,
            },
          },
          checkpoint: checkpoint,
          metadata: metadata,
          parentConfig: row.parent_checkpoint_id
            ? {
                configurable: {
                  thread_id,
                  checkpoint_id: row.parent_checkpoint_id,
                },
              }
            : undefined,
        };
      }
    }
  }

  /**
   * Saves a checkpoint. The checkpoint is associated
   * with the provided config and its parent config (if any).
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const thread_id = config.configurable?.thread_id;

    if (!thread_id || !checkpoint.id) {
      throw new Error("Thread ID and Checkpoint ID must be defined");
    }

    const [checkpointType, checkpointValue] = this.serde.dumpsTyped(checkpoint);
    const [metadataType, metadataValue] = this.serde.dumpsTyped(metadata);

    if (checkpointType !== metadataType) {
      throw new Error("Mismatched checkpoint and metadata types.");
    }

    const row: KVRow = {
      parent_checkpoint_id: config.configurable?.checkpoint_id,
      type: checkpointType,
      checkpoint: checkpointValue,
      metadata: metadataValue,
    };

    // LUA script to set checkpoint data atomically"
    const luaScript = `
      local thread_id = ARGV[1]
      local checkpoint_id = ARGV[2]
      local row = ARGV[3]

      redis.call('SET', thread_id .. ':' .. checkpoint_id, row)
      redis.call('SET', thread_id .. ':last', row)
    `;

    // Save the checkpoint and the last checkpoint
    await this.kv.eval(luaScript, [], [thread_id, checkpoint.id, row]);

    return {
      configurable: {
        thread_id,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /**
   * Saves intermediate writes associated with a checkpoint.
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;
    const checkpoint_id = config.configurable?.checkpoint_id;
    if (
      thread_id === undefined ||
      checkpoint_ns === undefined ||
      checkpoint_id === undefined
    ) {
      throw new Error(
        `The provided config must contain a configurable field with "thread_id", "checkpoint_ns" and "checkpoint_id" fields.`
      );
    }

    const values: Record<string, any> = writes.reduce(
      (acc, [channel, value], idx) => {
        const key = `${thread_id}:${checkpoint_id}:${taskId}:${idx}`;
        const [type, serializedValue] = this.serde.dumpsTyped(value);
        return {
          ...acc,
          [key]: {
            channel,
            type,
            value: serializedValue,
          },
        };
      }
    );

    await this.kv.mset(values);
  }
}
