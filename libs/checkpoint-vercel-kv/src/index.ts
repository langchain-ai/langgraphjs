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
  checkpoint: string;
  metadata: string;
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
    const thread_id = config.configurable?.thread_id;
    const checkpoint_id = config.configurable?.checkpoint_id;

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

    const [checkpoint, metadata] = await Promise.all([
      this.serde.parse(row.checkpoint),
      this.serde.parse(row.metadata),
    ]);

    return {
      checkpoint: checkpoint as Checkpoint,
      metadata: metadata as CheckpointMetadata,
      config: checkpoint_id
        ? config
        : {
            configurable: {
              thread_id,
              checkpoint_id: (checkpoint as Checkpoint).id,
            },
          },
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

    const filteredKeys = keys.filter((key: string) => {
      const [, checkpoint_id] = key.split(":");

      return !before || checkpoint_id < before?.configurable?.checkpoint_id;
    });

    const sortedKeys = filteredKeys
      .sort((a: string, b: string) => b.localeCompare(a))
      .slice(0, limit);

    const rows: (KVRow | null)[] = await this.kv.mget(...sortedKeys);
    for (const row of rows) {
      if (row) {
        const [checkpoint, metadata] = await Promise.all([
          this.serde.parse(row.checkpoint),
          this.serde.parse(row.metadata),
        ]);

        yield {
          config: {
            configurable: {
              thread_id,
              checkpoint_id: (checkpoint as Checkpoint).id,
            },
          },
          checkpoint: checkpoint as Checkpoint,
          metadata: metadata as CheckpointMetadata,
        };
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const thread_id = config.configurable?.thread_id;

    if (!thread_id || !checkpoint.id) {
      throw new Error("Thread ID and Checkpoint ID must be defined");
    }

    const row: KVRow = {
      checkpoint: this.serde.stringify(checkpoint),
      metadata: this.serde.stringify(metadata),
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

    const key = `${thread_id}:${checkpoint_ns}:${checkpoint_id}:${taskId}`;
    await this.kv.set(key, writes);
  }
}
