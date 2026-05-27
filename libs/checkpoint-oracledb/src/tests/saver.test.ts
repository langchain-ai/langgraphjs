import { describe, expect, test } from "vitest";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";

import { OracleCheckpointSaver, type OracleConnectionLike } from "../saver.js";

class FakeConnection implements OracleConnectionLike {
  constructor(
    private readonly options: {
      failFirstExecute?: boolean;
      failFirstMergeDuplicate?: boolean;
      delayCheckpointWrites?: boolean;
    } = {}
  ) {}

  private didFail = false;

  mergeAttempts = 0;

  activeCheckpointWriteExecutions = 0;

  maxConcurrentCheckpointWriteExecutions = 0;

  async execute<RowT = Record<string, unknown>>(
    sql: string
  ): Promise<{ rows?: RowT[]; rowsAffected?: number }> {
    if (this.options.failFirstExecute && !this.didFail) {
      this.didFail = true;
      throw new Error("boom");
    }

    if (sql.includes("MERGE INTO")) {
      this.mergeAttempts += 1;
      if (this.options.failFirstMergeDuplicate && this.mergeAttempts === 1) {
        const error = new Error("duplicate") as Error & { errorNum: number };
        error.errorNum = 1;
        throw error;
      }
    }

    if (sql.includes("SELECT v")) {
      const error = new Error("table missing") as Error & { errorNum: number };
      error.errorNum = 942;
      throw error;
    }

    if (sql.includes("user_tab_columns")) {
      return { rows: [{ DATA_TYPE: "BLOB" } as RowT] };
    }

    if (
      this.options.delayCheckpointWrites &&
      /CHECKPOINT_WRITES/i.test(sql)
    ) {
      this.activeCheckpointWriteExecutions += 1;
      this.maxConcurrentCheckpointWriteExecutions = Math.max(
        this.maxConcurrentCheckpointWriteExecutions,
        this.activeCheckpointWriteExecutions
      );
      try {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      } finally {
        this.activeCheckpointWriteExecutions -= 1;
      }
    }

    return {};
  }

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}

  async close(): Promise<void> {}
}

describe("OracleCheckpointSaver", () => {
  test("resets setupPromise after setup failure", async () => {
    const connections = [
      new FakeConnection({ failFirstExecute: true }),
      new FakeConnection(),
    ];
    const saver = new OracleCheckpointSaver({
      pool: {
        async getConnection() {
          const connection = connections.shift();
          if (!connection) throw new Error("no fake connections left");
          return connection;
        },
      },
    });

    await expect(saver.setup()).rejects.toThrow("boom");
    await expect(saver.setup()).resolves.toBeUndefined();
  });

  test("retries checkpoint upsert once after ORA-00001", async () => {
    const connection = new FakeConnection({ failFirstMergeDuplicate: true });
    const saver = new OracleCheckpointSaver({
      pool: {
        async getConnection() {
          return connection;
        },
      },
    });
    await saver.setup();

    await expect(
      saver.put(
        { configurable: { thread_id: "thread-1" } },
        emptyCheckpoint(),
        { source: "update", step: -1, parents: {} },
        {}
      )
    ).resolves.toMatchObject({
      configurable: { thread_id: "thread-1" },
    });
    expect(connection.mergeAttempts).toBe(2);
  });

  test("serializes operations on caller-supplied raw connections", async () => {
    const connection = new FakeConnection({ delayCheckpointWrites: true });
    const saver = new OracleCheckpointSaver({ connection });
    await saver.setup();

    await Promise.all([
      saver.putWrites(
        {
          configurable: {
            thread_id: "thread-raw",
            checkpoint_id: "checkpoint-1",
          },
        },
        [["events", { sequence: 1 }]],
        "task-1"
      ),
      saver.putWrites(
        {
          configurable: {
            thread_id: "thread-raw",
            checkpoint_id: "checkpoint-1",
          },
        },
        [["events", { sequence: 2 }]],
        "task-2"
      ),
    ]);

    expect(connection.maxConcurrentCheckpointWriteExecutions).toBe(1);
  });
});
