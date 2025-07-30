import Database, { Database as DatabaseType, Statement } from "better-sqlite3";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
  TASKS,
  copyCheckpoint,
  maxChannelVersion,
} from "@langchain/langgraph-checkpoint";

interface CheckpointRow {
  checkpoint: string;
  metadata: string;
  parent_checkpoint_id?: string;
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns?: string;
  type?: string;
  pending_writes: string;
}

interface PendingWriteColumn {
  task_id: string;
  channel: string;
  type: string;
  value: string;
}

interface PendingSendColumn {
  type: string;
  value: string;
}

// In the `SqliteSaver.list` method, we need to sanitize the `options.filter` argument to ensure it only contains keys
// that are part of the `CheckpointMetadata` type. The lines below ensure that we get compile-time errors if the list
// of keys that we use is out of sync with the `CheckpointMetadata` type.
const checkpointMetadataKeys = ["source", "step", "parents"] as const;

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

function prepareSql(db: DatabaseType, checkpointId: boolean) {
  const sql = `
  SELECT
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    parent_checkpoint_id,
    type,
    checkpoint,
    metadata,
    (
      SELECT
        json_group_array(
          json_object(
            'task_id', pw.task_id,
            'channel', pw.channel,
            'type', pw.type,
            'value', CAST(pw.value AS TEXT)
          )
        )
      FROM writes as pw
      WHERE pw.thread_id = checkpoints.thread_id
        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
        AND pw.checkpoint_id = checkpoints.checkpoint_id
    ) as pending_writes,
    (
      SELECT
        json_group_array(
          json_object(
            'type', ps.type,
            'value', CAST(ps.value AS TEXT)
          )
        )
      FROM writes as ps
      WHERE ps.thread_id = checkpoints.thread_id
        AND ps.checkpoint_ns = checkpoints.checkpoint_ns
        AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
        AND ps.channel = '${TASKS}'
      ORDER BY ps.idx
    ) as pending_sends
  FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? ${
    checkpointId
      ? "AND checkpoint_id = ?"
      : "ORDER BY checkpoint_id DESC LIMIT 1"
  }`;

  return db.prepare(sql);
}

export class SqliteSaver extends BaseCheckpointSaver {
  db: DatabaseType;

  protected isSetup: boolean;

  protected withoutCheckpoint: Statement;

  protected withCheckpoint: Statement;

  constructor(db: DatabaseType, serde?: SerializerProtocol) {
    super(serde);
    this.db = db;
    this.isSetup = false;
  }

  static fromConnString(connStringOrLocalPath: string): SqliteSaver {
    return new SqliteSaver(new Database(connStringOrLocalPath));
  }

  protected setup(): void {
    if (this.isSetup) {
      return;
    }

    this.db.pragma("journal_mode=WAL");
    this.db.exec(`
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);`);
    this.db.exec(`
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);`);

    this.withoutCheckpoint = prepareSql(this.db, false);
    this.withCheckpoint = prepareSql(this.db, true);

    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};

    const args = [thread_id, checkpoint_ns];
    if (checkpoint_id) args.push(checkpoint_id);

    const stm = checkpoint_id ? this.withCheckpoint : this.withoutCheckpoint;
    const row = stm.get(...args) as CheckpointRow;
    if (row === undefined) return undefined;

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

    const pendingWrites = await Promise.all(
      (JSON.parse(row.pending_writes) as PendingWriteColumn[]).map(
        async (write) => {
          return [
            write.task_id,
            write.channel,
            await this.serde.loadsTyped(
              write.type ?? "json",
              write.value ?? ""
            ),
          ] as [string, string, unknown];
        }
      )
    );

    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint
    )) as Checkpoint;

    if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(
        checkpoint,
        row.thread_id,
        row.parent_checkpoint_id
      );
    }

    return {
      checkpoint,
      config: finalConfig,
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
    const { limit, before, filter } = options ?? {};
    this.setup();
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;
    let sql = `
      SELECT
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        parent_checkpoint_id,
        type,
        checkpoint,
        metadata,
        (
          SELECT
            json_group_array(
              json_object(
                'task_id', pw.task_id,
                'channel', pw.channel,
                'type', pw.type,
                'value', CAST(pw.value AS TEXT)
              )
            )
          FROM writes as pw
          WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns
            AND pw.checkpoint_id = checkpoints.checkpoint_id
        ) as pending_writes,
        (
          SELECT
            json_group_array(
              json_object(
                'type', ps.type,
                'value', CAST(ps.value AS TEXT)
              )
            )
          FROM writes as ps
          WHERE ps.thread_id = checkpoints.thread_id
            AND ps.checkpoint_ns = checkpoints.checkpoint_ns
            AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        ) as pending_sends
      FROM checkpoints\n`;

    const whereClause: string[] = [];

    if (thread_id) {
      whereClause.push("thread_id = ?");
    }

    if (checkpoint_ns !== undefined && checkpoint_ns !== null) {
      whereClause.push("checkpoint_ns = ?");
    }

    if (before?.configurable?.checkpoint_id !== undefined) {
      whereClause.push("checkpoint_id < ?");
    }

    const sanitizedFilter = Object.fromEntries(
      Object.entries(filter ?? {}).filter(
        ([key, value]) =>
          value !== undefined &&
          validCheckpointMetadataKeys.includes(key as keyof CheckpointMetadata)
      )
    );

    whereClause.push(
      ...Object.entries(sanitizedFilter).map(
        ([key]) => `jsonb(CAST(metadata AS TEXT))->'$.${key}' = ?`
      )
    );

    if (whereClause.length > 0) {
      sql += `WHERE\n  ${whereClause.join(" AND\n  ")}\n`;
    }

    sql += "\nORDER BY checkpoint_id DESC";

    if (limit) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sql += ` LIMIT ${parseInt(limit as any, 10)}`; // parseInt here (with cast to make TS happy) to sanitize input, as limit may be user-provided
    }

    const args = [
      thread_id,
      checkpoint_ns,
      before?.configurable?.checkpoint_id,
      ...Object.values(sanitizedFilter).map((value) => JSON.stringify(value)),
    ].filter((value) => value !== undefined && value !== null);

    const rows: CheckpointRow[] = this.db
      .prepare(sql)
      .all(...args) as CheckpointRow[];

    if (rows) {
      for (const row of rows) {
        const pendingWrites = await Promise.all(
          (JSON.parse(row.pending_writes) as PendingWriteColumn[]).map(
            async (write) => {
              return [
                write.task_id,
                write.channel,
                await this.serde.loadsTyped(
                  write.type ?? "json",
                  write.value ?? ""
                ),
              ] as [string, string, unknown];
            }
          )
        );

        const checkpoint = (await this.serde.loadsTyped(
          row.type ?? "json",
          row.checkpoint
        )) as Checkpoint;

        if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
          await this.migratePendingSends(
            checkpoint,
            row.thread_id,
            row.parent_checkpoint_id
          );
        }

        yield {
          config: {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.checkpoint_id,
            },
          },
          checkpoint,
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
          pendingWrites,
        };
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    this.setup();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }

    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    const parent_checkpoint_id = config.configurable?.checkpoint_id;

    if (!thread_id) {
      throw new Error(
        `Missing "thread_id" field in passed "config.configurable".`
      );
    }

    const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);

    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(preparedCheckpoint),
        this.serde.dumpsTyped(metadata),
      ]);

    if (type1 !== type2) {
      throw new Error(
        "Failed to serialized checkpoint and metadata to the same type."
      );
    }
    const row = [
      thread_id,
      checkpoint_ns,
      checkpoint.id,
      parent_checkpoint_id,
      type1,
      serializedCheckpoint,
      serializedMetadata,
    ];

    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...row);

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    this.setup();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }

    if (!config.configurable?.thread_id) {
      throw new Error("Missing thread_id field in config.configurable.");
    }

    if (!config.configurable?.checkpoint_id) {
      throw new Error("Missing checkpoint_id field in config.configurable.");
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO writes 
      (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((rows) => {
      for (const row of rows) {
        stmt.run(...row);
      }
    });

    const rows = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);
        return [
          config.configurable?.thread_id,
          config.configurable?.checkpoint_ns,
          config.configurable?.checkpoint_id,
          taskId,
          idx,
          write[0],
          type,
          serializedWrite,
        ];
      })
    );

    transaction(rows);
  }

  async deleteThread(threadId: string) {
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM checkpoints WHERE thread_id = ?`)
        .run(threadId);
      this.db.prepare(`DELETE FROM writes WHERE thread_id = ?`).run(threadId);
    });

    transaction();
  }

  protected async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentCheckpointId: string
  ) {
    const { pending_sends } = this.db
      .prepare(
        `
          SELECT
            checkpoint_id,
            json_group_array(
              json_object(
                'type', ps.type,
                'value', CAST(ps.value AS TEXT)
              )
            ) as pending_sends
          FROM writes as ps
          WHERE ps.thread_id = ?
            AND ps.checkpoint_id = ?
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        `
      )
      .get(threadId, parentCheckpointId) as { pending_sends: string };

    const mutableCheckpoint = checkpoint;

    // add pending sends to checkpoint
    mutableCheckpoint.channel_values ??= {};
    mutableCheckpoint.channel_values[TASKS] = await Promise.all(
      JSON.parse(pending_sends).map(({ type, value }: PendingSendColumn) =>
        this.serde.loadsTyped(type, value)
      )
    );

    // add to versions
    mutableCheckpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }
}
