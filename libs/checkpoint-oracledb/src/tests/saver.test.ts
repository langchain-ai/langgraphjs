// Copyright (c) 2026, Oracle and/or its affiliates.
import { encode as encodeMessagePack } from "@msgpack/msgpack";
import oracledb from "oracledb";
import { describe, expect, test, vi } from "vitest";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";

import { OracleCheckpointSaver, type OracleConnectionLike } from "../saver.js";

function bindValue<T>(value: unknown): T {
  if (typeof value === "object" && value !== null && "val" in value) {
    return (value as { val: T }).val;
  }
  return value as T;
}

class FakeConnection implements OracleConnectionLike {
  constructor(
    private readonly options: {
      failFirstExecute?: boolean;
      failFirstMergeDuplicate?: boolean;
      failIndexAlreadyExists?: boolean;
      delayCheckpointWrites?: boolean;
      checkpointDataType?: "JSON" | "BLOB";
      latestMigrationVersion?: number;
      checkpointRows?: Record<string, unknown>[];
      blobRows?: Record<string, unknown>[];
      writeRows?: Record<string, unknown>[];
    } = {}
  ) {}

  private didFail = false;

  mergeAttempts = 0;

  activeCheckpointWriteExecutions = 0;

  maxConcurrentCheckpointWriteExecutions = 0;

  executions: { sql: string; binds?: Record<string, unknown> }[] = [];

  executeManyExecutions: {
    sql: string;
    binds: Record<string, unknown>[];
    options?: Record<string, unknown>;
  }[] = [];

  async execute<RowT = Record<string, unknown>>(
    sql: string,
    binds?: Record<string, unknown>
  ): Promise<{ rows?: RowT[]; rowsAffected?: number }> {
    this.executions.push({ sql, binds });
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
      if (this.options.latestMigrationVersion !== undefined) {
        return {
          rows: [
            { V: this.options.latestMigrationVersion } as RowT,
          ],
        };
      }
      const error = new Error("table missing") as Error & { errorNum: number };
      error.errorNum = 942;
      throw error;
    }

    if (
      this.options.failIndexAlreadyExists &&
      /\bCREATE\s+INDEX\b/i.test(sql)
    ) {
      const error = new Error("column list already indexed") as Error & {
        errorNum: number;
      };
      error.errorNum = 1408;
      throw error;
    }

    if (sql.includes("user_tab_columns")) {
      return {
        rows: [
          {
            TABLE_NAME: "CHECKPOINTS",
            COLUMN_NAME: "CHECKPOINT",
            DATA_TYPE: this.options.checkpointDataType ?? "JSON",
          } as RowT,
          {
            TABLE_NAME: "CHECKPOINTS",
            COLUMN_NAME: "METADATA",
            DATA_TYPE: "JSON",
          } as RowT,
          {
            TABLE_NAME: "CHECKPOINT_WRITES",
            COLUMN_NAME: "TASK_PATH",
            DATA_TYPE: "VARCHAR2",
          } as RowT,
        ],
      };
    }

    if (sql.includes("FROM CHECKPOINTS cp")) {
      return { rows: (this.options.checkpointRows ?? []) as RowT[] };
    }
    if (sql.includes("INNER JOIN CHECKPOINT_BLOBS")) {
      return { rows: (this.options.blobRows ?? []) as RowT[] };
    }
    if (sql.includes("FROM CHECKPOINT_WRITES cw")) {
      return { rows: (this.options.writeRows ?? []) as RowT[] };
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

  async executeMany(
    sql: string,
    binds: Record<string, unknown>[],
    options?: Record<string, unknown>
  ): Promise<{ rowsAffected?: number }> {
    this.executeManyExecutions.push({ sql, binds, options });
    return { rowsAffected: binds.length };
  }

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}

  async close(): Promise<void> {}
}

describe("OracleCheckpointSaver", () => {
  test("builds a saver from a Python style connection string", () => {
    const saver = OracleCheckpointSaver.fromConnString(
      "scott/tiger@localhost:1521/FREEPDB1",
      { tableSuffix: "LG", poolConfig: { maxSize: 4 } }
    );
    const probe = saver as unknown as {
      connectionOptions?: Record<string, unknown>;
      tableSuffix: string;
    };

    expect(probe.connectionOptions).toEqual({
      user: "scott",
      password: "tiger",
      connectString: "localhost:1521/FREEPDB1",
      poolMin: 1,
      poolMax: 4,
    });
    expect(probe.tableSuffix).toBe("LG");
  });

  test("rejects a malformed connection string before constructing", () => {
    expect(() =>
      OracleCheckpointSaver.fromConnString("scott@localhost:1521/FREEPDB1")
    ).toThrow("Invalid Oracle connection string format");
  });

  test("shares concurrent lazy pool creation", async () => {
    const connection = new FakeConnection();
    let resolvePool!: (pool: unknown) => void;
    const pendingPool = new Promise((resolve) => {
      resolvePool = resolve;
    });
    const pool = {
      async getConnection() {
        return connection;
      },
      async close() {},
    };
    const createPool = vi
      .spyOn(oracledb, "createPool")
      .mockReturnValue(pendingPool as never);
    const saver = new OracleCheckpointSaver({ connection: {} });
    const getConnection = (
      saver as unknown as {
        getConnection(): Promise<{ connection: OracleConnectionLike }>;
      }
    ).getConnection.bind(saver);

    const first = getConnection();
    const second = getConnection();
    resolvePool(pool);
    await Promise.all([first, second]);

    expect(createPool).toHaveBeenCalledTimes(1);
    await saver.end();
    createPool.mockRestore();
  });

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

  test("treats existing Python thread indexes as idempotent", async () => {
    const saver = new OracleCheckpointSaver({
      connection: new FakeConnection({
        failIndexAlreadyExists: true,
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

  test("rejects incompatible and newer schemas during setup", async () => {
    const incompatible = new OracleCheckpointSaver({
      connection: new FakeConnection({ checkpointDataType: "BLOB" }),
    });
    await expect(incompatible.setup()).rejects.toThrow(
      "CHECKPOINTS.CHECKPOINT must be JSON, found BLOB"
    );

    const newer = new OracleCheckpointSaver({
      connection: new FakeConnection({ latestMigrationVersion: 7 }),
    });
    await expect(newer.setup()).rejects.toThrow(
      "schema version 7 is newer than the highest supported version 6"
    );
  });

  test("reads Python native JSON and default MessagePack payloads", async () => {
    const connection = new FakeConnection({
      checkpointRows: [
        {
          THREAD_ID: "python-thread",
          CHECKPOINT_NS: " ",
          CHECKPOINT_ID: "checkpoint-1",
          PARENT_CHECKPOINT_ID: null,
          CHECKPOINT: {
            ...emptyCheckpoint(),
            channel_values: { inline: { from: "python-inline" } },
            channel_versions: { inline: "1", blob: "1" },
          },
          METADATA: { source: "loop", step: 1, parents: {} },
        },
      ],
      blobRows: [
        {
          CHANNEL: "blob",
          TYPE: "msgpack",
          BLOB: encodeMessagePack({ from: "python-blob" }),
        },
      ],
      writeRows: [
        {
          TASK_ID: "python-task",
          CHANNEL: "events",
          TYPE: "msgpack",
          BLOB: encodeMessagePack({ from: "python-write" }),
        },
      ],
    });
    const saver = new OracleCheckpointSaver({ connection });

    await expect(
      saver.getTuple({ configurable: { thread_id: "python-thread" } })
    ).resolves.toMatchObject({
      config: { configurable: { checkpoint_ns: "" } },
      checkpoint: {
        channel_values: {
          inline: { from: "python-inline" },
          blob: { from: "python-blob" },
        },
      },
      pendingWrites: [
        ["python-task", "events", { from: "python-write" }],
      ],
    });
  });

  test("stores Python-compatible JSON values inline and serializer values as blobs", async () => {
    const connection = new FakeConnection();
    const saver = new OracleCheckpointSaver({ connection });
    await saver.setup();
    connection.executions = [];

    await saver.put(
      { configurable: { thread_id: "thread-inline" } },
      {
        ...emptyCheckpoint(),
        id: "checkpoint-inline",
        channel_values: {
          primitive: "inline",
          nested: { items: [1, true, null] },
          bytes: new Uint8Array([1, 2, 3]),
          set: new Set(["a", "b"]),
        },
        channel_versions: {
          primitive: 1,
          nested: 1,
          bytes: 1,
          set: 1,
        },
      },
      { source: "update", step: 0, parents: {} },
      { primitive: 1, nested: 1, bytes: 1, set: 1 }
    );

    const checkpointExecution = connection.executions.find((execution) =>
      execution.sql.includes("MERGE INTO CHECKPOINTS")
    );
    const storedCheckpoint = bindValue<{
      channel_values: Record<string, unknown>;
    }>(checkpointExecution?.binds?.checkpoint);
    expect(storedCheckpoint).toMatchObject({
      channel_values: {
        primitive: "inline",
        nested: { items: [1, true, null] },
      },
    });
    expect(storedCheckpoint.channel_values).not.toHaveProperty("bytes");
    expect(storedCheckpoint.channel_values).not.toHaveProperty("set");

    const blobBatch = connection.executeManyExecutions.find((execution) =>
      execution.sql.includes("MERGE INTO CHECKPOINT_BLOBS")
    );
    const blobChannels = (blobBatch?.binds ?? [])
      .map((binds) => bindValue<string>(binds.channel))
      .sort();
    expect(blobChannels).toEqual(["bytes", "set"]);
    expect(blobBatch?.options).toHaveProperty("bindDefs");
  });

  test("validates and applies the JSON inline size threshold", async () => {
    expect(
      () =>
        new OracleCheckpointSaver({
          connection: new FakeConnection(),
          jsonSizeThresholdMb: -1,
        })
    ).toThrow(
      "Oracle checkpoint jsonSizeThresholdMb must be a non-negative finite number."
    );

    const connection = new FakeConnection();
    const saver = new OracleCheckpointSaver({
      connection,
      jsonSizeThresholdMb: 0,
    });
    await saver.setup();
    connection.executions = [];
    await saver.put(
      { configurable: { thread_id: "thread-threshold" } },
      {
        ...emptyCheckpoint(),
        id: "checkpoint-threshold",
        channel_values: { primitive: "inline", object: {} },
        channel_versions: { primitive: 1, object: 1 },
      },
      { source: "update", step: 0, parents: {} },
      { primitive: 1, object: 1 }
    );

    const checkpointExecution = connection.executions.find((execution) =>
      execution.sql.includes("MERGE INTO CHECKPOINTS")
    );
    expect(bindValue(checkpointExecution?.binds?.checkpoint)).toMatchObject({
      channel_values: { primitive: "inline" },
    });
    expect(
      connection.executeManyExecutions.some(
        (execution) =>
          execution.sql.includes("MERGE INTO CHECKPOINT_BLOBS") &&
          execution.binds.some(
            (binds) => bindValue(binds.channel) === "object"
          )
      )
    ).toBe(true);
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
