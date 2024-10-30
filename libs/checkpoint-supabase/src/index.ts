import type { SupabaseClient } from "@supabase/supabase-js";

import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";

interface CheckpointRow {
  checkpoint: string;
  metadata: string;
  parent_checkpoint_id?: string;
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns?: string;
  type?: string;
}

interface WritesRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type?: string;
  value?: string;
}

const DEFAULT_TYPE = 'json' as const;
const checkpointMetadataKeys = ["source", "step", "writes", "parents"] as const;

type CheckKeys<T, K extends readonly (keyof T)[]> = [K[number]] extends [
  keyof T
]
  ? [keyof T] extends [K[number]]
    ? K
    : never
  : never;

function validateKeys<T, K extends readonly (keyof T)[]>(
  keys: CheckKeys<T, K>
): K {
  return keys;
}

const validCheckpointMetadataKeys = validateKeys<
  CheckpointMetadata,
  typeof checkpointMetadataKeys
>(checkpointMetadataKeys);

export class SupabaseSaver extends BaseCheckpointSaver {

  private options: {
    checkPointTable: string;
    writeTable: string;
  } = {
    checkPointTable: "langgraph_checkpoints",
    writeTable: "langgraph_writes",
  };

  constructor(private client: SupabaseClient, config?: {
    checkPointTable?: string;
    writeTable?: string;
  },serde?: SerializerProtocol) {
    super(serde);
    
    // Apply config
    if (config) {
      this.options = {
        ...this.options,
        ...config,
      };
    }
  }

  protected _dumpMetadata(metadata: CheckpointMetadata): unknown {
    const [, serializedMetadata] = this.serde.dumpsTyped(metadata);
    return this.parseAndCleanJson(serializedMetadata);
  }

  private parseAndCleanJson(data: Uint8Array): unknown {
    return JSON.parse(
      new TextDecoder().decode(data).replace(/\0/g, "")
    );
  }

  private validateConfig(config: RunnableConfig): asserts config is Required<RunnableConfig> {
    if (!config.configurable?.thread_id || !config.configurable?.checkpoint_id) {
      throw new Error("Missing required config: thread_id or checkpoint_id");
    }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    
    const query = this.client
      .from(this.options.checkPointTable)
      .select()
      .eq("thread_id", thread_id)
      .eq("checkpoint_ns", checkpoint_ns);

    const res = await (checkpoint_id 
      ? query.eq("checkpoint_id", checkpoint_id)
      : query.order("checkpoint_id", { ascending: false })
    ).throwOnError();

    const [row] = res.data as CheckpointRow[];
    if (!row) return undefined;

    const finalConfig = !checkpoint_id ? {
      configurable: {
        thread_id: row.thread_id,
        checkpoint_ns,
        checkpoint_id: row.checkpoint_id,
      },
    } : config;

    this.validateConfig(finalConfig);

    const pendingWrites = await this.fetchPendingWrites(
      finalConfig.configurable.thread_id,
      checkpoint_ns,
      finalConfig.configurable.checkpoint_id
    );

    return {
      config: finalConfig,
      checkpoint: await this.deserializeField(row.type, row.checkpoint) as Checkpoint,
      metadata: await this.deserializeField(row.type, row.metadata) as CheckpointMetadata,
      parentConfig: row.parent_checkpoint_id ? {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id,
        },
      } : undefined,
      pendingWrites,
    };
  }

  private async deserializeField(type: string | undefined, value: string): Promise<unknown> {
    return this.serde.loadsTyped(
      type ?? DEFAULT_TYPE,
      JSON.stringify(value)
    );
  }

  private async fetchPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<[string, string, unknown][]> {
    const { data } = await this.client
      .from(this.options.writeTable)
      .select()
      .eq("thread_id", threadId)
      .eq("checkpoint_ns", checkpointNs)
      .eq("checkpoint_id", checkpointId)
      .throwOnError();

    const rows = data as WritesRow[];
    return Promise.all(
      rows.map(async (row) => [
        row.task_id,
        row.channel,
        await this.deserializeField(row.type, row.value ?? ""),
      ])
    );
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;

    let query = this.client.from(this.options.checkPointTable).select("*");

    if (thread_id !== undefined && thread_id !== null) {
      query = query.eq("thread_id", thread_id);
    }

    if (checkpoint_ns !== undefined && checkpoint_ns !== null) {
      query = query.eq("checkpoint_ns", checkpoint_ns);
    }

    if (before?.configurable?.checkpoint_id !== undefined) {
      query = query.lt("checkpoint_id", before.configurable.checkpoint_id);
    }

    const sanitizedFilter = Object.fromEntries(
      Object.entries(filter ?? {}).filter(
        ([key, value]) =>
          value !== undefined &&
          validCheckpointMetadataKeys.includes(key as keyof CheckpointMetadata)
      )
    );

    for (const [key, value] of Object.entries(sanitizedFilter)) {
      let searchObject = {} as any;
      searchObject[key] = value;
      query = query.eq(`metadata->>${key}`, value);
    }

    query = query.order("checkpoint_id", { ascending: false });

    if (limit) {
      query = query.limit(parseInt(limit as any, 10));
    }

    const { data: rows } = await query.throwOnError();

    if (rows === null) {
      throw new Error("Unexpected error listing checkpoints");
    }

    if (rows) {
      for (const row of rows) {
        yield {
          config: {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.checkpoint_id,
            },
          },
          checkpoint: (await this.serde.loadsTyped(
            row.type ?? "json",
            JSON.stringify(row.checkpoint)
          )) as Checkpoint,
          metadata: (await this.serde.loadsTyped(
            row.type ?? "json",
            JSON.stringify(row.metadata)
          )) as CheckpointMetadata,
          parentConfig: row.parent_checkpoint_id
            ? {
                configurable: {
                  thread_id: row.thread_id,
                  checkpoint_ns: row.checkpoint_ns,
                  checkpoint_id: row.parent_checkpoint_id,
                },
              }
            : undefined,
        };
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    await this.client
      .from(this.options.checkPointTable)
      .upsert(
        {
          thread_id: config.configurable?.thread_id,
          checkpoint_ns: config.configurable?.checkpoint_ns,
          checkpoint_id: checkpoint.id,
          parent_checkpoint_id: config.configurable?.checkpoint_id,
          type: "json",
          checkpoint: checkpoint,
          metadata: metadata,
        }
      )
      .throwOnError();

    return {
      configurable: {
        thread_id: config.configurable?.thread_id,
        checkpoint_ns: config.configurable?.checkpoint_ns ?? "",
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
    const checkpoint_id = config.configurable?.checkpoint_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;

    // Process writes sequentially
    for (const [idx, write] of writes.entries()) {
      const [, serializedWrite] = this.serde.dumpsTyped(write[1]);

      await this.client
        .from(this.options.writeTable)
        .upsert(
          [
            {
              thread_id,
              checkpoint_ns,
              checkpoint_id,
              task_id: taskId,
              idx,
              channel: write[0],
              type: "json",
              value: JSON.parse(
                new TextDecoder().decode(serializedWrite).replace(/\0/g, "")
              ),
            },
          ]
        )
        .throwOnError();
    }
  }
}