import Database, { Database as DatabaseType } from "better-sqlite3";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointAt,
  CheckpointTuple,
  SerializerProtocol,
} from "./base.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class JsonSerializer implements SerializerProtocol<any, string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dumps(obj: any): string {
    return JSON.stringify(obj);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loads(data: string): any {
    return JSON.parse(data);
  }
}

// snake_case is used to match Python implementation
interface Row {
  checkpoint: string;
  parent_ts: string;
  thread_id?: string;
  thread_ts?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class SqliteSaver<D = any> extends BaseCheckpointSaver<D, string> {
  serde = new JsonSerializer();

  db: DatabaseType;

  isSetup: boolean;

  constructor(
    connStringOrLocalPath: string,
    serde?: SerializerProtocol<D, string>,
    at?: CheckpointAt
  ) {
    super(serde, at);
    this.db = new Database(connStringOrLocalPath);
    this.isSetup = false;
  }

  static fromConnString(connStringOrLocalPath: string): SqliteSaver {
    return new SqliteSaver(connStringOrLocalPath);
  }

  private async setup(): Promise<void> {
    if (this.isSetup) {
      return;
    }

    try {
      this.db.pragma("journal_mode=WAL");
      this.db.exec(`
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  parent_ts TEXT,
  checkpoint BLOB,
  PRIMARY KEY (thread_id, thread_ts)
);`);
    } catch (error) {
      console.log("Error creating checkpoints table", error);
      throw error;
    }

    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.setup();
    const threadId = config.configurable?.threadId;
    const threadTs = config.configurable?.threadTs;

    if (threadTs) {
      try {
        const row: Row = this.db
          .prepare(
            `SELECT checkpoint, parent_ts FROM checkpoints WHERE thread_id = ? AND thread_ts = ?`
          )
          .get(threadId, threadTs) as Row;

        if (row) {
          return {
            config,
            checkpoint: this.serde.loads(row.checkpoint),
            parentConfig: row.parent_ts
              ? {
                  configurable: {
                    threadId,
                    threadTs: row.parent_ts,
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
          `SELECT thread_id, thread_ts, parent_ts, checkpoint FROM checkpoints WHERE thread_id = ? ORDER BY thread_ts DESC LIMIT 1`
        )
        .get(threadId) as Row;

      if (row) {
        return {
          config: {
            configurable: {
              threadId: row.thread_id,
              threadTs: row.thread_ts,
            },
          },
          checkpoint: this.serde.loads(row.checkpoint),
          parentConfig: row.parent_ts
            ? {
                configurable: {
                  threadId: row.thread_id,
                  threadTs: row.parent_ts,
                },
              }
            : undefined,
        };
      }
    }

    return undefined;
  }

  async *list(config: RunnableConfig): AsyncGenerator<CheckpointTuple> {
    await this.setup();
    const threadId = config.configurable?.threadId;

    try {
      const rows: Row[] = this.db
        .prepare(
          `SELECT thread_id, thread_ts, parent_ts, checkpoint FROM checkpoints WHERE thread_id = ? ORDER BY thread_ts DESC`
        )
        .all(threadId) as Row[];

      if (rows) {
        for (const row of rows) {
          yield {
            config: {
              configurable: {
                threadId: row.thread_id,
                threadTs: row.thread_ts,
              },
            },
            checkpoint: this.serde.loads(row.checkpoint),
            parentConfig: row.parent_ts
              ? {
                  configurable: {
                    threadId: row.thread_id,
                    threadTs: row.parent_ts,
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
    checkpoint: Checkpoint
  ): Promise<RunnableConfig> {
    await this.setup();

    try {
      const row = [
        config.configurable?.threadId,
        checkpoint.ts,
        config.configurable?.threadTs,
        this.serde.dumps(checkpoint),
      ];

      this.db
        .prepare(
          `INSERT OR REPLACE INTO checkpoints (thread_id, thread_ts, parent_ts, checkpoint) VALUES (?, ?, ?, ?)`
        )
        .run(...row);
    } catch (error) {
      console.log("Error saving checkpoint", error);
      throw error;
    }

    return {
      configurable: {
        threadId: config.configurable?.threadId,
        threadTs: checkpoint.ts,
      },
    };
  }
}
