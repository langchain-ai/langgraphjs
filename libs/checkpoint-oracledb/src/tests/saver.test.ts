// Copyright (c) 2026, Oracle and/or its affiliates.
import { describe, expect, test } from "vitest";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";

import { OracleCheckpointSaver, type OracleConnectionLike } from "../saver.js";

class FakeConnection implements OracleConnectionLike {
  constructor(
    private readonly options: {
      failFirstExecute?: boolean;
      failFirstMergeDuplicate?: boolean;
      failNullableBlobAlreadyNullable?: boolean;
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

    if (
      this.options.failNullableBlobAlreadyNullable &&
      /\bMODIFY\s+blob\s+NULL\b/i.test(sql)
    ) {
      const error = new Error("column already nullable") as Error & {
        errorNum: number;
      };
      error.errorNum = 1451;
      throw error;
    }

    if (sql.includes("user_tab_columns")) {
      return { rows: [{ DATA_TYPE: "BLOB" } as RowT] };
    }

    if (this.options.delayCheckpointWrites && /CHECKPOINT_WRITES/i.test(sql)) {
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
  test("rejects fractional list limits with and without metadata filters", async () => {
    const saver = new OracleCheckpointSaver({
      connection: new FakeConnection(),
    });
    const config = { configurable: { thread_id: "thread-1" } };
    const expectedError =
      "Oracle checkpoint list limit must be a non-negative integer.";

    await expect(saver.list(config, { limit: 1.5 }).next()).rejects.toThrow(
      expectedError
    );
    await expect(
      saver.list(config, { filter: { source: "loop" }, limit: 1.5 }).next()
    ).rejects.toThrow(expectedError);
  });

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

  test("treats already-nullable checkpoint write blob migration as idempotent", async () => {
    const saver = new OracleCheckpointSaver({
      connection: new FakeConnection({
        failNullableBlobAlreadyNullable: true,
      }),
    });

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

  test("rejects empty Oracle key fields before database writes", async () => {
    const saver = new OracleCheckpointSaver({
      connection: new FakeConnection(),
    });
    await saver.setup();

    await expect(
      saver.put(
        { configurable: { thread_id: "thread-1" } },
        { ...emptyCheckpoint(), id: "" },
        { source: "update", step: -1, parents: {} },
        {}
      )
    ).rejects.toThrow(
      "Oracle checkpoint checkpoint_id must be a non-empty string."
    );

    await expect(
      saver.put(
        { configurable: { thread_id: "thread-1" } },
        {
          ...emptyCheckpoint(),
          channel_values: { "": "value" },
          channel_versions: { "": 1 },
        },
        { source: "update", step: -1, parents: {} },
        { "": 1 }
      )
    ).rejects.toThrow("Oracle checkpoint channel must be a non-empty string.");

    await expect(
      saver.putWrites(
        {
          configurable: {
            thread_id: "thread-1",
            checkpoint_id: "checkpoint-1",
          },
        },
        [["events", { ok: true }]],
        ""
      )
    ).rejects.toThrow("Oracle checkpoint task_id must be a non-empty string.");

    await expect(
      saver.putWrites(
        {
          configurable: {
            thread_id: "thread-1",
            checkpoint_id: "checkpoint-1",
          },
        },
        [["", { ok: true }]],
        "task-1"
      )
    ).rejects.toThrow(
      "Oracle checkpoint write channel must be a non-empty string."
    );

    await expect(saver.deleteThread("")).rejects.toThrow(
      "Oracle checkpoint thread_id must be a non-empty string."
    );
  });
});
