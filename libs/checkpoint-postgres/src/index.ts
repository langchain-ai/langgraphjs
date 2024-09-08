import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import pg from "pg";

const { Pool } = pg;

interface CheckpointRow {
  checkpoint: Buffer;
  metadata: Buffer;
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
  value?: Buffer;
}

export class PostgresSaver extends BaseCheckpointSaver {
  private pool: pg.Pool;

  protected isSetup: boolean;

  constructor(pool: pg.Pool, serde?: SerializerProtocol) {
    super(serde);
    this.pool = pool;
    this.isSetup = false;
  }

  static fromConnString(connString: string): PostgresSaver {
    const pool = new Pool({ connectionString: connString });
    return new PostgresSaver(pool);
  }

  protected async setup(): Promise<void> {
    if (this.isSetup) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          thread_id TEXT NOT NULL,
          checkpoint_ns TEXT NOT NULL DEFAULT '',
          checkpoint_id TEXT NOT NULL,
          parent_checkpoint_id TEXT,
          type TEXT,
          checkpoint BYTEA NOT NULL,
          metadata BYTEA NOT NULL,
          PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS writes (
          thread_id TEXT NOT NULL,
          checkpoint_ns TEXT NOT NULL DEFAULT '',
          checkpoint_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          idx INTEGER NOT NULL,
          channel TEXT NOT NULL,
          type TEXT,
          value BYTEA,
          PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
        )`);
      this.isSetup = true;
    } finally {
      client.release();
    }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.setup();
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};

    let row: CheckpointRow | undefined;
    if (checkpoint_id) {
      const result = await this.pool.query<CheckpointRow>(
        `SELECT thread_id, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
         FROM checkpoints
         WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3`,
        [thread_id, checkpoint_ns, checkpoint_id]
      );
      [row] = result.rows;
      // row = result.rows[0];
    } else {
      const result = await this.pool.query<CheckpointRow>(
        `SELECT thread_id, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
         FROM checkpoints
         WHERE thread_id = $1 AND checkpoint_ns = $2
         ORDER BY checkpoint_id DESC LIMIT 1`,
        [thread_id, checkpoint_ns]
      );
      [row] = result.rows;
      // row = result.rows[0];
    }

    if (!row) {
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

    const pendingWritesResult = await this.pool.query<WritesRow>(
      `SELECT task_id, channel, type, value
       FROM writes
       WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3`,
      [
        finalConfig.configurable.thread_id.toString(),
        checkpoint_ns,
        finalConfig.configurable.checkpoint_id.toString(),
      ]
    );

    const pendingWrites = await Promise.all(
      pendingWritesResult.rows.map(async (writeRow) => {
        return [
          writeRow.task_id,
          writeRow.channel,
          await this.serde.loadsTyped(
            writeRow.type ?? "json",
            writeRow.value ?? Buffer.from("")
          ),
        ] as [string, string, unknown];
      })
    );

    return {
      config: finalConfig,
      checkpoint: (await this.serde.loadsTyped(
        row.type ?? "json",
        row.checkpoint
      )) as Checkpoint,
      metadata: (await this.serde.loadsTyped(
        row.type ?? "json",
        row.metadata
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
    const { limit, before } = options ?? {};
    await this.setup();

    const thread_id = config.configurable?.thread_id;
    let sql = `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
               FROM checkpoints
               WHERE thread_id = $1 ${before ? "AND checkpoint_id < $2" : ""}
               ORDER BY checkpoint_id DESC`;
    const params = before
      ? [thread_id, before.configurable?.checkpoint_id]
      : [thread_id];

    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    const result = await this.pool.query<CheckpointRow>(sql, params);

    for (const row of result.rows) {
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
          row.checkpoint
        )) as Checkpoint,
        metadata: (await this.serde.loadsTyped(
          row.type ?? "json",
          row.metadata
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

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    await this.setup();

    const [type1, serializedCheckpoint] = this.serde.dumpsTyped(checkpoint);
    const [type2, serializedMetadata] = this.serde.dumpsTyped(metadata);
    if (type1 !== type2) {
      throw new Error(
        "Failed to serialize checkpoint and metadata to the same type."
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id)
         DO UPDATE SET parent_checkpoint_id = EXCLUDED.parent_checkpoint_id,
                       type = EXCLUDED.type,
                       checkpoint = EXCLUDED.checkpoint,
                       metadata = EXCLUDED.metadata`,
        [
          config.configurable?.thread_id?.toString() ?? "",
          config.configurable?.checkpoint_ns ?? "",
          checkpoint.id,
          config.configurable?.checkpoint_id ?? null,
          type1,
          Buffer.from(serializedCheckpoint),
          Buffer.from(serializedMetadata),
        ]
      );

      return {
        configurable: {
          thread_id: config.configurable?.thread_id,
          checkpoint_ns: config.configurable?.checkpoint_ns ?? "",
          checkpoint_id: checkpoint.id,
        },
      };
    } finally {
      client.release();
    }
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    await this.setup();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const stmt = `
        INSERT INTO writes
        (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO UPDATE
        SET channel = EXCLUDED.channel,
            type = EXCLUDED.type,
            value = EXCLUDED.value`;

      for (const [idx, write] of writes.entries()) {
        const [type, serializedWrite] = this.serde.dumpsTyped(write[1]);
        await client.query(stmt, [
          config.configurable?.thread_id,
          config.configurable?.checkpoint_ns,
          config.configurable?.checkpoint_id,
          taskId,
          idx,
          write[0],
          type,
          serializedWrite,
        ]);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
