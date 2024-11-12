import { get } from "@vercel/edge-config";
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
  checkpoint: string;
  metadata: string;
}

interface KVConfig {
  url: string;
  token: string;
}

interface KVPendingWrite {
  type: string;
  channel: string;
  task_id: string;
  value: string;
}

/**
 * LangGraph checkpointer that uses a Vercel KV instance as the backing store.
 *
 * @example
 * ```
 * import { ChatOpenAI } from "@langchain/openai";
 * import { VercelKVSaver } from "@langchain/langgraph-checkpoint-vercel-kv";
 * import { createReactAgent } from "@langchain/langgraph/prebuilt";
 *
 * const checkpointer = new VercelKVSaver({
 *   url: "https://your-vercel-project.vercel.app",
 *   token: "your-vercel-token"
 * });
 *
 * const graph = createReactAgent({
 *   tools: [getWeather],
 *   llm: new ChatOpenAI({
 *     model: "gpt-4o-mini",
 *   }),
 *   checkpointSaver: checkpointer,
 * });
 * const config = { configurable: { thread_id: "1" } };
 *
 * await graph.invoke({
 *   messages: [{
 *     role: "user",
 *     content: "what's the weather in sf"
 *   }],
 * }, config);
 * ```
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
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id = "",
    } = config.configurable ?? {};

    if (!thread_id) {
      return undefined;
    }

    const key = checkpoint_id
      ? `${thread_id}:${checkpoint_ns}:${checkpoint_id}`
      : `${thread_id}:${checkpoint_ns}:last`;

    const row: KVRow | null = await this.kv.get(key);

    if (!row) {
      return undefined;
    }

    const [cType, cDumpedValue] = this.serde.dumpsTyped(row.checkpoint);
    const checkpointPromise = this.serde.loadsTyped(cType, cDumpedValue);

    const [mType, mDumpedValue] = this.serde.dumpsTyped(row.metadata);
    const metadataPromise = this.serde.loadsTyped(mType, mDumpedValue);

    const [checkpoint, metadata] = await Promise.all([
      checkpointPromise as Checkpoint,
      metadataPromise as CheckpointMetadata,
    ]);

    // PENDING WRITES
    let pendingWrites: CheckpointPendingWrite[] = [];

    const pendingWPrefix = `PENDING_WRITES:${thread_id}:${checkpoint_ns}:${checkpoint_id}`;

    const pendingWLua = `
      local prefix = ARGV[1]
      local cursor = '0'
      local result = {}
      repeat
        local scanResult = redis.call('SCAN', cursor, 'MATCH', prefix .. '*', 'COUNT', 1000)
        cursor = scanResult[1]
        local keys = scanResult[2]
        for _, key in ipairs(keys) do
          table.insert(result, key)
        end
      until cursor == '0'
      return result
    `;

    const pendingWriteKeys: string[] = await this.kv.eval(
      pendingWLua,
      [],
      [pendingWPrefix]
    );

    if (pendingWriteKeys.length) {
      const serializedWrites: (KVPendingWrite | null)[] = await this.kv.mget(
        ...pendingWriteKeys
      );
      pendingWrites = await Promise.all(
        serializedWrites
          .filter((write): write is KVPendingWrite => write !== null)
          .map(async (serializedWrite) => {
            const [sType, sDumpedValue] = this.serde.dumpsTyped(
              serializedWrite.value
            );
            const unserializedValue = await this.serde.loadsTyped(
              sType,
              sDumpedValue
            );
            return [
              serializedWrite.task_id,
              serializedWrite.channel,
              unserializedValue,
            ] as CheckpointPendingWrite;
          })
      );
    }
    return {
      checkpoint,
      metadata,
      pendingWrites,
      config: {
        configurable: {
          thread_id,
          checkpoint_ns,
          checkpoint_id: checkpoint.id,
        },
      },
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id,
              checkpoint_ns,
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
    const { thread_id, checkpoint_ns = "" } = config.configurable ?? {};
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

    // Execute the LUA script with the prefix as an argument
    const prefix = `${thread_id}:${checkpoint_ns}`;
    const keys: string[] = await this.kv.eval(luaScript, [], [prefix]);

    // Filter keys based on the before parameter
    const filteredKeys = keys.filter((key: string) => {
      const [, , checkpoint_id] = key.split(":");
      return !before || checkpoint_id < before?.configurable?.checkpoint_id;
    });

    const sortedKeys = filteredKeys.sort((a: string, b: string) =>
      b.localeCompare(a)
    );

    const rows: (KVRow | null)[] = await this.kv.mget(...sortedKeys);

    let limitCount = 0;

    for (const row of rows) {
      if (row) {
        const [cType, cDumpedValue] = this.serde.dumpsTyped(row.checkpoint);
        const checkpointPromise = this.serde.loadsTyped(cType, cDumpedValue);

        const [mType, mDumpedValue] = this.serde.dumpsTyped(row.metadata);
        const metadataPromise = this.serde.loadsTyped(mType, mDumpedValue);

        const [checkpoint, metadata] = await Promise.all([
          checkpointPromise as Checkpoint,
          metadataPromise as CheckpointMetadata,
        ]);

        // filter by metadata
        if (filter && Object.keys(filter).length > 0) {
          const matches = Object.keys(filter).every(
            (key) => filter[key] === metadata[key as keyof CheckpointMetadata]
          );
          if (!matches) {
            continue;
          }
        }

        yield {
          config: {
            configurable: {
              thread_id,
              checkpoint_ns,
              checkpoint_id: checkpoint.id,
            },
          },
          checkpoint: checkpoint,
          metadata: metadata,
          parentConfig: row.parent_checkpoint_id
            ? {
                configurable: {
                  thread_id,
                  checkpoint_ns: checkpoint_ns,
                  checkpoint_id: row.parent_checkpoint_id,
                },
              }
            : undefined,
        };
        if (limit && ++limitCount >= limit) {
          break;
        }
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
    if (config.configurable === undefined) {
      throw new Error(`Missing "configurable" field in "config" param`);
    }

    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id = "",
    } = config.configurable;

    if (!thread_id || !checkpoint.id) {
      throw new Error("Thread ID and Checkpoint ID must be defined");
    }

    const [checkpointType, checkpointValue] = this.serde.dumpsTyped(checkpoint);
    const [metadataType, metadataValue] = this.serde.dumpsTyped(metadata);

    if (checkpointType !== metadataType) {
      throw new Error("Mismatched checkpoint and metadata types.");
    }

    const row: KVRow = {
      type: checkpointType,
      checkpoint: JSON.parse(
        new TextDecoder().decode(checkpointValue).replace(/\0/g, "")
      ),
      metadata: JSON.parse(
        new TextDecoder().decode(metadataValue).replace(/\0/g, "")
      ),
      parent_checkpoint_id: checkpoint_id,
    };

    // LUA script to set checkpoint data atomically
    const luaScript = `
      local prefix = ARGV[1]
      local checkpoint_id = ARGV[2]
      local row = ARGV[3]

      redis.call('SET', prefix .. ':' .. checkpoint_id, row)
      redis.call('SET', prefix .. ':last', row)
    `;

    // Save the checkpoint and the last checkpoint
    const prefix = `${thread_id}:${checkpoint_ns}`;
    await this.kv.eval(luaScript, [], [prefix, checkpoint.id, row]);

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
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

    const prefix = `PENDING_WRITES:${thread_id}:${checkpoint_ns}:${checkpoint_id}`;

    const values: Record<string, KVPendingWrite> = writes.reduce(
      (acc, [channel, value], idx) => {
        const key = `${prefix}:${taskId}:${idx}`;
        const [type, serializedValue] = this.serde.dumpsTyped(value);
        return {
          ...acc,
          [key]: {
            type,
            channel,
            task_id: taskId,
            value: JSON.parse(
              new TextDecoder().decode(serializedValue).replace(/\0/g, "")
            ),
          },
        };
      },
      {}
    );
    await this.kv.mset(values);
  }

  async flush(): Promise<void> {
    await this.kv.flushall();
  }
}
