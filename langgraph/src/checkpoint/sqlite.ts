import Database, { Database as DatabaseType } from "better-sqlite3";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from "./base.js";
import { SerializerProtocol } from "../serde/base.js";

// snake_case is used to match Python implementation
interface Row {
  checkpoint: string;
  metadata: string;
  parent_id?: string;
  thread_id: string;
  checkpoint_id: string;
}

export class SqliteSaver extends BaseCheckpointSaver {
  db: DatabaseType;

  protected isSetup: boolean;

  constructor(db: DatabaseType, serde?: SerializerProtocol<Checkpoint>) {
    super(serde);
    this.db = db;
    this.isSetup = false;
  }

  static fromConnString(connStringOrLocalPath: string): SqliteSaver {
    return new SqliteSaver(new Database(connStringOrLocalPath));
  }

  private setup(): void {
    if (this.isSetup) {
      return;
    }

    try {
      this.db.pragma("journal_mode=WAL");
      this.db.exec(`
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  parent_id TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_id)
);`);
    } catch (error) {
      console.log("Error creating checkpoints table", error);
      throw error;
    }

    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const thread_id = config.configurable?.thread_id;
    const checkpoint_id = config.configurable?.checkpoint_id;

    if (checkpoint_id) {
      try {
        const row: Row = this.db
          .prepare(
            `SELECT checkpoint, parent_id, metadata FROM checkpoints WHERE thread_id = ? AND checkpoint_id = ?`
          )
          .get(thread_id, checkpoint_id) as Row;

        if (row) {
          return {
            config,
            checkpoint: this.serde.parse(row.checkpoint) as Checkpoint,
            metadata: this.serde.parse(row.metadata) as CheckpointMetadata,
            parentConfig: row.parent_id
              ? {
                  configurable: {
                    thread_id,
                    checkpoint_id: row.parent_id,
                  },
                }
              : undefined,
          };
        }
      } catch (error) {
        console.log("Error retrieving checkpoint", error);
        throw error;
      }
    } else {
      const row: Row = this.db
        .prepare(
          `SELECT thread_id, checkpoint_id, parent_id, checkpoint, metadata FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC LIMIT 1`
        )
        .get(thread_id) as Row;

      if (row) {
        return {
          config: {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_id: row.checkpoint_id,
            },
          },
          checkpoint: this.serde.parse(row.checkpoint) as Checkpoint,
          metadata: this.serde.parse(row.metadata) as CheckpointMetadata,
          parentConfig: row.parent_id
            ? {
                configurable: {
                  thread_id: row.thread_id,
                  checkpoint_id: row.parent_id,
                },
              }
            : undefined,
        };
      }
    }

    return undefined;
  }

  async *list(config: RunnableConfig): AsyncGenerator<CheckpointTuple> {
    this.setup();
    const thread_id = config.configurable?.thread_id;

    try {
      const rows: Row[] = this.db
        .prepare(
          `SELECT thread_id, checkpoint_id, parent_id, checkpoint, metadata FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC`
        )
        .all(thread_id) as Row[];

      if (rows) {
        for (const row of rows) {
          yield {
            config: {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_id: row.checkpoint_id,
              },
            },
            checkpoint: this.serde.parse(row.checkpoint) as Checkpoint,
            metadata: this.serde.parse(row.metadata) as CheckpointMetadata,
            parentConfig: row.parent_id
              ? {
                  configurable: {
                    thread_id: row.thread_id,
                    checkpoint_id: row.parent_id,
                  },
                }
              : undefined,
          };
        }
      }
    } catch (error) {
      console.log("Error listing checkpoints", error);
      throw error;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    this.setup();

    try {
      const row = [
        config.configurable?.thread_id,
        checkpoint.id,
        config.configurable?.checkpoint_id,
        this.serde.stringify(checkpoint),
        this.serde.stringify(metadata),
      ];

      this.db
        .prepare(
          `INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_id, parent_id, checkpoint, metadata) VALUES (?, ?, ?, ?, ?)`
        )
        .run(...row);
    } catch (error) {
      console.log("Error saving checkpoint", error);
      throw error;
    }

    return {
      configurable: {
        thread_id: config.configurable?.thread_id,
        checkpoint_id: checkpoint.id,
      },
    };
  }
}
