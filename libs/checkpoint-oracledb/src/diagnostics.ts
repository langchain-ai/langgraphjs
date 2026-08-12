// Copyright (c) 2026, Oracle and/or its affiliates.
import oracledb from "oracledb";
import {
  isOracleError,
  oracleErrorCode,
  optionalRowValue as rowValue,
} from "./utils.js";
import { ORACLE_VECTOR_MAX_DIMENSIONS } from "./store/constants.js";

export type OracleDiagnosticsStatus =
  | "ready"
  | "missing"
  | "partial"
  | "migration_pending"
  | "future_migration"
  | "unknown";

export type OracleMetadataAvailability = "available" | "unknown";

export interface OracleDiagnosticsOptions {
  includeRowCounts?: boolean;
}

export interface OracleDiagnosticsError {
  reason: string;
  code?: number | string;
}

export interface OracleRuntimeDiagnostics {
  nodeVersion: string;
  nodeOracledbVersion?: string;
  nodeOracledbMode: "thin" | "thick" | "unknown";
  oracleServerVersion?: number;
  oracleServerVersionString?: string;
}

export interface OracleColumnDiagnostics {
  name: string;
  dataType: string;
  nullable: boolean;
  dataLength?: number;
  dataPrecision?: number;
}

export interface OraclePrimaryKeyDiagnostics {
  status: "present" | "missing" | "unknown";
  expectedColumns: string[];
  observedColumns: string[];
  constraintName?: string;
  indexName?: string;
  backingIndexStatus: "present" | "missing" | "unknown";
}

export interface OracleIndexDiagnostics {
  name: string;
  tableName: string;
  uniqueness: string;
  indexType: string;
  columns: string[];
}

export interface OracleVectorColumnDiagnostics {
  columnName: string;
  vectorInfo?: string;
}

export interface OracleTableDiagnostics {
  name: string;
  required: boolean;
  exists: boolean;
  rowCount?: number;
  columns: OracleColumnDiagnostics[];
  missingColumns: string[];
  mismatchedColumns: Array<{
    name: string;
    expectedDataTypes: string[];
    actualDataType?: string;
  }>;
  primaryKey?: OraclePrimaryKeyDiagnostics;
  jsonColumns: string[] | "unknown";
  expectedJsonColumns: string[];
  missingJsonColumns: string[] | "unknown";
  indexes: OracleIndexDiagnostics[];
  vectorColumns: OracleVectorColumnDiagnostics[] | "unknown";
}

export interface OracleSchemaDiagnostics {
  metadataAvailability: {
    tables: OracleMetadataAvailability;
    columns: OracleMetadataAvailability;
    constraints: OracleMetadataAvailability;
    indexes: OracleMetadataAvailability;
    jsonColumns: OracleMetadataAvailability;
    vectorInfo: OracleMetadataAvailability;
  };
  tables: OracleTableDiagnostics[];
  issues: string[];
  errors: OracleDiagnosticsError[];
}

export interface OracleMigrationDiagnostics {
  tableName: string;
  applied: number[];
  latestApplied: number | null;
  expectedForCurrentConfig: number[];
  pending: number[];
  future: number[];
  status: "available" | "missing" | "unknown";
  error?: OracleDiagnosticsError;
}

export interface OracleStoreVectorDiagnostics {
  configured: boolean;
  configuredDims?: number;
  configuredFields?: string[];
  probe: {
    status: "available" | "unavailable" | "unknown";
    error?: OracleDiagnosticsError;
  };
  embeddingColumn: {
    status: "present" | "missing" | "unknown";
    vectorInfo?: string;
  };
  observedIndexes: OracleIndexDiagnostics[];
}

export interface OracleCheckpointSaverDiagnostics {
  kind: "checkpoint";
  status: OracleDiagnosticsStatus;
  tableSuffix: string;
  tables: {
    checkpoints: string;
    checkpoint_blobs: string;
    checkpoint_writes: string;
    checkpoint_migrations: string;
  };
  runtime: OracleRuntimeDiagnostics;
  migrations: OracleMigrationDiagnostics;
  schema: OracleSchemaDiagnostics;
  storageMode: "json" | "blob" | "clob" | "missing" | "unknown";
  issues: string[];
}

export interface OracleStoreDiagnostics {
  kind: "store";
  status: OracleDiagnosticsStatus;
  tableSuffix: string;
  tables: {
    store: string;
    storeVectors: string;
    storeMigrations: string;
    vectorMigrations: string;
  };
  runtime: OracleRuntimeDiagnostics;
  migrations: OracleMigrationDiagnostics;
  schema: OracleSchemaDiagnostics;
  vector: OracleStoreVectorDiagnostics;
  issues: string[];
}

export interface OracleDiagnosticsConnection {
  execute<RowT = Record<string, unknown>>(
    sql: string,
    binds?: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<{ rows?: RowT[] }>;
  oracleServerVersion?: number;
  oracleServerVersionString?: string;
}

export interface OracleDbModuleDiagnostics {
  versionString?: string;
  version?: string | number;
  thin?: boolean;
}

export interface ExpectedOracleColumn {
  name: string;
  dataTypes: string[];
}

export interface ExpectedOracleTable {
  name: string;
  required: boolean;
  columns: ExpectedOracleColumn[];
  primaryKey?: string[];
  jsonColumns?: string[];
}

type OracleRow = Record<string, unknown>;

type QueryResult<RowT> = {
  rows: RowT[];
  error?: OracleDiagnosticsError;
};

const VECTOR_UNAVAILABLE_CODES = new Set<number | string>([
  902,
  904,
  3001,
  "ORA-00902",
  "ORA-00904",
  "ORA-03001",
]);

const diagnosticsError = (
  reason: string,
  error: unknown
): OracleDiagnosticsError => {
  const code = oracleErrorCode(error);
  return code === undefined ? { reason } : { reason, code };
};

const assertSelectOnly = (sql: string): void => {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
    throw new Error(
      "Oracle diagnostics queries must be read-only SELECT statements."
    );
  }
};

const executeSelect = async <RowT>(
  connection: OracleDiagnosticsConnection,
  sql: string,
  binds: Record<string, unknown> = {}
): Promise<{ rows?: RowT[] }> => {
  assertSelectOnly(sql);
  return connection.execute<RowT>(sql, binds, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
  });
};

const trySelectRows = async <RowT>(
  connection: OracleDiagnosticsConnection,
  sql: string,
  binds: Record<string, unknown>,
  reason: string
): Promise<QueryResult<RowT>> => {
  try {
    const result = await executeSelect<RowT>(connection, sql, binds);
    return { rows: result.rows ?? [] };
  } catch (error) {
    return { rows: [], error: diagnosticsError(reason, error) };
  }
};

const tableNameFilter = (
  tableNames: string[]
): { sql: string; binds: Record<string, string> } => {
  const binds: Record<string, string> = {};
  const placeholders = tableNames.map((tableName, index) => {
    const bindName = `table_${index}`;
    binds[bindName] = tableName;
    return `:${bindName}`;
  });
  return {
    sql: placeholders.join(", "),
    binds,
  };
};

const numberValue = (value: unknown): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const upper = (value: string): string => value.toUpperCase();

const dataTypeMatches = (
  actualDataType: string | undefined,
  expectedDataTypes: string[]
): boolean => {
  if (!actualDataType) return false;
  const normalized = upper(actualDataType);
  return expectedDataTypes.some((expected) => {
    const normalizedExpected = upper(expected);
    if (normalized === normalizedExpected) return true;
    if (normalized.startsWith(`${normalizedExpected}(`)) return true;
    if (normalizedExpected === "TIMESTAMP WITH TIME ZONE") {
      return (
        normalized.includes("TIMESTAMP") &&
        normalized.includes("WITH TIME ZONE")
      );
    }
    return false;
  });
};

const groupByTable = <T extends { tableName: string }>(
  rows: T[]
): Map<string, T[]> => {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const tableName = upper(row.tableName);
    const values = grouped.get(tableName) ?? [];
    values.push(row);
    grouped.set(tableName, values);
  }
  return grouped;
};

export const getOracleRuntimeDiagnostics = (
  oracledbModule: OracleDbModuleDiagnostics,
  connection: OracleDiagnosticsConnection
): OracleRuntimeDiagnostics => {
  const version =
    oracledbModule.versionString ?? String(oracledbModule.version ?? "");
  return {
    nodeVersion: process.version,
    ...(version ? { nodeOracledbVersion: version } : {}),
    nodeOracledbMode:
      typeof oracledbModule.thin === "boolean"
        ? oracledbModule.thin
          ? "thin"
          : "thick"
        : "unknown",
    ...(typeof connection.oracleServerVersion === "number"
      ? { oracleServerVersion: connection.oracleServerVersion }
      : {}),
    ...(typeof connection.oracleServerVersionString === "string"
      ? { oracleServerVersionString: connection.oracleServerVersionString }
      : {}),
  };
};

export const inspectOracleMigrations = async (
  connection: OracleDiagnosticsConnection,
  tableName: string,
  expectedForCurrentConfig: number[],
  knownVersions: number[]
): Promise<OracleMigrationDiagnostics> => {
  try {
    const result = await executeSelect<{ V?: number; v?: number }>(
      connection,
      `SELECT v FROM ${tableName} ORDER BY v`,
      {}
    );
    const applied = (result.rows ?? [])
      .map((row) => numberValue(row.V ?? row.v))
      .filter((version): version is number => version !== undefined)
      .sort((left, right) => left - right);
    const knownMax = knownVersions.length > 0 ? Math.max(...knownVersions) : -1;
    return {
      tableName,
      applied,
      latestApplied: applied.length > 0 ? Math.max(...applied) : null,
      expectedForCurrentConfig,
      pending: expectedForCurrentConfig.filter(
        (version) => !applied.includes(version)
      ),
      future: applied.filter((version) => version > knownMax),
      status: "available",
    };
  } catch (error) {
    if (isOracleError(error, 942)) {
      return {
        tableName,
        applied: [],
        latestApplied: null,
        expectedForCurrentConfig,
        pending: [...expectedForCurrentConfig],
        future: [],
        status: "missing",
      };
    }
    return {
      tableName,
      applied: [],
      latestApplied: null,
      expectedForCurrentConfig,
      pending: [],
      future: [],
      status: "unknown",
      error: diagnosticsError("migration_query_failed", error),
    };
  }
};

export const inspectOracleSchema = async (
  connection: OracleDiagnosticsConnection,
  expectedTables: ExpectedOracleTable[],
  options: OracleDiagnosticsOptions = {}
): Promise<OracleSchemaDiagnostics> => {
  const tableNames = expectedTables.map((table) => table.name);
  const tableFilter = tableNameFilter(tableNames);
  const errors: OracleDiagnosticsError[] = [];
  const metadataAvailability: OracleSchemaDiagnostics["metadataAvailability"] =
    {
      tables: "available",
      columns: "available",
      constraints: "available",
      indexes: "available",
      jsonColumns: "available",
      vectorInfo: "available",
    };

  const tableRows = await trySelectRows<{
    TABLE_NAME?: string;
    table_name?: string;
  }>(
    connection,
    `SELECT table_name
FROM USER_TABLES
WHERE table_name IN (${tableFilter.sql})`,
    tableFilter.binds,
    "table_metadata_query_failed"
  );
  if (tableRows.error) {
    metadataAvailability.tables = "unknown";
    errors.push(tableRows.error);
  }
  const existingTables = new Set(
    tableRows.rows
      .map((row) => row.TABLE_NAME ?? row.table_name)
      .filter((name): name is string => typeof name === "string")
      .map(upper)
  );

  const columnRows = await trySelectRows<OracleRow>(
    connection,
    `SELECT table_name, column_name, data_type, data_length, data_precision, nullable
FROM USER_TAB_COLUMNS
WHERE table_name IN (${tableFilter.sql})`,
    tableFilter.binds,
    "column_metadata_query_failed"
  );
  if (columnRows.error) {
    metadataAvailability.columns = "unknown";
    errors.push(columnRows.error);
  }
  const columns = columnRows.rows.map((row) => ({
    tableName: rowValue<string>(row, "table_name") ?? "",
    name: rowValue<string>(row, "column_name") ?? "",
    dataType: rowValue<string>(row, "data_type") ?? "UNKNOWN",
    nullable: (rowValue<string>(row, "nullable") ?? "Y") === "Y",
    dataLength: numberValue(rowValue(row, "data_length")),
    dataPrecision: numberValue(rowValue(row, "data_precision")),
  }));
  const columnsByTable = groupByTable(columns);

  const constraintRows = await trySelectRows<OracleRow>(
    connection,
    `SELECT c.table_name, c.constraint_name, c.constraint_type, c.status, c.index_name,
       cc.column_name, cc.position
FROM USER_CONSTRAINTS c
LEFT JOIN USER_CONS_COLUMNS cc
  ON cc.constraint_name = c.constraint_name
 AND cc.table_name = c.table_name
WHERE c.table_name IN (${tableFilter.sql})
  AND c.constraint_type IN ('P', 'C')
ORDER BY c.table_name, c.constraint_name, cc.position`,
    tableFilter.binds,
    "constraint_metadata_query_failed"
  );
  if (constraintRows.error) {
    metadataAvailability.constraints = "unknown";
    errors.push(constraintRows.error);
  }

  const indexRows = await trySelectRows<OracleRow>(
    connection,
    `SELECT i.table_name, i.index_name, i.uniqueness, i.index_type,
       ic.column_name, ic.column_position
FROM USER_INDEXES i
LEFT JOIN USER_IND_COLUMNS ic
  ON ic.index_name = i.index_name
 AND ic.table_name = i.table_name
WHERE i.table_name IN (${tableFilter.sql})
ORDER BY i.table_name, i.index_name, ic.column_position`,
    tableFilter.binds,
    "index_metadata_query_failed"
  );
  if (indexRows.error) {
    metadataAvailability.indexes = "unknown";
    errors.push(indexRows.error);
  }
  const indexes = buildIndexDiagnostics(indexRows.rows);
  const indexesByTable = groupByTable(indexes);

  const jsonRows = await trySelectRows<OracleRow>(
    connection,
    `SELECT table_name, column_name
FROM USER_JSON_COLUMNS
WHERE table_name IN (${tableFilter.sql})`,
    tableFilter.binds,
    "json_metadata_query_failed"
  );
  if (jsonRows.error) {
    metadataAvailability.jsonColumns = "unknown";
    errors.push(jsonRows.error);
  }
  const jsonColumnsByTable = groupByTable(
    jsonRows.rows.map((row) => ({
      tableName: rowValue<string>(row, "table_name") ?? "",
      columnName: rowValue<string>(row, "column_name") ?? "",
    }))
  );

  const vectorRows = await trySelectRows<OracleRow>(
    connection,
    `SELECT table_name, column_name, vector_info
FROM USER_TAB_COLUMNS
WHERE table_name IN (${tableFilter.sql})
  AND data_type = 'VECTOR'`,
    tableFilter.binds,
    "vector_metadata_query_failed"
  );
  if (vectorRows.error) {
    metadataAvailability.vectorInfo = "unknown";
  }
  const vectorColumnsByTable = groupByTable(
    vectorRows.rows.map((row) => ({
      tableName: rowValue<string>(row, "table_name") ?? "",
      columnName: rowValue<string>(row, "column_name") ?? "",
      vectorInfo: rowValue<string>(row, "vector_info"),
    }))
  );

  const rowCounts = options.includeRowCounts
    ? await inspectRowCounts(connection, tableNames, existingTables, errors)
    : new Map<string, number>();

  const tables = expectedTables.map((expectedTable) =>
    buildTableDiagnostics({
      expectedTable,
      exists: existingTables.has(upper(expectedTable.name)),
      columns: columnsByTable.get(upper(expectedTable.name)) ?? [],
      constraints: constraintRows.rows,
      indexes: indexesByTable.get(upper(expectedTable.name)) ?? [],
      jsonColumns:
        metadataAvailability.jsonColumns === "available"
          ? (jsonColumnsByTable.get(upper(expectedTable.name)) ?? []).map(
              (row) => upper(row.columnName)
            )
          : "unknown",
      vectorColumns:
        metadataAvailability.vectorInfo === "available"
          ? (vectorColumnsByTable.get(upper(expectedTable.name)) ?? []).map(
              (row) => ({
                columnName: upper(row.columnName),
                ...(row.vectorInfo ? { vectorInfo: row.vectorInfo } : {}),
              })
            )
          : "unknown",
      rowCount: rowCounts.get(upper(expectedTable.name)),
      metadataAvailability,
    })
  );

  return {
    metadataAvailability,
    tables,
    issues: buildSchemaIssues(tables),
    errors,
  };
};

export const getOracleDiagnosticsStatus = (
  schema: OracleSchemaDiagnostics,
  migrations: OracleMigrationDiagnostics
): OracleDiagnosticsStatus => {
  if (schema.metadataAvailability.tables === "unknown") return "unknown";

  const requiredTables = schema.tables.filter((table) => table.required);
  const presentRequiredCount = requiredTables.filter(
    (table) => table.exists
  ).length;
  if (presentRequiredCount === 0) return "missing";
  if (requiredTables.some((table) => !table.exists)) return "partial";
  if (migrations.future.length > 0) return "future_migration";
  if (migrations.status === "unknown") return "unknown";
  if (migrations.pending.length > 0) return "migration_pending";
  if (schema.issues.length > 0) return "partial";

  if (
    schema.metadataAvailability.columns === "unknown" ||
    schema.metadataAvailability.constraints === "unknown" ||
    schema.metadataAvailability.indexes === "unknown" ||
    requiredTables.some(
      (table) =>
        table.expectedJsonColumns.length > 0 && table.jsonColumns === "unknown"
    )
  ) {
    return "unknown";
  }

  return "ready";
};

export const probeOracleVector = async (
  connection: OracleDiagnosticsConnection,
  dims: number
): Promise<OracleStoreVectorDiagnostics["probe"]> => {
  const safeDims =
    typeof dims === "number" && Number.isFinite(dims) && dims > 0
      ? Math.min(Math.floor(dims), ORACLE_VECTOR_MAX_DIMENSIONS)
      : 1;
  const vectorValues = new Array(safeDims).fill(0) as number[];
  vectorValues[0] = 1;
  const vector = `[${vectorValues.join(",")}]`;
  try {
    await executeSelect(
      connection,
      `SELECT 1 - VECTOR_DISTANCE(TO_VECTOR(:probe_vector), TO_VECTOR(:probe_vector), COSINE) AS score
FROM dual`,
      { probe_vector: vector }
    );
    return { status: "available" };
  } catch (error) {
    const diagnosticError = diagnosticsError("vector_probe_failed", error);
    return {
      status:
        diagnosticError.code !== undefined &&
        VECTOR_UNAVAILABLE_CODES.has(diagnosticError.code)
          ? "unavailable"
          : "unknown",
      error: diagnosticError,
    };
  }
};

const inspectRowCounts = async (
  connection: OracleDiagnosticsConnection,
  tableNames: string[],
  existingTables: Set<string>,
  errors: OracleDiagnosticsError[]
): Promise<Map<string, number>> => {
  const rowCounts = new Map<string, number>();
  for (const tableName of tableNames) {
    if (!existingTables.has(upper(tableName))) continue;
    const result = await trySelectRows<OracleRow>(
      connection,
      `SELECT COUNT(*) AS row_count FROM ${tableName}`,
      {},
      "row_count_query_failed"
    );
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    const count = numberValue(rowValue(result.rows[0] ?? {}, "row_count"));
    if (count !== undefined) rowCounts.set(upper(tableName), count);
  }
  return rowCounts;
};

const buildIndexDiagnostics = (rows: OracleRow[]): OracleIndexDiagnostics[] => {
  const indexes = new Map<string, OracleIndexDiagnostics>();
  for (const row of rows) {
    const tableName = rowValue<string>(row, "table_name");
    const indexName = rowValue<string>(row, "index_name");
    if (!tableName || !indexName) continue;

    const key = `${upper(tableName)}.${upper(indexName)}`;
    const existing =
      indexes.get(key) ??
      ({
        name: upper(indexName),
        tableName: upper(tableName),
        uniqueness: rowValue<string>(row, "uniqueness") ?? "UNKNOWN",
        indexType: rowValue<string>(row, "index_type") ?? "UNKNOWN",
        columns: [],
      } satisfies OracleIndexDiagnostics);

    const columnName = rowValue<string>(row, "column_name");
    if (columnName) existing.columns.push(upper(columnName));
    indexes.set(key, existing);
  }
  return Array.from(indexes.values());
};

const buildTableDiagnostics = ({
  expectedTable,
  exists,
  columns,
  constraints,
  indexes,
  jsonColumns,
  vectorColumns,
  rowCount,
  metadataAvailability,
}: {
  expectedTable: ExpectedOracleTable;
  exists: boolean;
  columns: OracleColumnDiagnostics[];
  constraints: OracleRow[];
  indexes: OracleIndexDiagnostics[];
  jsonColumns: string[] | "unknown";
  vectorColumns: OracleVectorColumnDiagnostics[] | "unknown";
  rowCount?: number;
  metadataAvailability: OracleSchemaDiagnostics["metadataAvailability"];
}): OracleTableDiagnostics => {
  const observedColumnNames = new Set(
    columns.map((column) => upper(column.name))
  );
  const expectedColumns = expectedTable.columns.map((column) => ({
    ...column,
    name: upper(column.name),
    dataTypes: column.dataTypes.map(upper),
  }));
  const missingColumns =
    metadataAvailability.columns === "available" && exists
      ? expectedColumns
          .filter((column) => !observedColumnNames.has(column.name))
          .map((column) => column.name)
      : [];
  const mismatchedColumns =
    metadataAvailability.columns === "available" && exists
      ? expectedColumns
          .map((expectedColumn) => {
            const observed = columns.find(
              (column) => upper(column.name) === expectedColumn.name
            );
            if (
              !observed ||
              dataTypeMatches(observed.dataType, expectedColumn.dataTypes)
            ) {
              return undefined;
            }
            return {
              name: expectedColumn.name,
              expectedDataTypes: expectedColumn.dataTypes,
              actualDataType: observed.dataType,
            };
          })
          .filter(
            (
              mismatch
            ): mismatch is {
              name: string;
              expectedDataTypes: string[];
              actualDataType: string;
            } => mismatch !== undefined
          )
      : [];

  const expectedJsonColumns = (expectedTable.jsonColumns ?? []).map(upper);
  const missingJsonColumns =
    jsonColumns === "unknown"
      ? "unknown"
      : expectedJsonColumns.filter((column) => !jsonColumns.includes(column));

  return {
    name: expectedTable.name,
    required: expectedTable.required,
    exists,
    ...(rowCount !== undefined ? { rowCount } : {}),
    columns,
    missingColumns,
    mismatchedColumns,
    primaryKey: expectedTable.primaryKey
      ? buildPrimaryKeyDiagnostics({
          tableName: expectedTable.name,
          expectedColumns: expectedTable.primaryKey.map(upper),
          constraints,
          indexes,
          metadataAvailability,
        })
      : undefined,
    jsonColumns,
    expectedJsonColumns,
    missingJsonColumns,
    indexes,
    vectorColumns,
  };
};

const buildPrimaryKeyDiagnostics = ({
  tableName,
  expectedColumns,
  constraints,
  indexes,
  metadataAvailability,
}: {
  tableName: string;
  expectedColumns: string[];
  constraints: OracleRow[];
  indexes: OracleIndexDiagnostics[];
  metadataAvailability: OracleSchemaDiagnostics["metadataAvailability"];
}): OraclePrimaryKeyDiagnostics => {
  if (metadataAvailability.constraints === "unknown") {
    return {
      status: "unknown",
      expectedColumns,
      observedColumns: [],
      backingIndexStatus: "unknown",
    };
  }

  const pkRows = constraints.filter(
    (row) =>
      upper(rowValue<string>(row, "table_name") ?? "") === upper(tableName) &&
      rowValue<string>(row, "constraint_type") === "P"
  );
  const constraintName = rowValue<string>(pkRows[0] ?? {}, "constraint_name");
  const indexName = rowValue<string>(pkRows[0] ?? {}, "index_name");
  const observedColumns = pkRows
    .map((row) => ({
      name: upper(rowValue<string>(row, "column_name") ?? ""),
      position: numberValue(rowValue(row, "position")) ?? 0,
    }))
    .filter((column) => column.name)
    .sort((left, right) => left.position - right.position)
    .map((column) => column.name);
  const hasExpectedColumns =
    observedColumns.length === expectedColumns.length &&
    observedColumns.every((column, index) => column === expectedColumns[index]);
  const backingIndex =
    metadataAvailability.indexes === "unknown"
      ? undefined
      : indexes.find(
          (index) =>
            (indexName && index.name === upper(indexName)) ||
            (index.uniqueness === "UNIQUE" &&
              index.columns.length === expectedColumns.length &&
              index.columns.every(
                (column, position) => column === expectedColumns[position]
              ))
        );

  return {
    status: hasExpectedColumns ? "present" : "missing",
    expectedColumns,
    observedColumns,
    ...(constraintName ? { constraintName: upper(constraintName) } : {}),
    ...(indexName ? { indexName: upper(indexName) } : {}),
    backingIndexStatus:
      metadataAvailability.indexes === "unknown"
        ? "unknown"
        : backingIndex
          ? "present"
          : "missing",
  };
};

const buildSchemaIssues = (tables: OracleTableDiagnostics[]): string[] => {
  const issues: string[] = [];
  for (const table of tables) {
    if (!table.required) continue;
    if (table.required && !table.exists) {
      issues.push(`${table.name}: missing required table`);
      continue;
    }
    for (const column of table.missingColumns) {
      issues.push(`${table.name}.${column}: missing required column`);
    }
    for (const column of table.mismatchedColumns) {
      issues.push(
        `${table.name}.${column.name}: expected ${column.expectedDataTypes.join(
          " or "
        )}, found ${column.actualDataType ?? "unknown"}`
      );
    }
    if (table.primaryKey?.status === "missing") {
      issues.push(`${table.name}: missing expected primary key`);
    }
    if (table.primaryKey?.backingIndexStatus === "missing") {
      issues.push(`${table.name}: missing expected primary key index`);
    }
    if (Array.isArray(table.missingJsonColumns)) {
      for (const column of table.missingJsonColumns) {
        issues.push(`${table.name}.${column}: missing JSON column metadata`);
      }
    }
  }
  return issues;
};
