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
  type IndexConfig,
  type PutOperation,
  type SearchItem,
  type SearchOperation,
} from "@langchain/langgraph-checkpoint";
import type { Connection, Pool } from "oracledb";
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
  getCreateStoreTableSQL,
  getCreateStoreVectorTableSQL,
} from "./migrations.js";
import {
  JSON_VALUE_VARCHAR_MAX_BYTES,
  ORACLE_VECTOR_MAX_DIMENSIONS,
  STORE_FIELD_PATH_MAX_BYTES,
  STORE_KEY_MAX_BYTES,
  STORE_NAMESPACE_PATH_MAX_BYTES,
  VECTOR_STRING_BIND_MAX_BYTES,
} from "./constants.js";
import { validateTablePrefix } from "../sql.js";
import { generatedIdentifier, validateIdentifier } from "./identifiers.js";
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
import { isOracleError, validateUtf8ByteLength } from "../utils.js";

export interface OracleConnectionOptions {
  [key: string]: unknown;
  user?: string;
  password?: string;
  connectString?: string;
}

export interface OracleStoreOptions {
  connection?: OracleConnectionOptions;
  pool?: Pool;
  tablePrefix?: string;
  ensureTable?: boolean;
  index?: IndexConfig;
}

export type OracleVectorIndexOptions =
  | OracleHNSWVectorIndexOptions
  | OracleIVFVectorIndexOptions;

export interface OracleHNSWVectorIndexOptions {
  type: "HNSW";
  name?: string;
  accuracy?: number;
  neighbors?: number;
  efConstruction?: number;
  parallel?: number;
}

export interface OracleIVFVectorIndexOptions {
  type: "IVF";
  name?: string;
  accuracy?: number;
  neighborPartitions?: number;
  parallel?: number;
}

export interface OracleVectorIndexInfo {
  name: string;
  tableName: string;
  columnName: string;
  status?: string;
  indexType?: string;
  appearsOnStoreVectorEmbedding: boolean;
}

export interface OracleDropVectorIndexOptions {
  name: string;
  ifExists?: boolean;
}

type StoreRow = {
  KEY: string;
  key?: string;
  NAMESPACE: string | string[];
  namespace?: string | string[];
  VALUE: string | Record<string, unknown>;
  value?: string | Record<string, unknown>;
  CREATED_AT: Date;
  created_at?: Date;
  UPDATED_AT: Date;
  updated_at?: Date;
  SCORE?: number;
  score?: number;
};

type BoundPut = {
  namespacePath: string;
  namespaceJson: string;
  key: string;
  valueJson: string;
};

type BoundDelete = {
  namespacePath: string;
  key: string;
};

type BoundVector = {
  namespacePath: string;
  key: string;
  fieldPath: string;
  textContent: string;
  embedding: number[];
};

type VectorBindStrategy = "native" | "string";

type NativeVectorBind = {
  type: number;
  val: Float32Array;
};

type PreparedVector = Omit<BoundVector, "embedding"> & {
  embedding: string | Float32Array;
};

type NamespacePathRow = {
  NAMESPACE_PATH: string;
  namespace_path?: string;
};

type VectorIndexMetadataRow = {
  INDEX_NAME: string;
  index_name?: string;
  TABLE_NAME: string;
  table_name?: string;
  COLUMN_NAME: string | null;
  column_name?: string | null;
  STATUS?: string | null;
  status?: string | null;
  INDEX_TYPE?: string | null;
  index_type?: string | null;
};

type SqlFilter = {
  clause: string;
  binds: Record<string, string | number>;
};

type TableExistsRow = {
  TABLE_EXISTS: number;
  table_exists?: number;
};

type NamespaceSqlFilter = {
  clause: string;
  binds: Record<string, string>;
  fullyPushed: boolean;
};

const getExpectedStoreTables = (
  tables: {
    store: string;
    storeVectors: string;
    storeMigrations: string;
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
    name: tables.store,
    required: true,
    columns: [
      { name: "namespace_path", dataTypes: ["VARCHAR2"] },
      { name: "item_key", dataTypes: ["VARCHAR2"] },
      { name: "namespace", dataTypes: ["CLOB"] },
      { name: "item_value", dataTypes: ["CLOB"] },
      { name: "created_at", dataTypes: ["TIMESTAMP WITH TIME ZONE"] },
      { name: "updated_at", dataTypes: ["TIMESTAMP WITH TIME ZONE"] },
    ],
    primaryKey: ["namespace_path", "item_key"],
    jsonColumns: ["namespace", "item_value"],
  },
  {
    name: tables.storeVectors,
    required: vectorRequired,
    columns: [
      { name: "namespace_path", dataTypes: ["VARCHAR2"] },
      { name: "item_key", dataTypes: ["VARCHAR2"] },
      { name: "field_path", dataTypes: ["VARCHAR2"] },
      { name: "text_content", dataTypes: ["CLOB"] },
      { name: "embedding", dataTypes: ["VECTOR"] },
      { name: "created_at", dataTypes: ["TIMESTAMP WITH TIME ZONE"] },
    ],
    primaryKey: ["namespace_path", "item_key", "field_path"],
  },
];

const STORE_BYTE_CONTEXT = "OracleStore";

function defaultVectorIndexName(
  vectorTableName: string,
  type: OracleVectorIndexOptions["type"]
): string {
  return generatedIdentifier(`${vectorTableName}_EMBED_${type}_IDX`);
}

function validateIntegerRange(
  label: string,
  value: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      `OracleStore vector index ${label} must be an integer between ${min} and ${max}. Received ${String(
        value
      )}.`
    );
  }
  return value;
}

function validatePositiveInteger(
  label: string,
  value: number | undefined
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `OracleStore vector index ${label} must be a positive safe integer. Received ${String(
        value
      )}.`
    );
  }
  return value;
}

function vectorIndexName(
  vectorTableName: string,
  options: OracleVectorIndexOptions
): string {
  return options.name === undefined
    ? defaultVectorIndexName(vectorTableName, options.type)
    : validateIdentifier(options.name);
}

function validateVectorIndexOptions(
  options: OracleVectorIndexOptions
): OracleVectorIndexOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    (options.type !== "HNSW" && options.type !== "IVF")
  ) {
    throw new Error(
      'OracleStore vector index type must be either "HNSW" or "IVF".'
    );
  }

  validateIntegerRange("accuracy", options.accuracy, 1, 100);
  validatePositiveInteger("parallel", options.parallel);

  if (options.type === "HNSW") {
    validateIntegerRange("neighbors", options.neighbors, 2, 2048);
    validateIntegerRange("efConstruction", options.efConstruction, 1, 65535);
    if (
      (options.neighbors === undefined) !==
      (options.efConstruction === undefined)
    ) {
      throw new Error(
        "OracleStore HNSW vector index options require neighbors and efConstruction together."
      );
    }
  } else {
    validateIntegerRange(
      "neighborPartitions",
      options.neighborPartitions,
      1,
      10000000
    );
  }

  return options;
}

function createVectorIndexSQL(
  vectorTableName: string,
  options: OracleVectorIndexOptions
): string {
  const validated = validateVectorIndexOptions(options);
  const indexName = vectorIndexName(vectorTableName, validated);
  const accuracy =
    validated.accuracy === undefined
      ? ""
      : `\nWITH TARGET ACCURACY ${validated.accuracy}`;
  const parallel =
    validated.parallel === undefined ? "" : `\nPARALLEL ${validated.parallel}`;

  if (validated.type === "HNSW") {
    const parameters =
      validated.neighbors === undefined
        ? ""
        : `\nPARAMETERS (type HNSW, neighbors ${validated.neighbors}, efconstruction ${validated.efConstruction})`;
    return `CREATE VECTOR INDEX ${indexName}
ON ${vectorTableName} (embedding)
ORGANIZATION INMEMORY NEIGHBOR GRAPH
DISTANCE COSINE${accuracy}${parameters}${parallel}`;
  }

  const parameters =
    validated.neighborPartitions === undefined
      ? ""
      : `\nPARAMETERS (type IVF, neighbor partitions ${validated.neighborPartitions})`;
  return `CREATE VECTOR INDEX ${indexName}
ON ${vectorTableName} (embedding)
ORGANIZATION NEIGHBOR PARTITIONS
DISTANCE COSINE${accuracy}${parameters}${parallel}`;
}

function vectorIndexInfoFromRow(
  row: VectorIndexMetadataRow,
  vectorTableName: string
): OracleVectorIndexInfo {
  const name = row.INDEX_NAME ?? row.index_name;
  const tableName = row.TABLE_NAME ?? row.table_name;
  const columnName = row.COLUMN_NAME ?? row.column_name ?? "";
  const status = row.STATUS ?? row.status ?? undefined;
  const indexType = row.INDEX_TYPE ?? row.index_type ?? undefined;

  return {
    name,
    tableName,
    columnName,
    status,
    indexType,
    appearsOnStoreVectorEmbedding:
      tableName.toUpperCase() === vectorTableName &&
      columnName.toUpperCase() === "EMBEDDING",
  };
}

function vectorIndexMetadataSQL(whereClause: string): string {
  return `SELECT
  i.index_name,
  i.table_name,
  c.column_name,
  i.status,
  i.index_type
FROM user_indexes i
LEFT JOIN user_ind_columns c
  ON c.index_name = i.index_name
  AND c.table_name = i.table_name
${whereClause}
ORDER BY i.index_name, c.column_position`;
}

function validateDropVectorIndexOptions(
  options: OracleDropVectorIndexOptions
): string {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.name !== "string"
  ) {
    throw new Error("OracleStore dropVectorIndex requires an index name.");
  }
  return validateIdentifier(options.name);
}

function validateNamespacePathLength(namespace: string[]): void {
  validateUtf8ByteLength(
    STORE_BYTE_CONTEXT,
    "namespace path",
    namespacePath(namespace),
    STORE_NAMESPACE_PATH_MAX_BYTES
  );
}

function validateStoreKey(key: string): void {
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

function vectorBindValue(
  vector: number[],
  strategy: VectorBindStrategy
): string | Float32Array {
  return strategy === "native"
    ? nativeVectorValue(vector)
    : vectorLiteral(vector);
}

function vectorBindDef(strategy: VectorBindStrategy): Record<string, unknown> {
  return strategy === "native"
    ? { type: oracledb.DB_TYPE_VECTOR }
    : {
        type: oracledb.STRING,
        maxSize: VECTOR_STRING_BIND_MAX_BYTES,
      };
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

function validateVectorDimensions(dims: number): void {
  if (
    typeof dims !== "number" ||
    !Number.isSafeInteger(dims) ||
    dims <= 0 ||
    dims > ORACLE_VECTOR_MAX_DIMENSIONS
  ) {
    throw new Error(
      `OracleStore index dims must be an integer between 1 and ${ORACLE_VECTOR_MAX_DIMENSIONS}. Received ${String(
        dims
      )}.`
    );
  }
}

function validateIndexConfig(index: IndexConfig): void {
  validateVectorDimensions(index.dims);
  if (
    !index.embeddings ||
    typeof index.embeddings.embedDocuments !== "function" ||
    typeof index.embeddings.embedQuery !== "function"
  ) {
    throw new Error(
      "OracleStore index embeddings must provide embedDocuments and embedQuery methods."
    );
  }
  if (
    index.fields !== undefined &&
    (!Array.isArray(index.fields) ||
      !index.fields.every((field) => typeof field === "string"))
  ) {
    throw new Error("OracleStore index fields must be an array of strings.");
  }
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

function parseJson<T>(value: string | T): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

function rowToItem(row: StoreRow): Item {
  return {
    key: decodeStoreKey(row.KEY ?? row.key ?? ""),
    namespace: parseJson<string[]>(row.NAMESPACE ?? row.namespace ?? "[]"),
    value: parseJson<Record<string, unknown>>(row.VALUE ?? row.value ?? "{}"),
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
        `(namespace_path = :namespacePrefixExact_${index} OR namespace_path LIKE :namespacePrefixLike_${index} ESCAPE '\\')`
      );
      return;
    }

    const suffixJsonTail = JSON.stringify(path).slice(1);
    binds[`namespaceSuffixExact_${index}`] = namespacePath(path);
    binds[`namespaceSuffixLike_${index}`] = `%${escapeLike(
      `,${suffixJsonTail}`
    )}`;
    clauses.push(
      `(namespace_path = :namespaceSuffixExact_${index} OR namespace_path LIKE :namespaceSuffixLike_${index} ESCAPE '\\')`
    );
  });

  return {
    clause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    binds,
    fullyPushed,
  };
}

function getValueAtPath(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, value);
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

function compareFilterValue(itemValue: unknown, filterValue: unknown): boolean {
  if (!isFilterOperators(filterValue)) return itemValue === filterValue;

  return Object.entries(filterValue).every(([operator, expected]) => {
    switch (operator) {
      case "$eq":
        return itemValue === expected;
      case "$ne":
        return itemValue !== expected;
      case "$gt":
        return Number(itemValue) > Number(expected);
      case "$gte":
        return Number(itemValue) >= Number(expected);
      case "$lt":
        return Number(itemValue) < Number(expected);
      case "$lte":
        return Number(itemValue) <= Number(expected);
      case "$in":
        return Array.isArray(expected) ? expected.includes(itemValue) : false;
      case "$nin":
        return Array.isArray(expected) ? !expected.includes(itemValue) : true;
      case "$exists":
        return expected ? itemValue !== undefined : itemValue === undefined;
      default:
        return false;
    }
  });
}

function matchesFilter(
  value: Record<string, unknown>,
  filter?: Record<string, unknown>
): boolean {
  if (!filter) return true;

  return Object.entries(filter).every(([field, expected]) =>
    compareFilterValue(getValueAtPath(value, field), expected)
  );
}

function primitiveBindValue(value: unknown): string | number | undefined {
  if (typeof value === "string") {
    if (
      value === "" ||
      Buffer.byteLength(value, "utf8") > JSON_VALUE_VARCHAR_MAX_BYTES
    ) {
      return undefined;
    }
    return value;
  }
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

function buildSqlFilter(
  filter: Record<string, unknown> | undefined,
  column = "item_value"
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

    if (!isFilterOperators(expected)) {
      const value = primitiveBindValue(expected);
      if (value === undefined) return undefined;
      const expression = jsonValueExpression(
        field,
        typeof expected === "number" ? "number" : "string",
        column
      );
      if (!expression) return undefined;
      clauses.push(`${expression} = ${addBind(value)}`);
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
        if (operator === "$nin") return undefined;
        const values = rawValue.map(primitiveBindValue);
        if (values.some((value) => value === undefined)) return undefined;
        const expression = jsonValueExpression(
          field,
          rawValue.every((value) => typeof value === "number")
            ? "number"
            : "string",
          column
        );
        if (!expression) return undefined;
        const bindList = (values as Array<string | number>)
          .map((value) => addBind(value))
          .join(", ");
        clauses.push(
          operator === "$in"
            ? `${expression} IN (${bindList})`
            : `(${expression} NOT IN (${bindList}) OR ${expression} IS NULL)`
        );
        continue;
      }

      if (
        operator === "$gt" ||
        operator === "$gte" ||
        operator === "$lt" ||
        operator === "$lte"
      ) {
        return undefined;
      }

      const value = primitiveBindValue(rawValue);
      if (value === undefined) return undefined;
      const expression = jsonValueExpression(
        field,
        typeof rawValue === "number" ? "number" : "string",
        column
      );
      if (!expression) return undefined;
      const bind = addBind(value);
      switch (operator) {
        case "$eq":
          clauses.push(`${expression} = ${bind}`);
          break;
        case "$ne":
          return undefined;
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

  private readonly connectionOptions?: OracleConnectionOptions;

  private readonly ownsPool: boolean;

  private readonly tableName: string;

  private readonly vectorTableName: string;

  private readonly migrationTableName: string;

  private readonly ensureTable: boolean;

  private readonly indexConfig?: IndexConfig;

  private isSetup = false;

  private setupPromise?: Promise<void>;

  private vectorBindStrategy?: VectorBindStrategy;

  private nativeVectorDmlProbed = false;

  constructor(options: OracleStoreOptions = {}) {
    super();
    this.pool = options.pool;
    this.connectionOptions = options.connection;
    this.ownsPool = options.pool === undefined;
    const tablePrefix = validateTablePrefix(options.tablePrefix);
    this.tableName = validateIdentifier(`${tablePrefix}STORE`);
    this.vectorTableName = validateIdentifier(`${tablePrefix}STORE_VECTORS`);
    this.migrationTableName = validateIdentifier(
      `${tablePrefix}STORE_MIGRATIONS`
    );
    this.ensureTable = options.ensureTable ?? true;
    if (options.index) validateIndexConfig(options.index);
    this.indexConfig = options.index;
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
        const putOps: Array<{ index: number; op: PutOperation }> = [];
        let j = i;
        while (j < operations.length && "value" in operations[j]) {
          putOps.push({ index: j, op: operations[j] as PutOperation });
          j += 1;
        }
        await this.batchPuts(putOps, results);
        i = j;
        continue;
      }

      if ("key" in op && !("namespacePrefix" in op)) {
        results[i] = await this.getOp(op as GetOperation);
      } else if ("namespacePrefix" in op) {
        results[i] = await this.searchOp(op as SearchOperation);
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
    try {
      if (this.pool && this.ownsPool) {
        await this.pool.close(0);
        this.pool = undefined;
      }
    } finally {
      this.isSetup = false;
      this.setupPromise = undefined;
      this.vectorBindStrategy = undefined;
      this.nativeVectorDmlProbed = false;
    }
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
      };
      const vectorRequired = this.indexConfig !== undefined;
      const expectedTables = getExpectedStoreTables(tables, vectorRequired);
      const expectedVersions = vectorRequired ? [0, 1] : [0];
      const knownVersions = [0, 1];
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
        tablePrefix: this.tableName.slice(0, -"STORE".length),
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

  async createVectorIndex(options: OracleVectorIndexOptions): Promise<void> {
    if (!this.indexConfig) {
      throw new Error(
        "OracleStore vector index creation requires an index configuration."
      );
    }

    const sql = createVectorIndexSQL(this.vectorTableName, options);
    await this.setup();
    await this.withConnection(async (connection) => {
      await connection.execute(sql);
    });
  }

  async listVectorIndexes(): Promise<OracleVectorIndexInfo[]> {
    return this.fetchStoreVectorIndexInfo();
  }

  async dropVectorIndex(options: OracleDropVectorIndexOptions): Promise<void> {
    const indexName = validateDropVectorIndexOptions(options);
    const indexes = await this.fetchVectorIndexInfoByName(indexName);

    if (indexes.length === 0) {
      if (options.ifExists) return;
      throw new Error(
        `OracleStore vector index "${indexName}" does not exist.`
      );
    }

    if (!indexes.every((index) => index.appearsOnStoreVectorEmbedding)) {
      throw new Error(
        `OracleStore will not drop index "${indexName}" because it is not on ${this.vectorTableName}(EMBEDDING).`
      );
    }

    await this.withConnection(async (connection) => {
      await connection.execute(`DROP INDEX ${indexName}`);
    });
  }

  private async setup(): Promise<void> {
    if (this.isSetup) return;
    this.setupPromise ??= this.doSetup().catch((error) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async doSetup(): Promise<void> {
    await this.ensurePool();

    if (this.ensureTable) {
      await this.withConnection(async (connection) => {
        try {
          try {
            await connection.execute(
              getCreateStoreMigrationTableSQL({
                store: this.tableName,
                storeVectors: this.vectorTableName,
                storeMigrations: this.migrationTableName,
              })
            );
          } catch (error) {
            if (!isOracleError(error, 955)) throw error;
          }

          const current = await connection.execute<{ V: number; v?: number }>(
            `SELECT v FROM ${this.migrationTableName} ORDER BY v DESC FETCH FIRST 1 ROW ONLY`,
            {},
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );
          const currentVersion = current.rows?.[0]
            ? Number(current.rows[0].V ?? current.rows[0].v)
            : -1;

          if (currentVersion >= 0) {
            await this.assertSetupTableExists(connection, this.tableName);
          }
          if (currentVersion >= 1 && this.indexConfig) {
            await this.assertSetupTableExists(connection, this.vectorTableName);
          }

          if (currentVersion < 0) {
            try {
              await connection.execute(
                getCreateStoreTableSQL({
                  store: this.tableName,
                  storeVectors: this.vectorTableName,
                  storeMigrations: this.migrationTableName,
                })
              );
            } catch (error) {
              if (!isOracleError(error, 955)) throw error;
            }
            await this.insertMigration(connection, 0);
          }

          if (currentVersion < 1 && this.indexConfig) {
            try {
              await connection.execute(
                getCreateStoreVectorTableSQL(
                  {
                    store: this.tableName,
                    storeVectors: this.vectorTableName,
                    storeMigrations: this.migrationTableName,
                  },
                  this.indexConfig.dims
                )
              );
            } catch (error) {
              if (!isOracleError(error, 955)) throw error;
            }
            await this.insertMigration(connection, 1);
          }

          if (this.indexConfig) {
            await this.validateVectorTableDimensions(connection);
          }

          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      });
    }

    this.isSetup = true;
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
    version: number
  ): Promise<void> {
    try {
      await connection.execute(
        `INSERT INTO ${this.migrationTableName} (v) VALUES (:version)`,
        { version }
      );
    } catch (error) {
      if (!isOracleError(error, 1)) throw error;
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

    try {
      await connection.execute(
        `DELETE FROM ${this.vectorTableName}
WHERE namespace_path = :namespacePath AND item_key = :key AND field_path = :fieldPath`,
        {
          namespacePath: namespacePathValue,
          key,
          fieldPath,
        }
      );
      await connection.execute(
        `INSERT INTO ${this.vectorTableName} (
  namespace_path,
  item_key,
  field_path,
  text_content,
  embedding
) VALUES (
  :namespacePath,
  :key,
  :fieldPath,
  :textContent,
  ${vectorExpression("embedding", strategy)}
)`,
        {
          namespacePath: namespacePathValue,
          key,
          fieldPath,
          textContent: "dimension probe",
          embedding: vectorBindValue(embedding, strategy),
        }
      );
      await connection.execute(
        `DELETE FROM ${this.vectorTableName}
WHERE namespace_path = :namespacePath AND item_key = :key AND field_path = :fieldPath`,
        {
          namespacePath: namespacePathValue,
          key,
          fieldPath,
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
    } catch {
      this.vectorBindStrategy = "string";
      this.nativeVectorDmlProbed = false;
    }
    return this.vectorBindStrategy;
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
          textContent: "native vector bind probe",
          embedding,
        },
      ],
      "native"
    );

    await connection.execute(
      `DELETE FROM ${this.vectorTableName}
WHERE namespace_path = :namespacePath AND item_key = :key AND field_path = :fieldPath`,
      {
        namespacePath: namespacePathValue,
        key,
        fieldPath,
      }
    );
    try {
      await connection.executeMany(
        `INSERT INTO ${this.vectorTableName} (
  namespace_path,
  item_key,
  field_path,
  text_content,
  embedding
) VALUES (
  :namespacePath,
  :key,
  :fieldPath,
  :textContent,
  ${vectorExpression("embedding", "native")}
)`,
        probeRows,
        {
          autoCommit: false,
          bindDefs: this.vectorBindDefs("native"),
        }
      );
      await connection.execute(
        `SELECT VECTOR_DISTANCE(embedding, :queryVector, COSINE) AS distance
FROM ${this.vectorTableName}
WHERE namespace_path = :namespacePath AND item_key = :key AND field_path = :fieldPath`,
        {
          namespacePath: namespacePathValue,
          key,
          fieldPath,
          queryVector: nativeVectorBind(embedding),
        }
      );
    } finally {
      await connection.execute(
        `DELETE FROM ${this.vectorTableName}
WHERE namespace_path = :namespacePath AND item_key = :key AND field_path = :fieldPath`,
        {
          namespacePath: namespacePathValue,
          key,
          fieldPath,
        }
      );
    }
  }

  private async ensurePool(): Promise<void> {
    if (this.pool) return;
    this.pool = await oracledb.createPool(this.connectionOptions ?? {});
  }

  private async withConnection<T>(
    callback: (connection: Connection) => Promise<T>
  ): Promise<T> {
    await this.ensurePool();
    const connection = await this.pool!.getConnection();
    try {
      return await callback(connection);
    } finally {
      await connection.close();
    }
  }

  private async fetchStoreVectorIndexInfo(): Promise<OracleVectorIndexInfo[]> {
    const result = await this.withConnection((connection) =>
      connection.execute<VectorIndexMetadataRow>(
        vectorIndexMetadataSQL(
          `WHERE i.table_name = :tableName
  AND c.column_name = :columnName`
        ),
        {
          tableName: this.vectorTableName,
          columnName: "EMBEDDING",
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
    );

    return (result.rows ?? []).map((row) =>
      vectorIndexInfoFromRow(row, this.vectorTableName)
    );
  }

  private async fetchVectorIndexInfoByName(
    indexName: string
  ): Promise<OracleVectorIndexInfo[]> {
    const result = await this.withConnection((connection) =>
      connection.execute<VectorIndexMetadataRow>(
        vectorIndexMetadataSQL("WHERE i.index_name = :indexName"),
        { indexName },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
    );

    return (result.rows ?? []).map((row) =>
      vectorIndexInfoFromRow(row, this.vectorTableName)
    );
  }

  private async executeManyWithDuplicateRetry<
    T extends Record<string, unknown>,
  >(
    connection: Connection,
    sql: string,
    binds: T[],
    options: Parameters<Connection["executeMany"]>[2]
  ): Promise<void> {
    try {
      await connection.executeMany(sql, binds, options);
    } catch (error) {
      if (!isOracleError(error, 1)) throw error;
      await connection.executeMany(sql, binds, options);
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
      textContent: row.textContent,
      embedding: vectorBindValue(row.embedding, strategy),
    }));
  }

  private vectorBindDefs(
    strategy: VectorBindStrategy
  ): Record<string, Record<string, unknown>> {
    return {
      namespacePath: { type: oracledb.STRING, maxSize: 4000 },
      key: { type: oracledb.STRING, maxSize: 1024 },
      fieldPath: { type: oracledb.STRING, maxSize: 1024 },
      textContent: { type: oracledb.CLOB },
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
WHERE namespace_path = :namespacePath AND item_key = :key`,
        rows,
        {
          autoCommit: false,
          bindDefs: {
            namespacePath: { type: oracledb.STRING, maxSize: 4000 },
            key: { type: oracledb.STRING, maxSize: 1024 },
          },
        }
      );
    } catch (error) {
      if (!isOracleError(error, 942)) throw error;
    }
  }

  private async batchPuts(
    putOpsWithIndex: Array<{ index: number; op: PutOperation }>,
    results: unknown[]
  ): Promise<void> {
    const deduped = new Map<string, PutOperation>();
    for (const { op } of putOpsWithIndex) {
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
          namespaceJson: JSON.stringify(op.namespace),
          key,
          valueJson: stringifyStoreValue(op.value),
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
WHERE namespace_path = :namespacePath AND item_key = :key`,
            deletes,
            {
              autoCommit: false,
              bindDefs: {
                namespacePath: { type: oracledb.STRING, maxSize: 4000 },
                key: { type: oracledb.STRING, maxSize: 1024 },
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
    :namespacePath AS namespace_path,
    :key AS item_key,
    :namespaceJson AS namespace,
    :valueJson AS item_value
  FROM dual
) source
ON (target.namespace_path = source.namespace_path AND target.item_key = source.item_key)
WHEN MATCHED THEN UPDATE SET
  target.namespace = source.namespace,
  target.item_value = source.item_value,
  target.updated_at = SYSTIMESTAMP
WHEN NOT MATCHED THEN INSERT (
  namespace_path, item_key, namespace, item_value, created_at, updated_at
) VALUES (
  source.namespace_path, source.item_key, source.namespace, source.item_value, SYSTIMESTAMP, SYSTIMESTAMP
)`,
            puts,
            {
              autoCommit: false,
              bindDefs: {
                namespacePath: { type: oracledb.STRING, maxSize: 4000 },
                key: { type: oracledb.STRING, maxSize: 1024 },
                namespaceJson: { type: oracledb.STRING, maxSize: 4000 },
                valueJson: { type: oracledb.CLOB },
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
    :namespacePath AS namespace_path,
    :key AS item_key,
    :fieldPath AS field_path,
    :textContent AS text_content,
    ${vectorExpression("embedding", strategy)} AS embedding
  FROM dual
) source
ON (
  target.namespace_path = source.namespace_path
  AND target.item_key = source.item_key
  AND target.field_path = source.field_path
)
WHEN MATCHED THEN UPDATE SET
  target.text_content = source.text_content,
  target.embedding = source.embedding
WHEN NOT MATCHED THEN INSERT (
  namespace_path,
  item_key,
  field_path,
  text_content,
  embedding
) VALUES (
  source.namespace_path,
  source.item_key,
  source.field_path,
  source.text_content,
  source.embedding
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
        `SELECT item_key AS key, namespace, item_value AS value, created_at, updated_at
FROM ${this.tableName}
WHERE namespace_path = :namespacePath AND item_key = :key`,
        {
          namespacePath: namespacePath(op.namespace),
          key: encodeStoreKey(op.key),
        },
        {
          fetchInfo: {
            NAMESPACE: { type: oracledb.STRING },
            VALUE: { type: oracledb.STRING },
          },
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        }
      )
    );
    const row = result.rows?.[0];
    return row ? rowToItem(row) : null;
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
        textContent: row.text,
        embedding: [...embedding],
      };
    });
  }

  private async searchOp(op: SearchOperation): Promise<SearchItem[]> {
    if (op.namespacePrefix.length > 0) {
      validateNamespacePathLength(op.namespacePrefix);
    }
    if (op.query) {
      return this.vectorSearchOp(op);
    }

    const offset = op.offset ?? 0;
    const limit = op.limit ?? 10;
    const sqlFilter = buildSqlFilter(op.filter);
    const hasFilter =
      op.filter !== undefined && Object.keys(op.filter).length > 0;
    if (sqlFilter && hasFilter) {
      return this.filteredSearchOp(op, sqlFilter, offset, limit);
    }

    const rows = await this.fetchRowsByPrefix(
      op.namespacePrefix,
      sqlFilter,
      offset,
      limit
    );
    const filtered = rows
      .map(rowToItem)
      .filter(
        (item) =>
          hasNamespacePrefix(item.namespace, op.namespacePrefix) &&
          matchesFilter(item.value, op.filter)
      );

    return (
      sqlFilter ? filtered : filtered.slice(offset, offset + limit)
    ) as SearchItem[];
  }

  private async filteredSearchOp(
    op: SearchOperation,
    sqlFilter: SqlFilter,
    offset: number,
    limit: number
  ): Promise<SearchItem[]> {
    const target = offset + limit;
    const batchSize = Math.max(target, 100);
    const kept: Item[] = [];
    let sqlOffset = 0;

    while (kept.length < target) {
      const rows = await this.fetchRowsByPrefix(
        op.namespacePrefix,
        sqlFilter,
        sqlOffset,
        batchSize
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        const item = rowToItem(row);
        if (
          hasNamespacePrefix(item.namespace, op.namespacePrefix) &&
          matchesFilter(item.value, op.filter)
        ) {
          kept.push(item);
        }
      }

      sqlOffset += rows.length;
      if (rows.length < batchSize) break;
    }

    return kept.slice(offset, target) as SearchItem[];
  }

  private async vectorSearchOp(op: SearchOperation): Promise<SearchItem[]> {
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
    const sqlFilter = buildSqlFilter(op.filter, "s.item_value");
    const hasFilter =
      op.filter !== undefined && Object.keys(op.filter).length > 0;
    const rows =
      sqlFilter && hasFilter
        ? await this.fetchFilteredVectorRows(
            op,
            sqlFilter,
            queryVector,
            offset,
            limit
          )
        : await this.fetchVectorRows(
            op,
            sqlFilter,
            queryVector,
            0,
            sqlFilter ? offset + limit : undefined
          );

    return rows
      .map(rowToSearchItem)
      .filter(
        (item) =>
          hasNamespacePrefix(item.namespace, op.namespacePrefix) &&
          matchesFilter(item.value, op.filter)
      )
      .slice(offset, offset + limit);
  }

  private async fetchFilteredVectorRows(
    op: SearchOperation,
    sqlFilter: SqlFilter,
    queryVector: number[],
    offset: number,
    limit: number
  ): Promise<StoreRow[]> {
    const target = offset + limit;
    const batchSize = Math.max(target, 100);
    const kept: StoreRow[] = [];
    let sqlOffset = 0;

    while (kept.length < target) {
      const rows = await this.fetchVectorRows(
        op,
        sqlFilter,
        queryVector,
        sqlOffset,
        batchSize
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        const item = rowToSearchItem(row);
        if (
          hasNamespacePrefix(item.namespace, op.namespacePrefix) &&
          matchesFilter(item.value, op.filter)
        ) {
          kept.push(row);
        }
      }

      sqlOffset += rows.length;
      if (rows.length < batchSize) break;
    }

    return kept;
  }

  private async fetchVectorRows(
    op: SearchOperation,
    sqlFilter: SqlFilter | undefined,
    queryVector: number[],
    sqlOffset: number,
    fetchLimit: number | undefined
  ): Promise<StoreRow[]> {
    const fetchClause =
      fetchLimit === undefined
        ? ""
        : "\nOFFSET :sqlOffset ROWS FETCH NEXT :fetchLimit ROWS ONLY";

    return this.withConnection(async (connection) => {
      const strategy = await this.resolveVectorBindStrategy(connection, false);
      const result = await connection.execute<StoreRow>(
        `WITH scored AS (
  SELECT
    s.namespace_path,
    s.item_key,
    MAX(
      CASE
        WHEN v.embedding IS NULL THEN NULL
        ELSE 1 - VECTOR_DISTANCE(
          v.embedding,
          ${vectorExpression("queryVector", strategy)},
          COSINE
        )
      END
    ) AS score
  FROM ${this.tableName} s
  LEFT JOIN ${this.vectorTableName} v
    ON v.namespace_path = s.namespace_path
    AND v.item_key = s.item_key
  WHERE (
    s.namespace_path = :namespacePath
    OR s.namespace_path LIKE :namespacePrefix ESCAPE '\\'
  )${sqlFilter?.clause ?? ""}
  GROUP BY
    s.namespace_path,
    s.item_key
)
SELECT
  s.item_key AS key,
  s.namespace,
  s.item_value AS value,
  s.created_at,
  s.updated_at,
  sc.score
FROM scored sc
INNER JOIN ${this.tableName} s
  ON s.namespace_path = sc.namespace_path
  AND s.item_key = sc.item_key
ORDER BY CASE WHEN sc.score IS NULL THEN 1 ELSE 0 END, sc.score DESC, key${fetchClause}`,
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
          ...(fetchLimit === undefined ? {} : { sqlOffset, fetchLimit }),
        },
        {
          fetchInfo: {
            NAMESPACE: { type: oracledb.STRING },
            VALUE: { type: oracledb.STRING },
          },
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
    const canPaginateInSql =
      namespaceSqlFilter.fullyPushed && op.maxDepth === undefined;
    const pagination = canPaginateInSql
      ? "\nOFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY"
      : "";
    const result = await this.withConnection((connection) =>
      connection.execute<NamespacePathRow>(
        `SELECT DISTINCT namespace_path
FROM ${this.tableName}
${namespaceSqlFilter.clause}
ORDER BY namespace_path${pagination}`,
        {
          ...namespaceSqlFilter.binds,
          ...(canPaginateInSql ? { offset: op.offset, limit: op.limit } : {}),
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
    );

    const namespaceSet = new Map<string, string[]>();
    for (const row of result.rows ?? []) {
      const path = row.NAMESPACE_PATH ?? row.namespace_path;
      if (!path) continue;
      const namespace = parseJson<string[]>(path);
      if (
        op.matchConditions &&
        !op.matchConditions.every((condition) =>
          matchesNamespaceCondition(namespace, condition)
        )
      ) {
        continue;
      }

      const projected =
        op.maxDepth === undefined ? namespace : namespace.slice(0, op.maxDepth);
      namespaceSet.set(JSON.stringify(projected), projected);
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
          `SELECT item_key AS key, namespace, item_value AS value, created_at, updated_at
FROM ${this.tableName}
WHERE 1 = 1${sqlFilter?.clause ?? ""}
ORDER BY namespace_path, item_key${sqlFilter ? pagination : ""}`,
          {
            ...(sqlFilter?.binds ?? {}),
            ...(sqlFilter ? { offset, limit } : {}),
          },
          {
            fetchInfo: {
              NAMESPACE: { type: oracledb.STRING },
              VALUE: { type: oracledb.STRING },
            },
            outFormat: oracledb.OUT_FORMAT_OBJECT,
          }
        )
      );
      return result.rows ?? [];
    }

    const result = await this.withConnection((connection) =>
      connection.execute<StoreRow>(
        `SELECT item_key AS key, namespace, item_value AS value, created_at, updated_at
FROM ${this.tableName}
WHERE (
  namespace_path = :namespacePath
  OR namespace_path LIKE :namespacePrefix ESCAPE '\\'
)${sqlFilter?.clause ?? ""}
ORDER BY namespace_path, item_key${sqlFilter ? pagination : ""}`,
        {
          namespacePath: namespacePath(namespacePrefix),
          namespacePrefix: namespacePrefixLikePattern(namespacePrefix),
          ...(sqlFilter?.binds ?? {}),
          ...(sqlFilter ? { offset, limit } : {}),
        },
        {
          fetchInfo: {
            NAMESPACE: { type: oracledb.STRING },
            VALUE: { type: oracledb.STRING },
          },
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        }
      )
    );
    return result.rows ?? [];
  }
}
