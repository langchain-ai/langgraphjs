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

// In the `SqliteSaver.list` method, we need to sanitize the `options.filter` argument to ensure it only contains keys
// that are part of the `CheckpointMetadata` type. The lines below ensure that we get compile-time errors if the list
// of keys that we use is out of sync with the `CheckpointMetadata` type.
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

// If this line fails to compile, the list of keys that we use in the `SqliteSaver.list` method is out of sync with the
// `CheckpointMetadata` type. In that case, just update `checkpointMetadataKeys` to contain all the keys in
// `CheckpointMetadata`
const validCheckpointMetadataKeys = validateKeys<
  CheckpointMetadata,
  typeof checkpointMetadataKeys
>(checkpointMetadataKeys);

export class SupaSaver extends BaseCheckpointSaver {
  constructor(private client: SupabaseClient, serde?: SerializerProtocol) {
    super(serde);
  }

  protected _dumpMetadata(metadata: CheckpointMetadata) {
    const [, serializedMetadata] = this.serde.dumpsTyped(metadata);
    // We need to remove null characters before writing
    return JSON.parse(
      new TextDecoder().decode(serializedMetadata).replace(/\0/g, "")
    );
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};

    let res;

    if (checkpoint_id) {
      res = await this.client
        .from("langgraph_checkpoints")
        .select()
        .eq("checkpoint_id", checkpoint_id)
        .eq("thread_id", thread_id)
        .eq("checkpoint_ns", checkpoint_ns)
        .throwOnError();
    } else {
      res = await this.client
        .from("langgraph_checkpoints")
        .select()
        .eq("thread_id", thread_id)
        .eq("checkpoint_ns", checkpoint_ns)
        .order("checkpoint_id", { ascending: false })
        .throwOnError();
    }

    const rows = res.data as CheckpointRow[];

    const row = rows[0];
    if (row == null) {
      return undefined;
    }

    let finalConfig = config;
    if (!checkpoint_id) {
      finalConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      };
    }

    if (
      finalConfig.configurable?.thread_id === undefined ||
      finalConfig.configurable?.checkpoint_id === undefined
    ) {
      throw new Error("Missing thread_id or checkpoint_id");
    }

    // find any pending writes
    // const pendingWritesRows = this.db
    //   .prepare(
    //     `SELECT task_id, channel, type, value FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
    //   )
    //   .all(
    //     finalConfig.configurable.thread_id.toString(),
    //     checkpoint_ns,
    //     finalConfig.configurable.checkpoint_id.toString()
    //   ) as WritesRow[];

    const pendingWritesRes = await this.client
      .from("langgraph_writes")
      .select()
      .eq("thread_id", finalConfig.configurable.thread_id.toString())
      .eq("checkpoint_ns", checkpoint_ns)
      .eq("checkpoint_id", finalConfig.configurable.checkpoint_id.toString())
      .throwOnError();

    const pendingWritesRows = (pendingWritesRes.data ?? []) as WritesRow[];
    const pendingWrites = await Promise.all(
      pendingWritesRows.map(async (row: WritesRow) => {
        return [
          row.task_id,
          row.channel,
          await this.serde.loadsTyped(
            row.type ?? "json",
            JSON.stringify(row.value) ?? ""
          ),
        ] as [string, string, unknown];
      })
    );

    return {
      config: finalConfig,
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
              checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;

    let query = this.client.from("langgraph_checkpoints").select("*");

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
      .from("langgraph_checkpoints")
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
        .from("langgraph_writes")
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