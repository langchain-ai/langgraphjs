import Database, { Database as DatabaseType } from "better-sqlite3";
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

export class SqliteSaver extends BaseCheckpointSaver {
  db: DatabaseType;

  protected isSetup: boolean;

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

    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};
    let row: CheckpointRow;
    if (checkpoint_id) {
      row = this.db
        .prepare(
          `SELECT thread_id, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
        )
        .get(thread_id, checkpoint_ns, checkpoint_id) as CheckpointRow;
    } else {
      row = this.db
        .prepare(
          `SELECT thread_id, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1`
        )
        .get(thread_id, checkpoint_ns) as CheckpointRow;
    }
    if (row === undefined) {
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
    const pendingWritesRows = this.db
      .prepare(
        `SELECT task_id, channel, type, value FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
      )
      .all(
        finalConfig.configurable.thread_id.toString(),
        checkpoint_ns,
        finalConfig.configurable.checkpoint_id.toString()
      ) as WritesRow[];
    const pendingWrites = await Promise.all(
      pendingWritesRows.map(async (row) => {
        return [
          row.task_id,
          row.channel,
          await this.serde.loadsTyped(row.type ?? "json", row.value ?? ""),
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
    this.setup();
    const thread_id = config.configurable?.thread_id;
    let sql = `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata FROM checkpoints WHERE thread_id = ? ${
      before ? "AND checkpoint_id < ?" : ""
    } ORDER BY checkpoint_id DESC`;
    if (limit) {
      sql += ` LIMIT ${limit}`;
    }
    const args = [thread_id, before?.configurable?.checkpoint_id].filter(
      Boolean
    );

    const rows: CheckpointRow[] = this.db
      .prepare(sql)
      .all(...args) as CheckpointRow[];

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
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    this.setup();

    const [type1, serializedCheckpoint] = this.serde.dumpsTyped(checkpoint);
    const [type2, serializedMetadata] = this.serde.dumpsTyped(metadata);
    if (type1 !== type2) {
      throw new Error(
        "Failed to serialized checkpoint and metadata to the same type."
      );
    }
    const row = [
      config.configurable?.thread_id?.toString(),
      config.configurable?.checkpoint_ns,
      checkpoint.id,
      config.configurable?.checkpoint_id,
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
        thread_id: config.configurable?.thread_id,
        checkpoint_ns: config.configurable?.checkpoint_ns,
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

    const rows = writes.map((write, idx) => {
      const [type, serializedWrite] = this.serde.dumpsTyped(write[1]);
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
    });

    transaction(rows);
  }
}
