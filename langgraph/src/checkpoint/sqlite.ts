import Database, { Database as DatabaseType } from "better-sqlite3";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointAt,
  CheckpointTuple,
  SerializerProtocol,
} from "./base.js";
import { NoopSerializer } from "./memory.js";

export class SqliteSaver extends BaseCheckpointSaver {
  serde = new NoopSerializer();

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
    if (!this.isSetup) {
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

    interface Row {
      checkpoint: Buffer;
      parentTs: string;
      threadId?: string;
      threadTs?: string;
    }

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
            parentConfig: {
              configurable: {
                threadId,
                threadTs: (row as Row).parentTs,
              },
            },
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
          parentConfig: {
            configurable: {
              threadId: (row as Row).threadId,
              threadTs: (row as Row).parentTs,
            },
          },
        };
      }
    }

    return undefined;
  }

  list(config: RunnableConfig): AsyncGenerator<CheckpointTuple> {
    throw new Error("Method not implemented.");
  }

  put(config: RunnableConfig, checkpoint: Checkpoint): Promise<RunnableConfig> {
    throw new Error("Method not implemented.");
  }
}
