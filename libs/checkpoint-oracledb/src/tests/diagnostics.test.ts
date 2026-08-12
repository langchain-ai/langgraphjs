// Copyright (c) 2026, Oracle and/or its affiliates.
import { describe, expect, test } from "vitest";
import type { IndexConfig } from "@langchain/langgraph-checkpoint";
import type { Pool } from "oracledb";

import { OracleCheckpointSaver, type OracleConnectionLike } from "../saver.js";
import { OracleStore } from "../store/index.js";

type FakeRow = Record<string, unknown>;
type MetadataQuery =
  | "tables"
  | "columns"
  | "constraints"
  | "indexes"
  | "jsonColumns"
  | "vectorInfo";

const SENSITIVE_FIXTURE_KEY = ["pass", "word"].join("");
const SENSITIVE_FIXTURE_VALUE = ["credential", "fixture"].join("-");

class FakeDiagnosticsConnection implements OracleConnectionLike {
  readonly statements: string[] = [];

  readonly binds: Record<string, unknown>[] = [];

  oracleServerVersion = 2300000000;

  oracleServerVersionString = "23.0.0.0.0";

  constructor(
    private readonly options: {
      prefix: string;
      checkpointApplied?: number[];
      storeApplied?: number[];
      checkpointTables?: boolean;
      storeTables?: boolean;
      vectorTable?: boolean;
      vectorProbeErrorCode?: number;
      checkpointDataType?: string;
      omitCheckpointColumn?: boolean;
      vectorInfoAvailable?: boolean;
      metadataFailures?: MetadataQuery[];
    }
  ) {
    Object.defineProperty(this, SENSITIVE_FIXTURE_KEY, {
      enumerable: true,
      value: SENSITIVE_FIXTURE_VALUE,
    });
  }

  async execute<RowT = FakeRow>(
    sql: string,
    binds?: Record<string, unknown>
  ): Promise<{ rows?: RowT[]; rowsAffected?: number }> {
    this.statements.push(sql);
    this.binds.push(binds ?? {});
    expect(sql.trim()).toMatch(/^SELECT\b/i);
    expect(sql).not.toMatch(
      /\b(CREATE|ALTER|INSERT|UPDATE|DELETE|MERGE|DROP)\b/i
    );

    if (/VECTOR_DISTANCE/i.test(sql)) {
      if (this.options.vectorProbeErrorCode !== undefined) {
        const error = new Error("vector unavailable") as Error & {
          errorNum: number;
        };
        error.errorNum = this.options.vectorProbeErrorCode;
        throw error;
      }
      return { rows: [{ SCORE: 1 } as RowT] };
    }

    if (/SELECT v FROM/i.test(sql)) {
      const tableName = sql
        .match(/FROM\s+([A-Z0-9_$#_]+)/i)?.[1]
        ?.toUpperCase();
      if (tableName?.includes("CHECKPOINT_MIGRATIONS")) {
        if (!this.options.checkpointTables) throw missingTableError();
        return {
          rows: (this.options.checkpointApplied ?? []).map(
            (version) => ({ V: version } as RowT)
          ),
        };
      }
      if (tableName?.includes("STORE_MIGRATIONS")) {
        if (!this.options.storeTables) throw missingTableError();
        return {
          rows: (this.options.storeApplied ?? []).map(
            (version) => ({ V: version } as RowT)
          ),
        };
      }
    }

    if (/FROM USER_TABLES/i.test(sql)) {
      this.failMetadata("tables");
      return { rows: this.tableRows() as RowT[] };
    }

    if (/FROM USER_TAB_COLUMNS/i.test(sql) && /vector_info/i.test(sql)) {
      this.failMetadata("vectorInfo");
      if (this.options.vectorInfoAvailable) {
        return { rows: this.vectorRows() as RowT[] };
      }
      const error = new Error("VECTOR_INFO unavailable") as Error & {
        errorNum: number;
      };
      error.errorNum = 904;
      throw error;
    }

    if (/FROM USER_TAB_COLUMNS/i.test(sql)) {
      this.failMetadata("columns");
      return { rows: this.columnRows() as RowT[] };
    }

    if (/FROM USER_CONSTRAINTS/i.test(sql)) {
      this.failMetadata("constraints");
      return { rows: this.constraintRows() as RowT[] };
    }

    if (/FROM USER_INDEXES/i.test(sql)) {
      this.failMetadata("indexes");
      return { rows: this.indexRows() as RowT[] };
    }

    if (/FROM USER_JSON_COLUMNS/i.test(sql)) {
      this.failMetadata("jsonColumns");
      return { rows: this.jsonRows() as RowT[] };
    }

    if (/SELECT COUNT\(\*\) AS row_count/i.test(sql)) {
      return { rows: [{ ROW_COUNT: 7 } as RowT] };
    }

    return { rows: [] };
  }

  async executeMany(): Promise<{ rows?: FakeRow[]; rowsAffected?: number }> {
    throw new Error("diagnostics must not executeMany");
  }

  async commit(): Promise<void> {
    throw new Error("diagnostics must not commit");
  }

  async rollback(): Promise<void> {
    throw new Error("diagnostics must not rollback");
  }

  async close(): Promise<void> {}

  private failMetadata(query: MetadataQuery): void {
    if (!this.options.metadataFailures?.includes(query)) return;
    const error = new Error(`${query} metadata unavailable`) as Error & {
      errorNum: number;
    };
    error.errorNum = 6502;
    throw error;
  }

  private tableRows(): FakeRow[] {
    return [
      ...(this.options.checkpointTables
        ? checkpointTableNames(this.options.prefix).map((TABLE_NAME) => ({
            TABLE_NAME,
          }))
        : []),
      ...(this.options.storeTables
        ? storeTableNames(this.options.prefix, this.options.vectorTable).map(
            (TABLE_NAME) => ({ TABLE_NAME })
          )
        : []),
    ];
  }

  private columnRows(): FakeRow[] {
    return [
      ...(this.options.checkpointTables
        ? checkpointColumnRows(
            this.options.prefix,
            this.options.checkpointDataType,
            this.options.omitCheckpointColumn
          )
        : []),
      ...(this.options.storeTables
        ? storeColumnRows(this.options.prefix, this.options.vectorTable)
        : []),
    ];
  }

  private constraintRows(): FakeRow[] {
    return [
      ...(this.options.checkpointTables
        ? checkpointConstraintRows(this.options.prefix)
        : []),
      ...(this.options.storeTables
        ? storeConstraintRows(this.options.prefix, this.options.vectorTable)
        : []),
    ];
  }

  private indexRows(): FakeRow[] {
    return this.constraintRows()
      .filter((row) => row.CONSTRAINT_TYPE === "P")
      .map((row) => ({
        TABLE_NAME: row.TABLE_NAME,
        INDEX_NAME: row.INDEX_NAME,
        UNIQUENESS: "UNIQUE",
        INDEX_TYPE: "NORMAL",
        COLUMN_NAME: row.COLUMN_NAME,
        COLUMN_POSITION: row.POSITION,
      }));
  }

  private jsonRows(): FakeRow[] {
    if (!this.options.storeTables) return [];
    return [
      {
        TABLE_NAME: storeNames(this.options.prefix).store,
        COLUMN_NAME: "VALUE",
      },
    ];
  }

  private vectorRows(): FakeRow[] {
    if (!this.options.storeTables || !this.options.vectorTable) return [];
    return [
      {
        TABLE_NAME: storeNames(this.options.prefix).vectors,
        COLUMN_NAME: "EMBEDDING",
        VECTOR_INFO: "VECTOR(2,FLOAT32)",
      },
    ];
  }
}

function missingTableError(): Error & { errorNum: number } {
  const error = new Error("table missing") as Error & { errorNum: number };
  error.errorNum = 942;
  return error;
}

const checkpointTableNames = (token: string): string[] => {
  const suffix = token.replace(/_+$/, "");
  return [
    `CHECKPOINTS_${suffix}`,
    `CHECKPOINT_BLOBS_${suffix}`,
    `CHECKPOINT_WRITES_${suffix}`,
    `CHECKPOINT_MIGRATIONS_${suffix}`,
  ];
};

const storeTableNames = (
  prefix: string,
  includeVectorTable = false
): string[] => {
  const names = storeNames(prefix);
  return [
    names.store,
    names.migrations,
    ...(includeVectorTable ? [names.vectors, names.vectorMigrations] : []),
  ];
};

const storeNames = (prefix: string) => {
  const suffix = prefix.replace(/_+$/, "");
  return {
    store: `STORE_${suffix}`,
    vectors: `STORE_VECTORS_${suffix}`,
    migrations: `STORE_MIGRATIONS_${suffix}`,
    vectorMigrations: `VECTOR_MIGRATIONS_${suffix}`,
  };
};

const columns = (
  tableName: string,
  rows: Array<[columnName: string, dataType: string]>
): FakeRow[] =>
  rows.map(([COLUMN_NAME, DATA_TYPE]) => ({
    TABLE_NAME: tableName,
    COLUMN_NAME,
    DATA_TYPE,
    NULLABLE: "Y",
  }));

function checkpointColumnRows(
  token: string,
  checkpointDataType = "JSON",
  omitCheckpointColumn = false
): FakeRow[] {
  const [checkpoints, blobs, writes, migrations] = checkpointTableNames(token);
  return [
    ...columns(migrations, [["V", "NUMBER"]]),
    ...columns(checkpoints, [
      ["THREAD_ID", "VARCHAR2"],
      ["CHECKPOINT_NS", "VARCHAR2"],
      ["CHECKPOINT_ID", "VARCHAR2"],
      ["PARENT_CHECKPOINT_ID", "VARCHAR2"],
      ["TYPE", "VARCHAR2"],
      ...(omitCheckpointColumn
        ? []
        : ([["CHECKPOINT", checkpointDataType]] as Array<[string, string]>)),
      ["METADATA", "JSON"],
    ]),
    ...columns(blobs, [
      ["THREAD_ID", "VARCHAR2"],
      ["CHECKPOINT_NS", "VARCHAR2"],
      ["CHANNEL", "VARCHAR2"],
      ["VERSION", "VARCHAR2"],
      ["TYPE", "VARCHAR2"],
      ["BLOB", "BLOB"],
    ]),
    ...columns(writes, [
      ["THREAD_ID", "VARCHAR2"],
      ["CHECKPOINT_NS", "VARCHAR2"],
      ["CHECKPOINT_ID", "VARCHAR2"],
      ["TASK_ID", "VARCHAR2"],
      ["IDX", "NUMBER"],
      ["CHANNEL", "VARCHAR2"],
      ["TYPE", "VARCHAR2"],
      ["BLOB", "BLOB"],
      ["TASK_PATH", "VARCHAR2"],
    ]),
  ];
}

function storeColumnRows(
  prefix: string,
  includeVectorTable = false
): FakeRow[] {
  const names = storeNames(prefix);
  return [
    ...columns(names.migrations, [["V", "NUMBER"]]),
    ...columns(names.store, [
      ["PREFIX", "VARCHAR2"],
      ["KEY", "VARCHAR2"],
      ["VALUE", "JSON"],
      ["CREATED_AT", "TIMESTAMP(6) WITH TIME ZONE"],
      ["UPDATED_AT", "TIMESTAMP(6) WITH TIME ZONE"],
      ["EXPIRES_AT", "TIMESTAMP(6) WITH TIME ZONE"],
      ["TTL_MINUTES", "NUMBER"],
    ]),
    ...(includeVectorTable
      ? [
          ...columns(names.vectorMigrations, [["V", "NUMBER"]]),
          ...columns(names.vectors, [
            ["PREFIX", "VARCHAR2"],
            ["KEY", "VARCHAR2"],
            ["FIELD_NAME", "VARCHAR2"],
            ["EMBEDDING", "VECTOR"],
            ["CREATED_AT", "TIMESTAMP(6) WITH TIME ZONE"],
          ]),
        ]
      : []),
  ];
}

const pkRows = (
  tableName: string,
  columnsForPk: string[],
  indexName: string
): FakeRow[] =>
  columnsForPk.map((COLUMN_NAME, index) => ({
    TABLE_NAME: tableName,
    CONSTRAINT_NAME: `${tableName}_PK`,
    CONSTRAINT_TYPE: "P",
    INDEX_NAME: indexName,
    COLUMN_NAME,
    POSITION: index + 1,
  }));

function checkpointConstraintRows(token: string): FakeRow[] {
  const [checkpoints, blobs, writes, migrations] =
    checkpointTableNames(token);
  return [
    ...pkRows(migrations, ["V"], `${token}CP_MIG_PK`),
    ...pkRows(
      checkpoints,
      ["THREAD_ID", "CHECKPOINT_NS", "CHECKPOINT_ID"],
      `${token}CP_PK`
    ),
    ...pkRows(
      blobs,
      ["THREAD_ID", "CHECKPOINT_NS", "CHANNEL", "VERSION"],
      `${token}CB_PK`
    ),
    ...pkRows(
      writes,
      ["THREAD_ID", "CHECKPOINT_NS", "CHECKPOINT_ID", "TASK_ID", "IDX"],
      `${token}CW_PK`
    ),
  ];
}

function storeConstraintRows(
  prefix: string,
  includeVectorTable = false
): FakeRow[] {
  const names = storeNames(prefix);
  return [
    ...pkRows(names.migrations, ["V"], `${prefix}ST_MIG_PK`),
    ...pkRows(names.store, ["PREFIX", "KEY"], `${prefix}ST_PK`),
    ...(includeVectorTable
      ? [
          ...pkRows(names.vectorMigrations, ["V"], `${prefix}V_MIG_PK`),
          ...pkRows(
            names.vectors,
            ["PREFIX", "KEY", "FIELD_NAME"],
            `${prefix}SV_PK`
          ),
        ]
      : []),
  ];
}

const diagnosticsEmbeddings = {
  async embedDocuments(): Promise<number[][]> {
    return [];
  },
  async embedQuery(): Promise<number[]> {
    return [0, 0];
  },
} as unknown as IndexConfig["embeddings"];

function diagnosticsPool(connection: FakeDiagnosticsConnection): Pool {
  return {
    async getConnection() {
      return connection;
    },
    async close() {},
  } as unknown as Pool;
}

describe("Oracle diagnostics", () => {
  test("reports missing checkpoint schema without setup or writes", async () => {
    const connection = new FakeDiagnosticsConnection({
      prefix: "LG_MISSING_",
      checkpointTables: false,
    });
    const saver = new OracleCheckpointSaver({
      connection,
      tableSuffix: "lg_missing",
    });

    const diagnostics = await saver.getDiagnostics();

    expect(diagnostics.status).toBe("missing");
    expect(diagnostics.migrations.status).toBe("missing");
    expect(diagnostics.tableSuffix).toBe("lg_missing");
    expect(diagnostics.storageMode).toBe("missing");
    expect(connection.statements.length).toBeGreaterThan(0);
  });

  test("reports migrated checkpoint schema cleanly", async () => {
    const connection = new FakeDiagnosticsConnection({
      prefix: "LG_READY_",
      checkpointTables: true,
      checkpointApplied: [0, 1, 2, 3, 4, 5, 6],
    });
    const saver = new OracleCheckpointSaver({
      connection,
      tableSuffix: "lg_ready",
    });

    const diagnostics = await saver.getDiagnostics();

    expect(diagnostics.status).toBe("ready");
    expect(diagnostics.migrations.applied).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(diagnostics.migrations.pending).toEqual([]);
    expect(diagnostics.schema.issues).toEqual([]);
    expect(diagnostics.storageMode).toBe("json");
  });

  test("reports checkpoint storage mode from observed checkpoint column metadata", async () => {
    const clobConnection = new FakeDiagnosticsConnection({
      prefix: "LG_CLOB_",
      checkpointTables: true,
      checkpointApplied: [0, 1, 2, 3, 4, 5, 6],
      checkpointDataType: "CLOB",
    });
    const clobSaver = new OracleCheckpointSaver({
      connection: clobConnection,
      tableSuffix: "lg_clob",
    });

    await expect(clobSaver.getDiagnostics()).resolves.toMatchObject({
      status: "partial",
      storageMode: "clob",
    });

    const missingColumnConnection = new FakeDiagnosticsConnection({
      prefix: "LG_UNKNOWN_STORAGE_",
      checkpointTables: true,
      checkpointApplied: [0, 1, 2, 3, 4, 5, 6],
      omitCheckpointColumn: true,
    });
    const missingColumnSaver = new OracleCheckpointSaver({
      connection: missingColumnConnection,
      tableSuffix: "lg_unknown_storage",
    });

    const diagnostics = await missingColumnSaver.getDiagnostics();
    expect(diagnostics.storageMode).toBe("unknown");
    expect(diagnostics.issues).toContain(
      "CHECKPOINTS_LG_UNKNOWN_STORAGE.CHECKPOINT: missing required column"
    );
  });

  test("uses constructor vector config for store migration expectations", async () => {
    const disabledConnection = new FakeDiagnosticsConnection({
      prefix: "LG_STORE_",
      storeTables: true,
      vectorTable: true,
      storeApplied: [0, 1, 2, 3, 4],
    });
    const disabledStore = new OracleStore({
      pool: diagnosticsPool(disabledConnection),
      tableSuffix: "lg_store",
    });

    const disabledDiagnostics = await disabledStore.getDiagnostics();

    expect(disabledDiagnostics.status).toBe("ready");
    expect(disabledDiagnostics.migrations.expectedForCurrentConfig).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(disabledDiagnostics.migrations.pending).toEqual([]);
    expect(disabledDiagnostics.migrations.future).toEqual([]);

    const enabledConnection = new FakeDiagnosticsConnection({
      prefix: "LG_VECTOR_",
      storeTables: true,
      vectorTable: true,
      storeApplied: [0, 1, 2, 3, 4],
    });
    const enabledStore = new OracleStore({
      pool: diagnosticsPool(enabledConnection),
      tableSuffix: "lg_vector",
      index: {
        dims: 2,
        embeddings: diagnosticsEmbeddings,
      },
    });

    const enabledDiagnostics = await enabledStore.getDiagnostics();

    expect(enabledDiagnostics.status).toBe("ready");
    expect(enabledDiagnostics.migrations.expectedForCurrentConfig).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(enabledDiagnostics.vector.configured).toBe(true);
    expect(
      enabledConnection.binds.find(
        (binds) => typeof binds.probe_vector === "string"
      )
    ).toMatchObject({ probe_vector: "[1,0]" });
  });

  test("includes row counts and VECTOR column metadata when requested", async () => {
    const connection = new FakeDiagnosticsConnection({
      prefix: "LG_VECTOR_INFO_",
      storeTables: true,
      vectorTable: true,
      vectorInfoAvailable: true,
      storeApplied: [0, 1, 2, 3, 4],
    });
    const store = new OracleStore({
      pool: diagnosticsPool(connection),
      tableSuffix: "lg_vector_info",
      index: {
        dims: 2,
        embeddings: diagnosticsEmbeddings,
      },
    });

    const diagnostics = await store.getDiagnostics({ includeRowCounts: true });

    expect(diagnostics.status).toBe("ready");
    expect(diagnostics.vector.embeddingColumn).toMatchObject({
      status: "present",
      vectorInfo: "VECTOR(2,FLOAT32)",
    });
    expect(
      diagnostics.schema.tables.find(
        (table) => table.name === "STORE_LG_VECTOR_INFO"
      )
    ).toMatchObject({ rowCount: 7 });
  });

  test("reports metadata query failures without throwing diagnostics", async () => {
    const connection = new FakeDiagnosticsConnection({
      prefix: "LG_METADATA_FAIL_",
      storeTables: true,
      storeApplied: [0, 1, 2, 3, 4],
      metadataFailures: ["columns", "constraints", "indexes", "jsonColumns"],
    });
    const store = new OracleStore({
      pool: diagnosticsPool(connection),
      tableSuffix: "lg_metadata_fail",
    });

    const diagnostics = await store.getDiagnostics();

    expect(diagnostics.status).toBe("unknown");
    expect(diagnostics.schema.metadataAvailability).toMatchObject({
      columns: "unknown",
      constraints: "unknown",
      indexes: "unknown",
      jsonColumns: "unknown",
    });
    expect(diagnostics.schema.errors).toEqual(
      expect.arrayContaining([
        { reason: "column_metadata_query_failed", code: 6502 },
        { reason: "constraint_metadata_query_failed", code: 6502 },
        { reason: "index_metadata_query_failed", code: 6502 },
        { reason: "json_metadata_query_failed", code: 6502 },
      ])
    );
  });

  test("degrades store diagnostics when configured vector probe is unavailable", async () => {
    const connection = new FakeDiagnosticsConnection({
      prefix: "LG_NOVECTOR_",
      storeTables: true,
      vectorTable: true,
      storeApplied: [0, 1, 2, 3, 4],
      vectorProbeErrorCode: 904,
    });
    const store = new OracleStore({
      pool: diagnosticsPool(connection),
      tableSuffix: "lg_novector",
      index: {
        dims: 2,
        embeddings: diagnosticsEmbeddings,
      },
    });

    const diagnostics = await store.getDiagnostics();

    expect(diagnostics.status).toBe("partial");
    expect(diagnostics.vector.probe).toMatchObject({
      status: "unavailable",
      error: { reason: "vector_probe_failed", code: 904 },
    });
    expect(diagnostics.issues).toContain(
      "Oracle VECTOR probe status is unavailable."
    );
  });

  test("reports unknown store diagnostics when configured vector probe is inconclusive", async () => {
    const connection = new FakeDiagnosticsConnection({
      prefix: "LG_UNKNOWNVECTOR_",
      storeTables: true,
      vectorTable: true,
      storeApplied: [0, 1, 2, 3, 4],
      vectorProbeErrorCode: 6502,
    });
    const store = new OracleStore({
      pool: diagnosticsPool(connection),
      tableSuffix: "lg_unknownvector",
      index: {
        dims: 2,
        embeddings: diagnosticsEmbeddings,
      },
    });

    const diagnostics = await store.getDiagnostics();

    expect(diagnostics.status).toBe("unknown");
    expect(diagnostics.vector.probe).toMatchObject({
      status: "unknown",
      error: { reason: "vector_probe_failed", code: 6502 },
    });
    expect(diagnostics.issues).toContain(
      "Oracle VECTOR probe status is unknown."
    );
  });

  test("does not expose credential-like fields", async () => {
    const connection = new FakeDiagnosticsConnection({
      prefix: "LG_SAFE_",
      checkpointTables: true,
      checkpointApplied: [0, 1, 2, 3, 4, 5, 6],
    });
    const saver = new OracleCheckpointSaver({
      connection,
      tableSuffix: "lg_safe",
    });

    const diagnostics = await saver.getDiagnostics();
    const serialized = JSON.stringify(diagnostics).toLowerCase();

    expect(serialized).not.toContain(SENSITIVE_FIXTURE_KEY);
    expect(serialized).not.toContain(SENSITIVE_FIXTURE_VALUE);
    expect(serialized).not.toContain("connectstring");
    expect(serialized).not.toContain("wallet");
  });
});
