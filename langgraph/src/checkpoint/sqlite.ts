import Database, { Database as DatabaseType } from "better-sqlite3";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointAt,
  CheckpointTuple,
  SerializerProtocol,
} from "./base.js";

export class JsonSerializer implements SerializerProtocol {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dumps(obj: any): string {
    return JSON.stringify(obj);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loads(data: string): any {
    return JSON.parse(data);
  }
}

interface Row {
  checkpoint: string;
  parentTs: string;
  threadId?: string;
  threadTs?: string;
}

export class SqliteSaver extends BaseCheckpointSaver {
  serde = new JsonSerializer();

  isSetup: boolean;

  db: DatabaseType;

  constructor(
    connStringOrLocalPath: string,
    serde?: SerializerProtocol,
    at?: CheckpointAt
  ) {
    super(serde, at);
    this.isSetup = false;
    this.db = new Database(connStringOrLocalPath);
  }

  static fromConnString(connStringOrLocalPath: string): SqliteSaver {
    return new SqliteSaver(connStringOrLocalPath);
  }

  async setup(): Promise<void> {
    if (this.isSetup) {
      return;
    }

    try {
      this.db.exec(`
CREATE TABLE IF NOT EXISTS checkpoints (
  threadId TEXT NOT NULL,
  threadTs TEXT NOT NULL,
  parentTs TEXT,
  checkpoint BLOB,
  PRIMARY KEY (threadId, threadTs)
);`);
    } catch (error) {
      console.log("Error creating checkpoints table", error);
      throw error;
    }

    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.threadId;
    const ts = config.configurable?.threadTs;

    if (ts) {
      try {
        const row: Row | unknown = this.db
          .prepare(
            `SELECT checkpoint, parentTs FROM checkpoints WHERE threadId = ? AND threadTs = ?`
          )
          .get(threadId, ts);
        if (row) {
          return {
            config,
            checkpoint: this.serde.loads((row as Row).checkpoint),
            parentConfig: (row as Row).parentTs
              ? {
                  configurable: {
                    threadId,
                    threadTs: (row as Row).parentTs,
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
      const row: Row | unknown = this.db
        .prepare(
          `SELECT threadId, threadTs, parentTs, checkpoint FROM checkpoints WHERE threadId = ? ORDER BY threadTs DESC LIMIT 1`
        )
        .get(threadId);
      if (row) {
        return {
          config: {
            configurable: {
              threadId: (row as Row).threadId,
              threadTs: (row as Row).threadTs,
            },
          },
          checkpoint: this.serde.loads((row as Row).checkpoint),
          parentConfig: (row as Row)
            ? {
                configurable: {
                  threadId: (row as Row).threadId,
                  threadTs: (row as Row).parentTs,
                },
              }
            : undefined,
        };
      }
    }

    return undefined;
  }

  async *list(config: RunnableConfig): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.threadId;
    try {
      const rows: Row[] | unknown = this.db
        .prepare(
          `SELECT threadId, threadTs, parentTs, checkpoint FROM checkpoints WHERE threadId = ? ORDER BY threadTs DESC`
        )
        .all(threadId);
      if (rows) {
        for (const row of rows as Row[]) {
          yield {
            config: {
              configurable: { threadId: row.threadId, threadTs: row.threadTs },
            },
            checkpoint: this.serde.loads(row.checkpoint),
            parentConfig: (row as Row).parentTs
              ? {
                  configurable: {
                    threadId: (row as Row).threadId,
                    threadTs: (row as Row).parentTs,
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
    try {
      const row = [
        config.configurable?.threadId,
        checkpoint.ts,
        config.configurable?.threadTs,
        this.serde.dumps(checkpoint),
      ];
      this.db
        .prepare(
          `INSERT OR REPLACE INTO checkpoints (threadId, threadTs, parentTs, checkpoint) VALUES (?, ?, ?, ?)`
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
