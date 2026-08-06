// Copyright (c) 2026, Oracle and/or its affiliates.
import { describe, expect, test } from "vitest";
import type { IndexConfig } from "@langchain/langgraph-checkpoint";

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
      if (tableName?.endsWith("CHECKPOINT_MIGRATIONS")) {
        if (!this.options.checkpointTables) throw missingTableError();
        return {
          rows: (this.options.checkpointApplied ?? []).map(
            (version) => ({ V: version } as RowT)
          ),
        };
      }
      if (tableName?.endsWith("STORE_MIGRATIONS")) {
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
        TABLE_NAME: `${this.options.prefix}STORE`,
        COLUMN_NAME: "NAMESPACE",
      },
      {
        TABLE_NAME: `${this.options.prefix}STORE`,
        COLUMN_NAME: "ITEM_VALUE",
      },
    ];
  }

  private vectorRows(): FakeRow[] {
    if (!this.options.storeTables || !this.options.vectorTable) return [];
    return [
      {
        TABLE_NAME: `${this.options.prefix}STORE_VECTORS`,
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

const checkpointTableNames = (prefix: string): string[] => [
  `${prefix}CHECKPOINTS`,
  `${prefix}CHECKPOINT_BLOBS`,
  `${prefix}CHECKPOINT_WRITES`,
  `${prefix}CHECKPOINT_MIGRATIONS`,
];

const storeTableNames = (
  prefix: string,
  includeVectorTable = false
): string[] => [
  `${prefix}STORE`,
  `${prefix}STORE_MIGRATIONS`,
  ...(includeVectorTable ? [`${prefix}STORE_VECTORS`] : []),
];

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
  prefix: string,
  checkpointDataType = "BLOB",
  omitCheckpointColumn = false
): FakeRow[] {
  return [
    ...columns(`${prefix}CHECKPOINT_MIGRATIONS`, [["V", "NUMBER"]]),
    ...columns(`${prefix}CHECKPOINTS`, [
      ["THREAD_ID", "VARCHAR2"],
      ["CHECKPOINT_NS", "VARCHAR2"],
      ["CHECKPOINT_ID", "VARCHAR2"],
      ["PARENT_CHECKPOINT_ID", "VARCHAR2"],
      ["TYPE", "VARCHAR2"],
      ["METADATA_TYPE", "VARCHAR2"],
      ...(omitCheckpointColumn
        ? []
        : ([["CHECKPOINT", checkpointDataType]] as Array<[string, string]>)),
      ["METADATA", "BLOB"],
    ]),
    ...columns(`${prefix}CHECKPOINT_BLOBS`, [
      ["THREAD_ID", "VARCHAR2"],
      ["CHECKPOINT_NS", "VARCHAR2"],
      ["CHANNEL", "VARCHAR2"],
      ["VERSION", "VARCHAR2"],
      ["TYPE", "VARCHAR2"],
      ["BLOB", "BLOB"],
    ]),
    ...columns(`${prefix}CHECKPOINT_WRITES`, [
      ["THREAD_ID", "VARCHAR2"],
      ["CHECKPOINT_NS", "VARCHAR2"],
      ["CHECKPOINT_ID", "VARCHAR2"],
      ["TASK_ID", "VARCHAR2"],
      ["IDX", "NUMBER"],
      ["CHANNEL", "VARCHAR2"],
      ["TYPE", "VARCHAR2"],
      ["BLOB", "BLOB"],
    ]),
  ];
}

function storeColumnRows(
  prefix: string,
  includeVectorTable = false
): FakeRow[] {
  return [
    ...columns(`${prefix}STORE_MIGRATIONS`, [["V", "NUMBER"]]),
    ...columns(`${prefix}STORE`, [
      ["NAMESPACE_PATH", "VARCHAR2"],
      ["ITEM_KEY", "VARCHAR2"],
      ["NAMESPACE", "CLOB"],
      ["ITEM_VALUE", "CLOB"],
      ["CREATED_AT", "TIMESTAMP(6) WITH TIME ZONE"],
      ["UPDATED_AT", "TIMESTAMP(6) WITH TIME ZONE"],
    ]),
    ...(includeVectorTable
      ? columns(`${prefix}STORE_VECTORS`, [
          ["NAMESPACE_PATH", "VARCHAR2"],
          ["ITEM_KEY", "VARCHAR2"],
          ["FIELD_PATH", "VARCHAR2"],
          ["TEXT_CONTENT", "CLOB"],
          ["EMBEDDING", "VECTOR"],
          ["CREATED_AT", "TIMESTAMP(6) WITH TIME ZONE"],
        ])
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

function checkpointConstraintRows(prefix: string): FakeRow[] {
  return [
    ...pkRows(`${prefix}CHECKPOINT_MIGRATIONS`, ["V"], `${prefix}CP_MIG_PK`),
    ...pkRows(
      `${prefix}CHECKPOINTS`,
      ["THREAD_ID", "CHECKPOINT_NS", "CHECKPOINT_ID"],
      `${prefix}CP_PK`
    ),
    ...pkRows(
      `${prefix}CHECKPOINT_BLOBS`,
      ["THREAD_ID", "CHECKPOINT_NS", "CHANNEL", "VERSION"],
      `${prefix}CB_PK`
    ),
    ...pkRows(
      `${prefix}CHECKPOINT_WRITES`,
      ["THREAD_ID", "CHECKPOINT_NS", "CHECKPOINT_ID", "TASK_ID", "IDX"],
      `${prefix}CW_PK`
    ),
  ];
}

function storeConstraintRows(
  prefix: string,
  includeVectorTable = false
): FakeRow[] {
  return [
    ...pkRows(`${prefix}STORE_MIGRATIONS`, ["V"], `${prefix}ST_MIG_PK`),
    ...pkRows(
      `${prefix}STORE`,
      ["NAMESPACE_PATH", "ITEM_KEY"],
      `${prefix}ST_PK`
    ),
    ...(includeVectorTable
      ? pkRows(
          `${prefix}STORE_VECTORS`,
          ["NAMESPACE_PATH", "ITEM_KEY", "FIELD_PATH"],
          `${prefix}SV_PK`
        )
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

describe("Oracle diagnostics", () => {
  test("reports missing checkpoint schema without setup or writes", async () => {
    const connection = new FakeDiagnosticsConnection({
      prefix: "LG_MISSING_",
      checkpointTables: false,
    });
    const saver = new OracleCheckpointSaver({
      connection,
      tablePrefix: "lg_missing_",
    });

    const diagnostics = await saver.getDiagnostics();

    expect(diagnostics.status).toBe("missing");
    expect(diagnostics.migrations.status).toBe("missing");
    expect(diagnostics.tablePrefix).toBe("LG_MISSING_");
    expect(diagnostics.storageMode).toBe("missing");
    expect(connection.statements.length).toBeGreaterThan(0);
  });

  test("reports migrated checkpoint schema cleanly", async () => {
    const connection = new FakeDiagnosticsConnection({
      prefix: "LG_READY_",
      checkpointTables: true,
      checkpointApplied: [0, 1, 2, 3, 4, 5],
    });
    const saver = new OracleCheckpointSaver({
      connection,
      tablePrefix: "lg_ready_",
    });

    const diagnostics = await saver.getDiagnostics();

    expect(diagnostics.status).toBe("ready");
    expect(diagnostics.migrations.applied).toEqual([0, 1, 2, 3, 4, 5]);
    expect(diagnostics.migrations.pending).toEqual([]);
    expect(diagnostics.schema.issues).toEqual([]);
    expect(diagnostics.storageMode).toBe("blob");
  });

  test("reports checkpoint storage mode from observed checkpoint column metadata", async () => {
    const clobConnection = new FakeDiagnosticsConnection({
      prefix: "LG_CLOB_",
      checkpointTables: true,
      checkpointApplied: [0, 1, 2, 3, 4, 5],
      checkpointDataType: "CLOB",
    });
    const clobSaver = new OracleCheckpointSaver({
      connection: clobConnection,
      tablePrefix: "lg_clob_",
    });

    await expect(clobSaver.getDiagnostics()).resolves.toMatchObject({
      status: "partial",
      storageMode: "clob",
    });

    const missingColumnConnection = new FakeDiagnosticsConnection({
      prefix: "LG_UNKNOWN_STORAGE_",
      checkpointTables: true,
      checkpointApplied: [0, 1, 2, 3, 4, 5],
      omitCheckpointColumn: true,
    });
    const missingColumnSaver = new OracleCheckpointSaver({
      connection: missingColumnConnection,
      tablePrefix: "lg_unknown_storage_",
    });

    const diagnostics = await missingColumnSaver.getDiagnostics();
    expect(diagnostics.storageMode).toBe("unknown");
    expect(diagnostics.issues).toContain(
      "LG_UNKNOWN_STORAGE_CHECKPOINTS.CHECKPOINT: missing required column"
    );
  });

  test("uses constructor vector config for store migration expectations", async () => {
    const disabledConnection = new FakeDiagnosticsConnection({
      prefix: "LG_STORE_",
      storeTables: true,
      vectorTable: true,
      storeApplied: [0, 1],
    });
    const disabledStore = new OracleStore({
      pool: {
        async getConnection() {
          return disabledConnection;
        },
        async close() {},
      },
      tablePrefix: "lg_store_",
    });

    const disabledDiagnostics = await disabledStore.getDiagnostics();

    expect(disabledDiagnostics.status).toBe("ready");
    expect(disabledDiagnostics.migrations.expectedForCurrentConfig).toEqual([
      0,
    ]);
    expect(disabledDiagnostics.migrations.pending).toEqual([]);
    expect(disabledDiagnostics.migrations.future).toEqual([]);

    const enabledConnection = new FakeDiagnosticsConnection({
      prefix: "LG_VECTOR_",
      storeTables: true,
      vectorTable: true,
      storeApplied: [0, 1],
    });
    const enabledStore = new OracleStore({
      pool: {
        async getConnection() {
          return enabledConnection;
        },
        async close() {},
      },
      tablePrefix: "lg_vector_",
      index: {
        dims: 2,
        embeddings: diagnosticsEmbeddings,
      },
    });

    const enabledDiagnostics = await enabledStore.getDiagnostics();

    expect(enabledDiagnostics.status).toBe("ready");
    expect(enabledDiagnostics.migrations.expectedForCurrentConfig).toEqual([
      0, 1,
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
      storeApplied: [0, 1],
    });
    const store = new OracleStore({
      pool: {
        async getConnection() {
          return connection;
        },
        async close() {},
      },
      tablePrefix: "lg_vector_info_",
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
        (table) => table.name === "LG_VECTOR_INFO_STORE"
      )
    ).toMatchObject({ rowCount: 7 });
  });

  test("reports metadata query failures without throwing diagnostics", async () => {
    const connection = new FakeDiagnosticsConnection({
      prefix: "LG_METADATA_FAIL_",
      storeTables: true,
      storeApplied: [0],
      metadataFailures: ["columns", "constraints", "indexes", "jsonColumns"],
    });
    const store = new OracleStore({
      pool: {
        async getConnection() {
          return connection;
        },
        async close() {},
      },
      tablePrefix: "lg_metadata_fail_",
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
      storeApplied: [0, 1],
      vectorProbeErrorCode: 904,
    });
    const store = new OracleStore({
      pool: {
        async getConnection() {
          return connection;
        },
        async close() {},
      },
      tablePrefix: "lg_novector_",
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
      storeApplied: [0, 1],
      vectorProbeErrorCode: 6502,
    });
    const store = new OracleStore({
      pool: {
        async getConnection() {
          return connection;
        },
        async close() {},
      },
      tablePrefix: "lg_unknownvector_",
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
      checkpointApplied: [0, 1, 2, 3, 4, 5],
    });
    const saver = new OracleCheckpointSaver({
      connection,
      tablePrefix: "lg_safe_",
    });

    const diagnostics = await saver.getDiagnostics();
    const serialized = JSON.stringify(diagnostics).toLowerCase();

    expect(serialized).not.toContain(SENSITIVE_FIXTURE_KEY);
    expect(serialized).not.toContain(SENSITIVE_FIXTURE_VALUE);
    expect(serialized).not.toContain("connectstring");
    expect(serialized).not.toContain("wallet");
  });
});
