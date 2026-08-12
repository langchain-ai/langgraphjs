// Copyright (c) 2026, Oracle and/or its affiliates.
import oracledb from "oracledb";
import {
  BaseStore,
  type GetOperation,
  type Item,
  type ListNamespacesOperation,
  type MatchCondition,
  type Operation,
  type OperationResults,
  type PutOperation,
  type SearchItem,
  type SearchOperation,
} from "@langchain/langgraph-checkpoint";
import type {
  BindDefinition,
  BindParameters,
  Connection,
  DbType,
  ExecuteManyOptions,
  Pool,
} from "oracledb";
import {
  getOracleDiagnosticsStatus,
  getOracleRuntimeDiagnostics,
  inspectOracleMigrations,
  inspectOracleSchema,
  probeOracleVector,
  type ExpectedOracleTable,
  type OracleDiagnosticsOptions,
  type OracleStoreDiagnostics,
} from "../diagnostics.js";
import {
  getCreateStoreMigrationTableSQL,
  getCreateVectorMigrationTableSQL,
  STORE_MIGRATIONS,
  VECTOR_MIGRATIONS,
  type OracleStoreMigration,
  type OracleStoreMigrationContext,
} from "./migrations.js";
import {
  STORE_FIELD_PATH_MAX_BYTES,
  STORE_KEY_MAX_BYTES,
  STORE_NAMESPACE_PATH_MAX_BYTES,
  STORE_VECTOR_KEY_MAX_BYTES,
  STORE_VECTOR_NAMESPACE_PATH_MAX_BYTES,
  VECTOR_STRING_BIND_MAX_BYTES,
} from "./constants.js";
import { validateIdentifier, validateTableSuffix } from "../identifiers.js";
import {
  assertStoredIndexConfigMatches,
  defaultTableSuffix,
  distanceMetricSQL,
  scoreFromDistanceSQL,
  storeConfigDistanceType,
  storeConfigEmbedFields,
  storeConfigIndexParams,
  validateOracleIndexConfig,
  type OracleIndexConfig,
} from "./index-config.js";
import { getTextAtPath, jsonPath, jsonValueExpression } from "./json-path.js";
import {
  decodeStoreKey,
  encodeStoreKey,
  escapeLike,
  hasNamespacePrefix,
  matchesNamespaceCondition,
  namespacePath,
  namespacePrefixLikePattern,
  validateNamespace,
} from "./namespace.js";
import {
  isOracleError,
  parseOracleConnectionString,
  poolConfigToConnectionOptions,
  validateUtf8ByteLength,
  type OraclePoolConfig,
} from "../utils.js";

export interface OracleConnectionOptions {
  [key: string]: unknown;
  user?: string;
  password?: string;
  connectString?: string;
}

export interface OracleStoreOptions {
  connection?: OracleConnectionOptions;
  pool?: Pool;
  /** Shared suffix used by the Python and JavaScript Oracle Store tables. */
  tableSuffix?: string;
  ensureTable?: boolean;
  index?: OracleIndexConfig;
  /** Optional TTL behavior. Durations are expressed in minutes. */
  ttl?: OracleStoreTTLConfig;
}

export interface OracleStoreTTLConfig {
  /** Default TTL for writes that do not specify one. */
  defaultTtl?: number;
  /** Refresh an item's stored TTL when it is read. */
  refreshOnRead?: boolean;
  /** Optional interval for deleting expired items. */
  sweepIntervalMinutes?: number;
}

export interface OracleStorePutOptions {
  /** TTL for this write, in minutes. */
  ttl?: number;
}

export interface OracleStoreSearchOptions {
  filter?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  query?: string;
  /** Refresh the stored TTL for returned items. */
  refreshTtl?: boolean;
}

type OraclePutOperation = PutOperation & {
  options?: OracleStorePutOptions;
};

type OracleSearchOperation = SearchOperation & {
  refreshTtl?: boolean;
};

function validateTtlMinutes(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`${name} must be a finite number greater than 0.`);
  }
}

type StoreRow = {
  PREFIX: string;
  prefix?: string;
  KEY: string;
  key?: string;
  VALUE: Record<string, unknown>;
  value?: Record<string, unknown>;
  CREATED_AT: Date;
  created_at?: Date;
  UPDATED_AT: Date;
  updated_at?: Date;
  SCORE?: number;
  score?: number;
};

type BoundPut = {
  namespacePath: string;
  key: string;
  value: Record<string, unknown>;
  ttlMinutes: number | null;
};

type BoundDelete = {
  namespacePath: string;
  key: string;
};

type BoundVector = {
  namespacePath: string;
  key: string;
  fieldPath: string;
  embedding: number[];
};

type VectorBindStrategy = "native" | "string";

type NativeVectorBind = {
  type: DbType;
  val: Float32Array;
};

type PreparedVector = Omit<BoundVector, "embedding"> & {
  embedding: string | Float32Array;
};

type NamespacePathRow = {
  PREFIX: string;
  prefix?: string;
};

type SqlFilter = {
  clause: string;
  binds: Record<string, string | number>;
};

type TableExistsRow = {
  TABLE_EXISTS: number;
  table_exists?: number;
};

type StoreConfigRow = {
  DETECTED_DIMS?: number;
  detected_dims?: number;
  DISTANCE_TYPE?: string;
  distance_type?: string;
  INDEX_PARAMS?: unknown;
  index_params?: unknown;
};

type NamespaceSqlFilter = {
  clause: string;
  binds: Record<string, string>;
  fullyPushed: boolean;
};

function withActiveItemPredicate(clause: string): string {
  const predicate = "(expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)";
  return clause ? `${clause} AND ${predicate}` : `WHERE ${predicate}`;
}

const getExpectedStoreTables = (
  tables: {
    store: string;
    storeVectors: string;
    storeMigrations: string;
    vectorMigrations: string;
  },
  vectorRequired: boolean
): ExpectedOracleTable[] => [
  {
    name: tables.storeMigrations,
    required: true,
    columns: [{ name: "v", dataTypes: ["NUMBER"] }],
    primaryKey: ["v"],
  },
  {
    name: tables.vectorMigrations,
    required: vectorRequired,
    columns: [{ name: "v", dataTypes: ["NUMBER"] }],
    primaryKey: ["v"],
  },
  {
    name: tables.store,
    required: true,
    columns: [
      { name: "prefix", dataTypes: ["VARCHAR2"] },
      { name: "key", dataTypes: ["VARCHAR2"] },
      { name: "value", dataTypes: ["JSON"] },
      { name: "created_at", dataTypes: ["TIMESTAMP WITH TIME ZONE"] },
      { name: "updated_at", dataTypes: ["TIMESTAMP WITH TIME ZONE"] },
      { name: "expires_at", dataTypes: ["TIMESTAMP WITH TIME ZONE"] },
      { name: "ttl_minutes", dataTypes: ["NUMBER"] },
    ],
    primaryKey: ["prefix", "key"],
    jsonColumns: ["value"],
  },
  {
    name: tables.storeVectors,
    required: vectorRequired,
    columns: [
      { name: "prefix", dataTypes: ["VARCHAR2"] },
      { name: "key", dataTypes: ["VARCHAR2"] },
      { name: "field_name", dataTypes: ["VARCHAR2"] },
      { name: "embedding", dataTypes: ["VECTOR"] },
      { name: "created_at", dataTypes: ["TIMESTAMP WITH TIME ZONE"] },
    ],
    primaryKey: ["prefix", "key", "field_name"],
  },
];

const STORE_BYTE_CONTEXT = "OracleStore";

function validateNamespacePathLength(namespace: string[]): void {
  validateUtf8ByteLength(
    STORE_BYTE_CONTEXT,
    "namespace path",
    namespacePath(namespace),
    STORE_NAMESPACE_PATH_MAX_BYTES
  );
}

function validateStoreKey(key: string): void {
  if (key.length === 0) {
    throw new Error("OracleStore keys cannot be empty strings.");
  }
  validateUtf8ByteLength(
    STORE_BYTE_CONTEXT,
    "key",
    encodeStoreKey(key),
    STORE_KEY_MAX_BYTES
  );
}

function validateVectorValues(vector: number[]): void {
  for (const [index, value] of vector.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `OracleStore embedding values must be finite numbers. Invalid value at index ${index}.`
      );
    }
  }
}

function vectorLiteral(vector: number[]): string {
  validateVectorValues(vector);
  const literal = `[${vector.join(",")}]`;
  const byteLength = Buffer.byteLength(literal, "utf8");
  if (byteLength > VECTOR_STRING_BIND_MAX_BYTES) {
    throw new Error(
      `OracleStore vector literal exceeds ${VECTOR_STRING_BIND_MAX_BYTES} bytes. Received ${byteLength} bytes.`
    );
  }
  return literal;
}

function nativeVectorValue(vector: number[]): Float32Array {
  validateVectorValues(vector);
  return Float32Array.from(vector);
}

function nativeVectorBind(vector: number[]): NativeVectorBind {
  if (oracledb.DB_TYPE_VECTOR === undefined) {
    throw new Error("node-oracledb DB_TYPE_VECTOR is unavailable.");
  }
  return {
    type: oracledb.DB_TYPE_VECTOR,
    val: nativeVectorValue(vector),
  };
}

function vectorBindValue(vector: number[], strategy: "native"): Float32Array;
function vectorBindValue(vector: number[], strategy: "string"): string;
function vectorBindValue(
  vector: number[],
  strategy: VectorBindStrategy
): string | Float32Array;
function vectorBindValue(
  vector: number[],
  strategy: VectorBindStrategy
): string | Float32Array {
  return strategy === "native"
    ? nativeVectorValue(vector)
    : vectorLiteral(vector);
}

function vectorBindDef(strategy: VectorBindStrategy): BindDefinition {
  return strategy === "native"
    ? { type: oracledb.DB_TYPE_VECTOR }
    : {
        type: oracledb.STRING,
        maxSize: VECTOR_STRING_BIND_MAX_BYTES,
      };
}

function isUnsupportedNativeVectorBindError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return ["NJS-012", "NJS-144", "NJS-145"].includes(String(error.code));
}

function vectorExpression(
  bindName: string,
  strategy: VectorBindStrategy
): string {
  return strategy === "native" ? `:${bindName}` : `TO_VECTOR(:${bindName})`;
}

function probeVector(dims: number): number[] {
  const vector = new Array(dims).fill(0) as number[];
  vector[0] = 1;
  return vector;
}

function stringifyStoreValue(value: unknown): string {
  const ancestors: object[] = [];
  try {
    const json = JSON.stringify(
      value,
      function (this: unknown, _key, nestedValue) {
        if (typeof nestedValue === "number" && !Number.isFinite(nestedValue)) {
          throw new Error("contains a non-finite number");
        }
        if (
          nestedValue === undefined ||
          typeof nestedValue === "function" ||
          typeof nestedValue === "symbol" ||
          typeof nestedValue === "bigint"
        ) {
          throw new Error(`contains unsupported ${typeof nestedValue} value`);
        }
        if (typeof nestedValue === "object" && nestedValue !== null) {
          while (
            ancestors.length > 0 &&
            ancestors[ancestors.length - 1] !== this
          ) {
            ancestors.pop();
          }
          if (ancestors.includes(nestedValue)) {
            throw new Error("contains circular references");
          }
          ancestors.push(nestedValue);
        }
        return nestedValue;
      }
    );
    if (json === undefined) {
      throw new Error("resolved to undefined");
    }
    return json;
  } catch (error) {
    const message =
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error);
    throw new Error(`OracleStore values must be JSON-serializable: ${message}`);
  }
}

function rowToItem(row: StoreRow): Item {
  const prefix = row.PREFIX ?? row.prefix ?? "";
  return {
    key: decodeStoreKey(row.KEY ?? row.key ?? ""),
    namespace: prefix.split("."),
    value: row.VALUE ?? row.value ?? {},
    createdAt: row.CREATED_AT ?? row.created_at ?? new Date(),
    updatedAt: row.UPDATED_AT ?? row.updated_at ?? new Date(),
  };
}

function rowToSearchItem(row: StoreRow): SearchItem {
  const item = rowToItem(row);
  const score = row.SCORE ?? row.score;
  return score === undefined ? item : { ...item, score: Number(score) };
}

function buildNamespaceSqlFilter(
  conditions: MatchCondition[] | undefined
): NamespaceSqlFilter {
  if (!conditions || conditions.length === 0) {
    return { clause: "", binds: {}, fullyPushed: true };
  }

  const clauses: string[] = [];
  const binds: Record<string, string> = {};
  let fullyPushed = true;

  conditions.forEach((condition, index) => {
    if (condition.path.some((label) => label === "*")) {
      fullyPushed = false;
      return;
    }

    const path = condition.path as string[];
    if (path.length === 0) return;

    if (condition.matchType === "prefix") {
      binds[`namespacePrefixExact_${index}`] = namespacePath(path);
      binds[`namespacePrefixLike_${index}`] = namespacePrefixLikePattern(path);
      clauses.push(
        `(prefix = :namespacePrefixExact_${index} OR prefix LIKE :namespacePrefixLike_${index} ESCAPE '\\')`
      );
      return;
    }

    binds[`namespaceSuffixExact_${index}`] = namespacePath(path);
    binds[`namespaceSuffixLike_${index}`] =
      `%.${escapeLike(namespacePath(path))}`;
    clauses.push(
      `(prefix = :namespaceSuffixExact_${index} OR prefix LIKE :namespaceSuffixLike_${index} ESCAPE '\\')`
    );
  });

  return {
    clause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    binds,
    fullyPushed,
  };
}

type FilterOperators = {
  $eq?: unknown;
  $ne?: unknown;
  $gt?: unknown;
  $gte?: unknown;
  $lt?: unknown;
  $lte?: unknown;
  $in?: unknown[];
  $nin?: unknown[];
  $exists?: boolean;
};

function isFilterOperators(value: unknown): value is FilterOperators {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).every(
      (key) =>
        ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"].includes(
          key
        ) || key === "$exists"
    )
  );
}

function buildSqlFilter(
  filter: Record<string, unknown> | undefined,
  column = "value"
): SqlFilter | undefined {
  if (!filter || Object.keys(filter).length === 0) {
    return { clause: "", binds: {} };
  }

  const clauses: string[] = [];
  const binds: Record<string, string | number> = {};
  let bindIndex = 0;

  const addBind = (value: string | number): string => {
    const name = `filter_${bindIndex}`;
    bindIndex += 1;
    binds[name] = value;
    return `:${name}`;
  };

  for (const [field, expected] of Object.entries(filter)) {
    const existsPath = jsonPath(field);
    if (!existsPath) return undefined;
    const jsonAtPath = `JSON_QUERY(${column}, ${existsPath})`;

    if (!isFilterOperators(expected)) {
      clauses.push(
        `JSON_EQUAL(${jsonAtPath}, ${addBind(JSON.stringify(expected))})`
      );
      continue;
    }

    for (const [operator, rawValue] of Object.entries(expected)) {
      if (operator === "$exists") {
        clauses.push(
          rawValue
            ? `JSON_EXISTS(${column}, ${existsPath})`
            : `NOT JSON_EXISTS(${column}, ${existsPath})`
        );
        continue;
      }

      if (operator === "$in" || operator === "$nin") {
        if (!Array.isArray(rawValue)) return undefined;
        if (rawValue.length === 0) {
          clauses.push(operator === "$in" ? "1 = 0" : "1 = 1");
          continue;
        }
        const comparisons = rawValue.map(
          (value) =>
            `JSON_EQUAL(${jsonAtPath}, ${addBind(JSON.stringify(value))})`
        );
        clauses.push(
          operator === "$in"
            ? `(${comparisons.join(" OR ")})`
            : `NOT (${comparisons.join(" OR ")})`
        );
        continue;
      }

      if (
        operator === "$gt" ||
        operator === "$gte" ||
        operator === "$lt" ||
        operator === "$lte"
      ) {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return undefined;
        const expression = jsonValueExpression(field, "number", column);
        if (!expression) return undefined;
        const sqlOperator = {
          $gt: ">",
          $gte: ">=",
          $lt: "<",
          $lte: "<=",
        }[operator];
        clauses.push(`${expression} ${sqlOperator} ${addBind(value)}`);
        continue;
      }

      const bind = addBind(JSON.stringify(rawValue));
      switch (operator) {
        case "$eq":
          clauses.push(`JSON_EQUAL(${jsonAtPath}, ${bind})`);
          break;
        case "$ne":
          clauses.push(`NOT JSON_EQUAL(${jsonAtPath}, ${bind})`);
          break;
        default:
          return undefined;
      }
    }
  }

  return {
    clause: clauses.length ? ` AND ${clauses.join(" AND ")}` : "",
    binds,
  };
}

/**
 * Minimal Oracle Database backed implementation of the LangGraph BaseStore.
 *
 * Stores JSON values in Oracle Database and supports BaseStore get,
 * put/delete, namespace-prefix search, operator filters, listNamespaces, and
 * Oracle VECTOR search when constructed with an index configuration.
 */
export class OracleStore extends BaseStore {
  private pool?: Pool;

  private poolPromise?: Promise<Pool>;

  private readonly connectionOptions?: OracleConnectionOptions;

  private readonly ownsPool: boolean;

  private readonly tableName: string;

  private readonly vectorTableName: string;

  private readonly migrationTableName: string;

  private readonly vectorMigrationTableName: string;

  private readonly tableSuffix: string;

  private readonly ensureTable: boolean;

  private readonly indexConfig?: OracleIndexConfig;

  /**
   * Only a caller-supplied suffix is validated against `STORE_CONFIGS`; a
   * derived suffix already encodes the configuration. Mirrors Python's
   * `_needs_validation`.
   */
  private readonly needsConfigValidation: boolean;

  private readonly ttlConfig?: OracleStoreTTLConfig;

  private ttlSweepTimer?: ReturnType<typeof setInterval>;

  private isSetup = false;

  private setupPromise?: Promise<void>;

  private vectorBindStrategy?: VectorBindStrategy;

  private nativeVectorDmlProbed = false;

  constructor(options: OracleStoreOptions = {}) {
    super();
    this.pool = options.pool;
    this.connectionOptions = options.connection;
    this.ownsPool = options.pool === undefined;
    // Validate before deriving the suffix: the suffix is a hash of these very
    // values, so an unchecked configuration must never reach it.
    if (options.index) validateOracleIndexConfig(options.index);
    const explicitSuffix = options.tableSuffix;
    this.tableSuffix = explicitSuffix
      ? validateTableSuffix(explicitSuffix)
      : defaultTableSuffix(options.index);
    this.needsConfigValidation =
      explicitSuffix !== undefined && options.index !== undefined;
    this.tableName = validateIdentifier(`STORE_${this.tableSuffix}`);
    this.vectorTableName = validateIdentifier(
      `STORE_VECTORS_${this.tableSuffix}`
    );
    this.migrationTableName = validateIdentifier(
      `STORE_MIGRATIONS_${this.tableSuffix}`
    );
    this.vectorMigrationTableName = validateIdentifier(
      `VECTOR_MIGRATIONS_${this.tableSuffix}`
    );
    this.ensureTable = options.ensureTable ?? true;
    this.indexConfig = options.index;
    validateTtlMinutes("OracleStore ttl.defaultTtl", options.ttl?.defaultTtl);
    validateTtlMinutes(
      "OracleStore ttl.sweepIntervalMinutes",
      options.ttl?.sweepIntervalMinutes
    );
    this.ttlConfig = options.ttl;
  }

  /**
   * Build a store from a `user/password@dsn` connection string, as Python's
   * `OracleStore.from_conn_string` does.
   */
  static fromConnString(
    connString: string,
    options: Omit<OracleStoreOptions, "connection" | "pool"> & {
      poolConfig?: OraclePoolConfig;
    } = {}
  ): OracleStore {
    const { poolConfig, ...storeOptions } = options;
    return new OracleStore({
      connection: {
        ...parseOracleConnectionString(connString),
        ...poolConfigToConnectionOptions(poolConfig),
      },
      ...storeOptions,
    });
  }

  async put(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    index?: false | string[],
    options?: OracleStorePutOptions
  ): Promise<void> {
    validateTtlMinutes("OracleStore put options.ttl", options?.ttl);
    await this.batch([
      { namespace, key, value, index, options } as OraclePutOperation,
    ] as [PutOperation]);
  }

  async search(
    namespacePrefix: string[],
    options: OracleStoreSearchOptions = {}
  ): Promise<SearchItem[]> {
    const { filter, limit = 10, offset = 0, query, refreshTtl } = options;
    return (
      await this.batch([
        {
          namespacePrefix,
          filter,
          limit,
          offset,
          query,
          refreshTtl,
        } as OracleSearchOperation,
      ] as [SearchOperation])
    )[0];
  }

  async batch<Op extends Operation[]>(
    operations: Op
  ): Promise<OperationResults<Op>> {
    await this.setup();

    const results: unknown[] = new Array(operations.length);
    let i = 0;
    while (i < operations.length) {
      const op = operations[i];

      if ("value" in op) {
        const putOps: Array<{ index: number; op: OraclePutOperation }> = [];
        let j = i;
        while (j < operations.length && "value" in operations[j]) {
          putOps.push({ index: j, op: operations[j] as OraclePutOperation });
          j += 1;
        }
        await this.batchPuts(putOps, results);
        i = j;
        continue;
      }

      if ("key" in op && !("namespacePrefix" in op)) {
        results[i] = await this.getOp(op as GetOperation);
      } else if ("namespacePrefix" in op) {
        results[i] = await this.searchOp(op as OracleSearchOperation);
      } else {
        results[i] = await this.listNamespacesOp(op as ListNamespacesOperation);
      }
      i += 1;
    }

    return results as OperationResults<Op>;
  }

  async start(): Promise<void> {
    await this.setup();
  }

  async stop(): Promise<void> {
    if (this.ttlSweepTimer) {
      clearInterval(this.ttlSweepTimer);
      this.ttlSweepTimer = undefined;
    }
    try {
      if (!this.pool && this.poolPromise && this.ownsPool) {
        try {
          await this.poolPromise;
        } catch {
          // Pool creation already failed for the operation that requested it.
        }
      }
      if (this.pool && this.ownsPool) {
        await this.pool.close(0);
        this.pool = undefined;
      }
    } finally {
      this.isSetup = false;
      this.setupPromise = undefined;
      this.poolPromise = undefined;
      this.vectorBindStrategy = undefined;
      this.nativeVectorDmlProbed = false;
    }
  }

  async sweepExpiredItems(): Promise<number> {
    await this.setup();
    return this.withConnection(async (connection) => {
      try {
        const result = await connection.execute(
          `DELETE FROM ${this.tableName}
WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP`
        );
        await connection.commit();
        return result.rowsAffected ?? 0;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  async getDiagnostics(
    options: OracleDiagnosticsOptions = {}
  ): Promise<OracleStoreDiagnostics> {
    await this.ensurePool();
    return this.withConnection(async (connection) => {
      const tables = {
        store: this.tableName,
        storeVectors: this.vectorTableName,
        storeMigrations: this.migrationTableName,
        vectorMigrations: this.vectorMigrationTableName,
      };
      const vectorRequired = this.indexConfig !== undefined;
      const expectedTables = getExpectedStoreTables(tables, vectorRequired);
      const expectedVersions = [0, 1, 2, 3, 4];
      const knownVersions = [0, 1, 2, 3, 4];
      const schema = await inspectOracleSchema(
        connection,
        expectedTables,
        options
      );
      const migrations = await inspectOracleMigrations(
        connection,
        this.migrationTableName,
        expectedVersions,
        knownVersions
      );
      const vectorProbe = await probeOracleVector(
        connection,
        this.indexConfig?.dims ?? 1
      );
      const vectorTable = schema.tables.find(
        (table) => table.name === this.vectorTableName
      );
      const embeddingColumn = vectorTable?.columns.find(
        (column) => column.name.toUpperCase() === "EMBEDDING"
      );
      const vectorColumns = vectorTable?.vectorColumns;
      const vectorColumn = Array.isArray(vectorColumns)
        ? vectorColumns.find(
            (column) => column.columnName.toUpperCase() === "EMBEDDING"
          )
        : undefined;
      const schemaStatus = getOracleDiagnosticsStatus(schema, migrations);
      const status =
        vectorRequired &&
        schemaStatus === "ready" &&
        vectorProbe.status !== "available"
          ? vectorProbe.status === "unavailable"
            ? "partial"
            : "unknown"
          : schemaStatus;
      const issues = [...schema.issues];
      if (vectorRequired && vectorProbe.status !== "available") {
        issues.push(`Oracle VECTOR probe status is ${vectorProbe.status}.`);
      }

      return {
        kind: "store",
        status,
        tableSuffix: this.tableSuffix,
        tables,
        runtime: getOracleRuntimeDiagnostics(oracledb, connection),
        migrations,
        schema,
        vector: {
          configured: vectorRequired,
          ...(this.indexConfig
            ? { configuredDims: this.indexConfig.dims }
            : {}),
          ...(this.indexConfig?.fields
            ? { configuredFields: this.indexConfig.fields }
            : {}),
          probe: vectorProbe,
          embeddingColumn: {
            status: embeddingColumn
              ? "present"
              : vectorTable?.exists
                ? "missing"
                : "unknown",
            ...(vectorColumn?.vectorInfo
              ? { vectorInfo: vectorColumn.vectorInfo }
              : {}),
          },
          observedIndexes: vectorTable?.indexes ?? [],
        },
        issues,
      };
    });
  }

  /**
   * Create the tables and run migrations. Safe to call repeatedly; `start()`
   * and every operation call it as well.
   */
  async setup(): Promise<void> {
    if (this.isSetup) return;
    this.setupPromise ??= this.doSetup().catch((error) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async doSetup(): Promise<void> {
    await this.ensurePool();

    // Runs before any DDL so an incompatible configuration fails without
    // leaving half-created tables behind, and runs even when this store does
    // not own the schema, which is when a mismatch is most likely.
    if (this.indexConfig && this.needsConfigValidation) {
      await this.withConnection((connection) =>
        this.validatePersistedStoreConfig(connection)
      );
    }

    if (this.ensureTable) {
      await this.withConnection(async (connection) => {
        try {
          const context: OracleStoreMigrationContext = {
            tables: {
              store: this.tableName,
              storeVectors: this.vectorTableName,
              storeMigrations: this.migrationTableName,
              vectorMigrations: this.vectorMigrationTableName,
            },
            index: this.indexConfig,
          };

          await this.executeCreate(
            connection,
            getCreateStoreMigrationTableSQL(context.tables)
          );
          await this.applyMigrations(
            connection,
            STORE_MIGRATIONS,
            context,
            this.migrationTableName,
            this.tableName
          );

          if (this.indexConfig) {
            await this.executeCreate(
              connection,
              getCreateVectorMigrationTableSQL(context.tables)
            );
            await this.applyMigrations(
              connection,
              VECTOR_MIGRATIONS,
              context,
              this.vectorMigrationTableName,
              this.vectorTableName
            );
            await this.validateVectorTableDimensions(connection);
            await this.registerStoreConfig(connection);
          }

          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      });
    }

    this.isSetup = true;
    this.startTtlSweeper();
  }

  private startTtlSweeper(): void {
    const intervalMinutes = this.ttlConfig?.sweepIntervalMinutes;
    if (!intervalMinutes || this.ttlSweepTimer) return;

    this.ttlSweepTimer = setInterval(
      () => {
        this.sweepExpiredItems().catch((error: unknown) => {
          console.error("OracleStore TTL sweep failed:", error);
        });
      },
      intervalMinutes * 60 * 1000
    );
    (this.ttlSweepTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Apply the versioned statements a migration table has not recorded yet.
   *
   * Mirrors Python's setup loop and the checkpoint saver's: the array index is
   * the version, entries are applied in order, and a recorded version implies
   * the table it created is still there.
   */
  private async applyMigrations(
    connection: Connection,
    migrations: OracleStoreMigration[],
    context: OracleStoreMigrationContext,
    migrationTableName: string,
    requiredTableName: string
  ): Promise<void> {
    const result = await connection.execute<{ V: number; v?: number }>(
      `SELECT v FROM ${migrationTableName} ORDER BY v DESC FETCH FIRST 1 ROW ONLY`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const currentVersion = result.rows?.[0]
      ? Number(result.rows[0].V ?? result.rows[0].v)
      : -1;

    if (currentVersion >= 0) {
      await this.assertSetupTableExists(connection, requiredTableName);
    }
    if (currentVersion >= migrations.length) {
      throw new Error(
        `OracleStore schema version ${currentVersion} in ${migrationTableName} is newer than the highest supported version ${
          migrations.length - 1
        }.`
      );
    }

    for (
      let version = currentVersion + 1;
      version < migrations.length;
      version += 1
    ) {
      const migration = migrations[version];
      if (migration.condition && !migration.condition(context)) continue;
      await this.executeMigration(connection, migration.sql(context));
      await this.insertMigration(connection, version, migrationTableName);
    }
  }

  private async executeMigration(
    connection: Connection,
    sql: string
  ): Promise<void> {
    try {
      await this.executeCreate(connection, sql);
    } catch (error) {
      // ORA-51962: the database has no vector memory area, which an HNSW index
      // requires. IVF indexes work without one.
      if (!isOracleError(error, 51962)) throw error;
      const wrapped = new Error(
        `OracleStore could not create the HNSW vector index on ${this.vectorTableName} because this database has no vector memory area. Set VECTOR_MEMORY_SIZE, or configure index.index_type = { type: "ivf" }.`
      );
      (wrapped as { cause?: unknown }).cause = error;
      throw wrapped;
    }
  }

  private async assertSetupTableExists(
    connection: Connection,
    tableName: string
  ): Promise<void> {
    const result = await connection.execute<TableExistsRow>(
      `SELECT COUNT(*) AS table_exists
FROM user_tables
WHERE table_name = :tableName`,
      { tableName: tableName.toUpperCase() },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = result.rows?.[0];
    const exists = Number(row?.TABLE_EXISTS ?? row?.table_exists ?? 0) > 0;
    if (!exists) {
      throw new Error(
        `OracleStore setup found a migration record, but ${tableName} is missing.`
      );
    }
  }

  private async insertMigration(
    connection: Connection,
    version: number,
    tableName = this.migrationTableName
  ): Promise<void> {
    try {
      await connection.execute(
        `INSERT INTO ${tableName} (v) VALUES (:version)`,
        { version }
      );
    } catch (error) {
      if (!isOracleError(error, 1)) throw error;
    }
  }

  private async executeCreate(
    connection: Connection,
    sql: string
  ): Promise<void> {
    try {
      await connection.execute(sql);
    } catch (error) {
      // ORA-01408 is expected for Python migration 4 because the primary key
      // on STORE_CONFIGS already provides an index on table_suffix.
      if (!isOracleError(error, 955) && !isOracleError(error, 1408)) {
        throw error;
      }
    }
  }

  private async validateVectorTableDimensions(
    connection: Connection
  ): Promise<void> {
    if (!this.indexConfig) return;

    const namespacePathValue = namespacePath(["__langgraph_dimension_probe__"]);
    const key = `__probe_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}__`;
    const fieldPath = "__probe__";
    const embedding = probeVector(this.indexConfig.dims);
    const strategy = await this.resolveVectorBindStrategy(connection, true);
    if (strategy === "native") return;

    await this.createVectorProbeParent(connection, namespacePathValue, key);
    try {
      await connection.execute(
        `DELETE FROM ${this.vectorTableName}
WHERE prefix = :namespacePath AND key = :key AND field_name = :fieldPath`,
        {
          namespacePath: namespacePathValue,
          key,
          fieldPath,
        }
      );
      await connection.execute(
        `INSERT INTO ${this.vectorTableName} (
  prefix,
  key,
  field_name,
  embedding
) VALUES (
  :namespacePath,
  :key,
  :fieldPath,
  ${vectorExpression("embedding", strategy)}
)`,
        {
          namespacePath: namespacePathValue,
          key,
          fieldPath,
          embedding: vectorBindValue(embedding, strategy),
        }
      );
    } catch (error) {
      const message =
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
          ? ` ${error.message}`
          : "";
      throw new Error(
        `OracleStore vector table is incompatible with index dims ${this.indexConfig.dims}.${message}`
      );
    } finally {
      await connection.execute(
        `DELETE FROM ${this.tableName} WHERE prefix = :namespacePath AND key = :key`,
        { namespacePath: namespacePathValue, key }
      );
    }
  }

  /**
   * Compare this store's index configuration with the row a previous run (in
   * either language) registered for the same suffix. Mirrors Python
   * `_validate_configuration`, including its tolerance of a missing table.
   */
  private async validatePersistedStoreConfig(
    connection: Connection
  ): Promise<void> {
    if (!this.indexConfig || !this.needsConfigValidation) return;

    let result;
    try {
      result = await connection.execute<StoreConfigRow>(
        `SELECT detected_dims, distance_type, index_params
FROM STORE_CONFIGS
WHERE table_suffix = :tableSuffix`,
        { tableSuffix: this.tableSuffix },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
    } catch (error) {
      // ORA-00942: STORE_CONFIGS has not been created yet, so nothing to check.
      if (!isOracleError(error, 942)) throw error;
      return;
    }

    const row = result.rows?.[0];
    if (!row) return;

    assertStoredIndexConfigMatches(this.tableSuffix, this.indexConfig, {
      detectedDims: Number(row.DETECTED_DIMS ?? row.detected_dims),
      distanceType: String(row.DISTANCE_TYPE ?? row.distance_type ?? ""),
      indexParams: row.INDEX_PARAMS ?? row.index_params,
    });
  }

  /**
   * Record this store's vector configuration so the other language's store can
   * validate against it. Mirrors Python `_register_configuration`.
   */
  private async registerStoreConfig(connection: Connection): Promise<void> {
    if (!this.indexConfig) return;

    try {
      await connection.execute(
        `INSERT /*+ IGNORE_ROW_ON_DUPKEY_INDEX(STORE_CONFIGS (table_suffix)) */ INTO STORE_CONFIGS (
  table_suffix,
  detected_dims,
  distance_type,
  index_params,
  embed_fields,
  created_at,
  last_used
) VALUES (
  :tableSuffix,
  :detectedDims,
  :distanceType,
  :indexParams,
  :embedFields,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)`,
        {
          tableSuffix: this.tableSuffix,
          detectedDims: this.indexConfig.dims,
          distanceType: storeConfigDistanceType(this.indexConfig),
          indexParams: {
            val: storeConfigIndexParams(this.indexConfig),
            type: oracledb.DB_TYPE_JSON,
          },
          embedFields: storeConfigEmbedFields(this.indexConfig),
        }
      );
    } catch (error) {
      // ORA-00001: another session registered the same suffix first, which is
      // the expected outcome for a deterministic suffix.
      if (!isOracleError(error, 1)) throw error;
    }
  }

  private async resolveVectorBindStrategy(
    connection: Connection,
    allowDmlProbe: boolean
  ): Promise<VectorBindStrategy> {
    if (
      this.vectorBindStrategy === "native" &&
      (!allowDmlProbe || this.nativeVectorDmlProbed)
    ) {
      return this.vectorBindStrategy;
    }
    if (this.vectorBindStrategy === "string") return this.vectorBindStrategy;

    if (!this.indexConfig || oracledb.DB_TYPE_VECTOR === undefined) {
      this.vectorBindStrategy = "string";
      return this.vectorBindStrategy;
    }

    try {
      if (allowDmlProbe) {
        await this.probeNativeVectorBinding(connection);
        this.nativeVectorDmlProbed = true;
      } else {
        await this.probeNativeVectorQueryBinding(connection);
      }
      this.vectorBindStrategy = "native";
    } catch (error) {
      if (isUnsupportedNativeVectorBindError(error)) {
        this.vectorBindStrategy = "string";
      }
      this.nativeVectorDmlProbed = false;
      return "string";
    }
    return "native";
  }

  private async probeNativeVectorQueryBinding(
    connection: Connection
  ): Promise<void> {
    if (!this.indexConfig) return;
    const embedding = probeVector(this.indexConfig.dims);
    await connection.execute(
      `SELECT VECTOR_DISTANCE(
  TO_VECTOR(:probeLiteral),
  :probeVector,
  COSINE
) AS distance FROM dual`,
      {
        probeLiteral: vectorLiteral(embedding),
        probeVector: nativeVectorBind(embedding),
      }
    );
  }

  private async probeNativeVectorBinding(
    connection: Connection
  ): Promise<void> {
    if (!this.indexConfig) return;

    const namespacePathValue = namespacePath([
      "__langgraph_vector_bind_probe__",
    ]);
    const key = `__probe_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}__`;
    const fieldPath = "__probe__";
    const embedding = probeVector(this.indexConfig.dims);
    const probeRows = this.prepareVectorRows(
      [
        {
          namespacePath: namespacePathValue,
          key,
          fieldPath,
          embedding,
        },
      ],
      "native"
    );

    await this.createVectorProbeParent(connection, namespacePathValue, key);
    await connection.execute(
      `DELETE FROM ${this.vectorTableName}
WHERE prefix = :namespacePath AND key = :key AND field_name = :fieldPath`,
      {
        namespacePath: namespacePathValue,
        key,
        fieldPath,
      }
    );
    try {
      await connection.executeMany(
        `INSERT INTO ${this.vectorTableName} (
  prefix,
  key,
  field_name,
  embedding
) VALUES (
  :namespacePath,
  :key,
  :fieldPath,
  ${vectorExpression("embedding", "native")}
)`,
        // Float32Array vector binds are supported by node-oracledb but are
        // not included in the current DefinitelyTyped BindParameters union.
        probeRows as unknown as BindParameters[],
        {
          autoCommit: false,
          bindDefs: this.vectorBindDefs("native"),
        }
      );
      await connection.execute(
        `SELECT VECTOR_DISTANCE(embedding, :queryVector, COSINE) AS distance
FROM ${this.vectorTableName}
WHERE prefix = :namespacePath AND key = :key AND field_name = :fieldPath`,
        {
          namespacePath: namespacePathValue,
          key,
          fieldPath,
          queryVector: nativeVectorBind(embedding),
        }
      );
    } finally {
      await connection.execute(
        `DELETE FROM ${this.tableName} WHERE prefix = :namespacePath AND key = :key`,
        { namespacePath: namespacePathValue, key }
      );
    }
  }

  private async createVectorProbeParent(
    connection: Connection,
    namespacePathValue: string,
    key: string
  ): Promise<void> {
    await connection.execute(
      `MERGE INTO ${this.tableName} target
USING (SELECT :namespacePath AS prefix, :key AS key FROM dual) source
ON (target.prefix = source.prefix AND target.key = source.key)
WHEN NOT MATCHED THEN INSERT (prefix, key, value)
VALUES (source.prefix, source.key, JSON_OBJECT())`,
      { namespacePath: namespacePathValue, key }
    );
  }

  private async ensurePool(): Promise<Pool> {
    if (this.pool) return this.pool;
    this.poolPromise ??= oracledb
      .createPool(this.connectionOptions ?? {})
      .then((pool) => {
        this.pool = pool;
        return pool;
      })
      .catch((error) => {
        this.poolPromise = undefined;
        throw error;
      });
    return this.poolPromise;
  }

  private async withConnection<T>(
    callback: (connection: Connection) => Promise<T>
  ): Promise<T> {
    const pool = await this.ensurePool();
    const connection = await pool.getConnection();
    try {
      return await callback(connection);
    } finally {
      await connection.close();
    }
  }

  private async executeManyWithDuplicateRetry<
    T extends Record<string, unknown>,
  >(
    connection: Connection,
    sql: string,
    binds: T[],
    options: ExecuteManyOptions
  ): Promise<void> {
    // node-oracledb accepts named bind rows containing Float32Array vector
    // values, which the current DefinitelyTyped BindParameters omits.
    try {
      await connection.executeMany(
        sql,
        binds as unknown as BindParameters[],
        options
      );
    } catch (error) {
      if (!isOracleError(error, 1)) throw error;
      await connection.executeMany(
        sql,
        binds as unknown as BindParameters[],
        options
      );
    }
  }

  private prepareVectorRows(
    rows: BoundVector[],
    strategy: VectorBindStrategy
  ): PreparedVector[] {
    return rows.map((row) => ({
      namespacePath: row.namespacePath,
      key: row.key,
      fieldPath: row.fieldPath,
      embedding: vectorBindValue(row.embedding, strategy),
    }));
  }

  private vectorBindDefs(
    strategy: VectorBindStrategy
  ): Record<string, BindDefinition> {
    return {
      namespacePath: {
        type: oracledb.STRING,
        maxSize: STORE_VECTOR_NAMESPACE_PATH_MAX_BYTES,
      },
      key: { type: oracledb.STRING, maxSize: STORE_VECTOR_KEY_MAX_BYTES },
      fieldPath: { type: oracledb.STRING, maxSize: STORE_FIELD_PATH_MAX_BYTES },
      embedding: vectorBindDef(strategy),
    };
  }

  private async deleteVectorRowsIfPresent(
    connection: Connection,
    rows: Array<{ namespacePath: string; key: string }>
  ): Promise<void> {
    if (rows.length === 0) return;

    try {
      await connection.executeMany(
        `DELETE FROM ${this.vectorTableName}
WHERE prefix = :namespacePath AND key = :key`,
        rows as BindParameters[],
        {
          autoCommit: false,
          bindDefs: {
            namespacePath: {
              type: oracledb.STRING,
              maxSize: STORE_NAMESPACE_PATH_MAX_BYTES,
            },
            key: { type: oracledb.STRING, maxSize: STORE_KEY_MAX_BYTES },
          },
        }
      );
    } catch (error) {
      if (!isOracleError(error, 942)) throw error;
    }
  }

  private async batchPuts(
    putOpsWithIndex: Array<{ index: number; op: OraclePutOperation }>,
    results: unknown[]
  ): Promise<void> {
    const deduped = new Map<string, OraclePutOperation>();
    for (const { op } of putOpsWithIndex) {
      validateTtlMinutes("OracleStore put options.ttl", op.options?.ttl);
      validateNamespace(op.namespace);
      validateNamespacePathLength(op.namespace);
      validateStoreKey(op.key);
      deduped.set(JSON.stringify({ namespace: op.namespace, key: op.key }), op);
    }

    const puts: BoundPut[] = [];
    const deletes: BoundDelete[] = [];
    const vectorRows: BoundVector[] = [];
    for (const op of deduped.values()) {
      const key = encodeStoreKey(op.key);
      const path = namespacePath(op.namespace);
      if (op.value === null) {
        deletes.push({ namespacePath: path, key });
      } else {
        puts.push({
          namespacePath: path,
          key,
          value: JSON.parse(stringifyStoreValue(op.value)) as Record<
            string,
            unknown
          >,
          ttlMinutes: op.options?.ttl ?? this.ttlConfig?.defaultTtl ?? null,
        });
        vectorRows.push(
          ...(await this.getVectorRows(path, key, op.value, op.index))
        );
      }
    }

    await this.withConnection(async (connection) => {
      try {
        if (deletes.length > 0) {
          await connection.executeMany(
            `DELETE FROM ${this.tableName}
WHERE prefix = :namespacePath AND key = :key`,
            deletes as BindParameters[],
            {
              autoCommit: false,
              bindDefs: {
                namespacePath: { type: oracledb.STRING, maxSize: 4000 },
                key: { type: oracledb.STRING, maxSize: STORE_KEY_MAX_BYTES },
              },
            }
          );

          await this.deleteVectorRowsIfPresent(connection, deletes);
        }

        if (puts.length > 0) {
          await this.executeManyWithDuplicateRetry(
            connection,
            `MERGE INTO ${this.tableName} target
USING (
  SELECT
    :namespacePath AS prefix,
    :key AS key,
    :value AS value,
    :ttlMinutes AS ttl_minutes,
    CASE
      WHEN :ttlMinutes IS NULL THEN NULL
      ELSE CURRENT_TIMESTAMP + NUMTODSINTERVAL(:ttlMinutes, 'MINUTE')
    END AS expires_at
  FROM dual
) source
ON (target.prefix = source.prefix AND target.key = source.key)
WHEN MATCHED THEN UPDATE SET
  target.value = source.value,
  target.updated_at = CURRENT_TIMESTAMP,
  target.expires_at = source.expires_at,
  target.ttl_minutes = source.ttl_minutes
WHEN NOT MATCHED THEN INSERT (
  prefix, key, value, created_at, updated_at, expires_at, ttl_minutes
) VALUES (
  source.prefix, source.key, source.value, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
  source.expires_at, source.ttl_minutes
)`,
            puts,
            {
              autoCommit: false,
              bindDefs: {
                namespacePath: { type: oracledb.STRING, maxSize: 4000 },
                key: { type: oracledb.STRING, maxSize: STORE_KEY_MAX_BYTES },
                value: { type: oracledb.DB_TYPE_JSON },
                ttlMinutes: { type: oracledb.NUMBER },
              },
            }
          );

          await this.deleteVectorRowsIfPresent(
            connection,
            puts.map(({ namespacePath, key }) => ({ namespacePath, key }))
          );
        }

        if (vectorRows.length > 0) {
          const strategy = await this.resolveVectorBindStrategy(
            connection,
            true
          );
          await this.executeManyWithDuplicateRetry(
            connection,
            `MERGE INTO ${this.vectorTableName} target
USING (
  SELECT
    :namespacePath AS prefix,
    :key AS key,
    :fieldPath AS field_name,
    ${vectorExpression("embedding", strategy)} AS embedding
  FROM dual
) source
ON (
  target.prefix = source.prefix
  AND target.key = source.key
  AND target.field_name = source.field_name
)
WHEN MATCHED THEN UPDATE SET
  target.embedding = source.embedding,
  target.updated_at = CURRENT_TIMESTAMP
WHEN NOT MATCHED THEN INSERT (
  prefix,
  key,
  field_name,
  embedding,
  created_at,
  updated_at
) VALUES (
  source.prefix,
  source.key,
  source.field_name,
  source.embedding,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)`,
            this.prepareVectorRows(vectorRows, strategy),
            {
              autoCommit: false,
              bindDefs: this.vectorBindDefs(strategy),
            }
          );
        }

        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });

    for (const { index } of putOpsWithIndex) {
      results[index] = undefined;
    }
  }

  private async getOp(op: GetOperation): Promise<Item | null> {
    validateNamespacePathLength(op.namespace);
    validateStoreKey(op.key);
    const result = await this.withConnection((connection) =>
      connection.execute<StoreRow>(
        `SELECT prefix, key, value, created_at, updated_at
FROM ${this.tableName}
WHERE prefix = :namespacePath
  AND key = :key
  AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
        {
          namespacePath: namespacePath(op.namespace),
          key: encodeStoreKey(op.key),
        },
        {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        }
      )
    );
    const row = result.rows?.[0];
    const item = row ? rowToItem(row) : null;
    if (item && this.ttlConfig?.refreshOnRead) {
      await this.refreshItemsTtl([item]);
    }
    return item;
  }

  private async refreshItemsTtl(items: Item[]): Promise<void> {
    if (items.length === 0) return;
    const binds = items.map((item) => ({
      namespacePath: namespacePath(item.namespace),
      key: encodeStoreKey(item.key),
    }));
    await this.withConnection(async (connection) => {
      try {
        await connection.executeMany(
          `UPDATE ${this.tableName}
SET expires_at = CURRENT_TIMESTAMP + NUMTODSINTERVAL(ttl_minutes, 'MINUTE')
WHERE prefix = :namespacePath
  AND key = :key
  AND ttl_minutes IS NOT NULL
  AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
          binds,
          {
            autoCommit: false,
            bindDefs: {
              namespacePath: {
                type: oracledb.STRING,
                maxSize: STORE_NAMESPACE_PATH_MAX_BYTES,
              },
              key: { type: oracledb.STRING, maxSize: STORE_KEY_MAX_BYTES },
            },
          }
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  private async getVectorRows(
    namespacePathValue: string,
    key: string,
    value: Record<string, unknown>,
    index?: false | string[]
  ): Promise<BoundVector[]> {
    if (!this.indexConfig || index === false) return [];

    const fields = index ?? this.indexConfig.fields ?? ["$"];
    const textRows: Array<{ fieldPath: string; text: string }> = [];

    for (const field of fields) {
      validateUtf8ByteLength(
        STORE_BYTE_CONTEXT,
        "vector field path",
        field,
        STORE_FIELD_PATH_MAX_BYTES
      );
      const texts = getTextAtPath(value, field);
      texts.forEach((text, i) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const fieldPath = texts.length > 1 ? `${field}.${i}` : field;
        validateUtf8ByteLength(
          STORE_BYTE_CONTEXT,
          "vector field path",
          fieldPath,
          STORE_FIELD_PATH_MAX_BYTES
        );
        textRows.push({
          fieldPath,
          text: trimmed,
        });
      });
    }

    if (textRows.length === 0) return [];
    validateUtf8ByteLength(
      STORE_BYTE_CONTEXT,
      "vector namespace path",
      namespacePathValue,
      STORE_VECTOR_NAMESPACE_PATH_MAX_BYTES
    );
    validateUtf8ByteLength(
      STORE_BYTE_CONTEXT,
      "vector key",
      key,
      STORE_VECTOR_KEY_MAX_BYTES
    );

    const embeddings = await this.indexConfig.embeddings.embedDocuments(
      textRows.map((row) => row.text)
    );

    return textRows.map((row, i) => {
      const embedding = embeddings[i];
      if (!embedding || embedding.length !== this.indexConfig!.dims) {
        throw new Error(
          `OracleStore embedding dimension mismatch: expected ${
            this.indexConfig!.dims
          }, got ${embedding?.length ?? 0}.`
        );
      }
      validateVectorValues(embedding);
      return {
        namespacePath: namespacePathValue,
        key,
        fieldPath: row.fieldPath,
        embedding: [...embedding],
      };
    });
  }

  private async searchOp(op: OracleSearchOperation): Promise<SearchItem[]> {
    if (op.namespacePrefix.length > 0) {
      validateNamespacePathLength(op.namespacePrefix);
    }
    // Without an index configuration there is nothing to embed the query
    // against, so it is ignored and the filtered listing is returned. Python
    // and InMemoryStore both do this.
    if (op.query && this.indexConfig) {
      return this.vectorSearchOp(op);
    }

    const offset = op.offset ?? 0;
    const limit = op.limit ?? 10;
    const sqlFilter = buildSqlFilter(op.filter);
    const hasFilter =
      op.filter !== undefined && Object.keys(op.filter).length > 0;
    if (hasFilter && !sqlFilter) {
      throw new Error(
        "OracleStore does not support this filter in Oracle SQL."
      );
    }
    const rows = await this.fetchRowsByPrefix(
      op.namespacePrefix,
      sqlFilter,
      offset,
      limit
    );
    const items = rows
      .map(rowToItem)
      .filter((item) =>
        hasNamespacePrefix(item.namespace, op.namespacePrefix)
      ) as SearchItem[];
    if (op.refreshTtl ?? this.ttlConfig?.refreshOnRead) {
      await this.refreshItemsTtl(items);
    }
    return items;
  }

  private async vectorSearchOp(
    op: OracleSearchOperation
  ): Promise<SearchItem[]> {
    // Defensive: searchOp only routes here once an index configuration exists.
    if (!this.indexConfig) {
      throw new Error(
        "OracleStore vector search requires an index configuration."
      );
    }

    const queryEmbedding = await this.indexConfig.embeddings.embedQuery(
      op.query ?? ""
    );
    if (queryEmbedding.length !== this.indexConfig.dims) {
      throw new Error(
        `OracleStore query embedding dimension mismatch: expected ${this.indexConfig.dims}, got ${queryEmbedding.length}.`
      );
    }
    validateVectorValues(queryEmbedding);
    const queryVector = [...queryEmbedding];

    const offset = op.offset ?? 0;
    const limit = op.limit ?? 10;
    const sqlFilter = buildSqlFilter(op.filter, "s.value");
    const hasFilter =
      op.filter !== undefined && Object.keys(op.filter).length > 0;
    if (hasFilter && !sqlFilter) {
      throw new Error(
        "OracleStore does not support this filter in Oracle SQL."
      );
    }
    const rows = await this.fetchVectorRows(
      op,
      sqlFilter,
      queryVector,
      offset,
      limit
    );

    const items = rows
      .map(rowToSearchItem)
      .filter((item) => hasNamespacePrefix(item.namespace, op.namespacePrefix))
      .slice(0, limit);
    if (op.refreshTtl ?? this.ttlConfig?.refreshOnRead) {
      await this.refreshItemsTtl(items);
    }
    return items;
  }

  /**
   * How many vector rows one item can produce, used to size the candidate
   * fetch. Mirrors Python's `__estimated_num_vectors`.
   */
  private estimatedVectorsPerItem(): number {
    const fields = this.indexConfig?.fields ?? ["$"];
    return Math.max(fields.length, 1);
  }

  private async fetchVectorRows(
    op: OracleSearchOperation,
    sqlFilter: SqlFilter | undefined,
    queryVector: number[],
    sqlOffset: number,
    fetchLimit: number | undefined
  ): Promise<StoreRow[]> {
    const fetchClause =
      fetchLimit === undefined
        ? ""
        : "\nOFFSET :sqlOffset ROWS FETCH NEXT :fetchLimit ROWS ONLY";

    // Mirrors Python: join only rows that have a vector, take the closest
    // candidates first so the vector index can do the work, then keep one row
    // per item before paginating.
    const metric = distanceMetricSQL(this.indexConfig!);
    const score = scoreFromDistanceSQL(this.indexConfig!, "uniq.distance");
    const expandedLimit =
      fetchLimit === undefined
        ? undefined
        : (sqlOffset + fetchLimit) * this.estimatedVectorsPerItem() * 2 + 1;
    const candidateClause =
      expandedLimit === undefined
        ? ""
        : "\n  FETCH FIRST :expandedLimit ROWS ONLY";

    return this.withConnection(async (connection) => {
      const strategy = await this.resolveVectorBindStrategy(connection, false);
      const result = await connection.execute<StoreRow>(
        `WITH scored AS (
  SELECT
    s.prefix,
    s.key,
    s.value,
    s.created_at,
    s.updated_at,
    VECTOR_DISTANCE(
      v.embedding,
      ${vectorExpression("queryVector", strategy)},
      ${metric}
    ) AS distance
  FROM ${this.tableName} s
  JOIN ${this.vectorTableName} v
    ON v.prefix = s.prefix
    AND v.key = s.key
  WHERE (
    s.prefix = :namespacePath
    OR s.prefix LIKE :namespacePrefix ESCAPE '\\'
  )
  AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)${sqlFilter?.clause ?? ""}
  ORDER BY distance ASC${candidateClause}
),
uniq AS (
  SELECT prefix, key, value, created_at, updated_at, distance
  FROM (
    SELECT
      prefix,
      key,
      value,
      created_at,
      updated_at,
      distance,
      ROW_NUMBER() OVER (
        PARTITION BY prefix, key
        ORDER BY distance ASC
      ) AS rn
    FROM scored
  )
  WHERE rn = 1
)
SELECT
  uniq.prefix,
  uniq.key,
  uniq.value,
  uniq.created_at,
  uniq.updated_at,
  ${score} AS score
FROM uniq
ORDER BY uniq.distance ASC, uniq.key${fetchClause}`,
        {
          queryVector:
            strategy === "native"
              ? nativeVectorBind(queryVector)
              : vectorLiteral(queryVector),
          namespacePath: namespacePath(op.namespacePrefix),
          namespacePrefix:
            op.namespacePrefix.length === 0
              ? "%"
              : namespacePrefixLikePattern(op.namespacePrefix),
          ...(sqlFilter?.binds ?? {}),
          ...(expandedLimit === undefined ? {} : { expandedLimit }),
          ...(fetchLimit === undefined ? {} : { sqlOffset, fetchLimit }),
        },
        {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        }
      );
      return result.rows ?? [];
    });
  }

  private async listNamespacesOp(
    op: ListNamespacesOperation
  ): Promise<string[][]> {
    for (const condition of op.matchConditions ?? []) {
      const concretePath = condition.path.filter((label) => label !== "*");
      if (concretePath.length > 0) validateNamespacePathLength(concretePath);
    }
    const namespaceSqlFilter = buildNamespaceSqlFilter(op.matchConditions);
    const activeNamespaceClause = withActiveItemPredicate(
      namespaceSqlFilter.clause
    );
    const canPaginateInSql =
      namespaceSqlFilter.fullyPushed && op.maxDepth === undefined;
    const namespaceSet = new Map<string, string[]>();
    const addRows = (rows: NamespacePathRow[]): void => {
      for (const row of rows) {
        const path = row.PREFIX ?? row.prefix;
        if (!path) continue;
        const namespace = path.split(".");
        if (
          op.matchConditions &&
          !op.matchConditions.every((condition) =>
            matchesNamespaceCondition(namespace, condition)
          )
        ) {
          continue;
        }

        const projected =
          op.maxDepth === undefined
            ? namespace
            : namespace.slice(0, op.maxDepth);
        namespaceSet.set(JSON.stringify(projected), projected);
      }
    };

    if (canPaginateInSql) {
      const result = await this.withConnection((connection) =>
        connection.execute<NamespacePathRow>(
          `SELECT DISTINCT prefix
FROM ${this.tableName}
${activeNamespaceClause}
ORDER BY prefix
OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY`,
          { ...namespaceSqlFilter.binds, offset: op.offset, limit: op.limit },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        )
      );
      addRows(result.rows ?? []);
    } else {
      const batchSize = 100;
      const maxScan = 10_000;
      let scanOffset = 0;
      while (scanOffset < maxScan) {
        const result = await this.withConnection((connection) =>
          connection.execute<NamespacePathRow>(
            `SELECT DISTINCT prefix
FROM ${this.tableName}
${activeNamespaceClause}
ORDER BY prefix
OFFSET :scanOffset ROWS FETCH NEXT :batchSize ROWS ONLY`,
            { ...namespaceSqlFilter.binds, scanOffset, batchSize },
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          )
        );
        const rows = result.rows ?? [];
        addRows(rows);
        scanOffset += rows.length;
        if (rows.length < batchSize) break;
      }
      if (scanOffset >= maxScan) {
        throw new Error(
          `OracleStore namespace filtering exceeded the ${maxScan}-row scan limit.`
        );
      }
    }

    const namespaces = Array.from(namespaceSet.values()).filter((namespace) => {
      return op.maxDepth === undefined || namespace.length <= op.maxDepth;
    });

    namespaces.sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );

    return canPaginateInSql
      ? namespaces
      : namespaces.slice(op.offset, op.offset + op.limit);
  }

  private async fetchRowsByPrefix(
    namespacePrefix: string[],
    sqlFilter: SqlFilter | undefined,
    offset: number,
    limit: number
  ): Promise<StoreRow[]> {
    const pagination = "\nOFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY";
    if (namespacePrefix.length === 0) {
      const result = await this.withConnection((connection) =>
        connection.execute<StoreRow>(
          `SELECT prefix, key, value, created_at, updated_at
FROM ${this.tableName}
WHERE (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)${sqlFilter?.clause ?? ""}
ORDER BY updated_at DESC, prefix, key${pagination}`,
          {
            ...(sqlFilter?.binds ?? {}),
            offset,
            limit,
          },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        )
      );
      return result.rows ?? [];
    }

    const result = await this.withConnection((connection) =>
      connection.execute<StoreRow>(
        `SELECT prefix, key, value, created_at, updated_at
FROM ${this.tableName}
WHERE (
  prefix = :namespacePath
  OR prefix LIKE :namespacePrefix ESCAPE '\\'
)
AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)${sqlFilter?.clause ?? ""}
ORDER BY updated_at DESC, prefix, key${pagination}`,
        {
          namespacePath: namespacePath(namespacePrefix),
          namespacePrefix: namespacePrefixLikePattern(namespacePrefix),
          ...(sqlFilter?.binds ?? {}),
          offset,
          limit,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
    );
    return result.rows ?? [];
  }
}
