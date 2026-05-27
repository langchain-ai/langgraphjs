import oracledb from "oracledb";
import {
  BaseStore,
  InvalidNamespaceError,
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
  getCreateStoreMigrationTableSQL,
  getCreateStoreTableSQL,
  getCreateStoreVectorTableSQL,
} from "./store-migrations.js";

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
  embedding: string;
};

type NamespacePathRow = {
  NAMESPACE_PATH: string;
  namespace_path?: string;
};

type SqlFilter = {
  clause: string;
  binds: Record<string, string | number>;
};

type NamespaceSqlFilter = {
  clause: string;
  binds: Record<string, string>;
  fullyPushed: boolean;
};

const DEFAULT_TABLE_PREFIX = "LANGGRAPH_";
const ORACLE_IDENTIFIER_MAX_LENGTH = 128;
const STORE_NAMESPACE_PATH_MAX_BYTES = 4000;
const STORE_KEY_MAX_BYTES = 1024;
const STORE_FIELD_PATH_MAX_BYTES = 1024;
const JSON_VALUE_VARCHAR_MAX_BYTES = 4000;
const VECTOR_STRING_BIND_MAX_BYTES = 32767;
const STORE_KEY_ENCODING_PREFIX = "b64:";

function validateIdentifier(identifier: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(identifier)) {
    throw new Error(`Invalid Oracle identifier: ${identifier}`);
  }
  const normalized = identifier.toUpperCase();
  if (Buffer.byteLength(normalized, "utf8") > ORACLE_IDENTIFIER_MAX_LENGTH) {
    throw new Error(
      `Oracle identifier "${normalized}" exceeds ${ORACLE_IDENTIFIER_MAX_LENGTH} bytes.`
    );
  }
  return normalized;
}

function validateByteLength(
  label: string,
  value: string | null | undefined,
  maxBytes: number
): void {
  if (value === null || value === undefined) return;
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > maxBytes) {
    throw new Error(
      `OracleStore ${label} exceeds ${maxBytes} bytes. Received ${byteLength} bytes.`
    );
  }
}

function oracleErrorCode(error: unknown): number | string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { errorNum?: number; code?: string | number })
    .errorNum;
  return code ?? (error as { code?: string | number }).code;
}

function isOracleError(error: unknown, code: number): boolean {
  const actual = oracleErrorCode(error);
  return actual === code || actual === `ORA-${String(code).padStart(5, "0")}`;
}

function validateNamespace(namespace: string[]): void {
  if (namespace.length === 0) {
    throw new InvalidNamespaceError("Namespace cannot be empty.");
  }
  for (const label of namespace) {
    if (typeof label !== "string") {
      throw new InvalidNamespaceError(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels must be strings, but got ${typeof label}.`
      );
    }
    if (label.includes(".")) {
      throw new InvalidNamespaceError(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels cannot contain periods ('.').`
      );
    }
    if (label === "") {
      throw new InvalidNamespaceError(
        `Namespace labels cannot be empty strings. Got ${label} in ${namespace}`
      );
    }
  }
  if (namespace[0] === "langgraph") {
    throw new InvalidNamespaceError(
      `Root label for namespace cannot be "langgraph". Got: ${namespace}`
    );
  }
}

function namespacePath(namespace: string[]): string {
  return JSON.stringify(namespace);
}

function validateNamespacePathLength(namespace: string[]): void {
  validateByteLength(
    "namespace path",
    namespacePath(namespace),
    STORE_NAMESPACE_PATH_MAX_BYTES
  );
}

function validateStoreKey(key: string): void {
  validateByteLength("key", encodeStoreKey(key), STORE_KEY_MAX_BYTES);
}

function encodeStoreKey(key: string): string {
  return `${STORE_KEY_ENCODING_PREFIX}${Buffer.from(key, "utf8").toString(
    "base64url"
  )}`;
}

function decodeStoreKey(key: string): string {
  if (!key.startsWith(STORE_KEY_ENCODING_PREFIX)) return key;
  return Buffer.from(
    key.slice(STORE_KEY_ENCODING_PREFIX.length),
    "base64url"
  ).toString("utf8");
}

function namespacePrefixLikePattern(namespace: string[]): string {
  return `${escapeLike(namespacePath(namespace).slice(0, -1))},%`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function vectorLiteral(vector: number[]): string {
  for (const [index, value] of vector.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `OracleStore embedding values must be finite numbers. Invalid value at index ${index}.`
      );
    }
  }
  const literal = `[${vector.join(",")}]`;
  const byteLength = Buffer.byteLength(literal, "utf8");
  if (byteLength > VECTOR_STRING_BIND_MAX_BYTES) {
    throw new Error(
      `OracleStore vector literal exceeds ${VECTOR_STRING_BIND_MAX_BYTES} bytes. Received ${byteLength} bytes.`
    );
  }
  return literal;
}

function validateVectorDimensions(dims: number): void {
  if (!Number.isFinite(dims) || !Number.isInteger(dims) || dims <= 0) {
    throw new Error(
      `OracleStore index dims must be a positive integer. Received ${String(dims)}.`
    );
  }
}

function tokenizePath(path: string): string[] {
  if (!path) return [];

  const tokens: string[] = [];
  let current = "";
  let i = 0;
  while (i < path.length) {
    const char = path[i];
    if (char === ".") {
      if (current) {
        tokens.push(current);
      }
      current = "";
      i += 1;
      continue;
    }

    if (char === "[" || char === "{") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      const close = char === "[" ? "]" : "}";
      let depth = 1;
      let token = char;
      i += 1;
      while (i < path.length && depth > 0) {
        if (path[i] === char) depth += 1;
        if (path[i] === close) depth -= 1;
        token += path[i];
        i += 1;
      }
      tokens.push(token);
      continue;
    }

    current += char;
    i += 1;
  }
  if (current) tokens.push(current);
  return tokens;
}

function getTextAtPath(value: unknown, path: string): string[] {
  if (!path || path === "$") return [JSON.stringify(value, null, 2)];
  const tokens = tokenizePath(path);

  const extract = (current: unknown, position: number): string[] => {
    if (position >= tokens.length) {
      if (
        typeof current === "string" ||
        typeof current === "number" ||
        typeof current === "boolean"
      ) {
        return [String(current)];
      }
      if (current === null || current === undefined) return [];
      if (Array.isArray(current) || typeof current === "object") {
        return [JSON.stringify(current, null, 2)];
      }
      return [];
    }

    const token = tokens[position];
    if (token.startsWith("[") && token.endsWith("]")) {
      if (!Array.isArray(current)) return [];
      const rawIndex = token.slice(1, -1);
      if (rawIndex === "*") {
        return current.flatMap((item) => extract(item, position + 1));
      }
      const parsed = Number.parseInt(rawIndex, 10);
      if (Number.isNaN(parsed)) return [];
      const index = parsed < 0 ? current.length + parsed : parsed;
      return index >= 0 && index < current.length
        ? extract(current[index], position + 1)
        : [];
    }

    if (token.startsWith("{") && token.endsWith("}")) {
      if (typeof current !== "object" || current === null) return [];
      return token
        .slice(1, -1)
        .split(",")
        .flatMap((field) => getTextAtPath(current, field.trim()));
    }

    if (token === "*") {
      if (Array.isArray(current)) {
        return current.flatMap((item) => extract(item, position + 1));
      }
      if (typeof current === "object" && current !== null) {
        return Object.values(current).flatMap((item) =>
          extract(item, position + 1)
        );
      }
      return [];
    }

    if (typeof current !== "object" || current === null) return [];
    return extract((current as Record<string, unknown>)[token], position + 1);
  };

  return extract(value, 0);
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

function hasNamespacePrefix(namespace: string[], prefix: string[]): boolean {
  if (prefix.length > namespace.length) return false;
  return prefix.every((label, index) => namespace[index] === label);
}

function matchesNamespaceCondition(
  namespace: string[],
  condition: MatchCondition
): boolean {
  const { path, matchType } = condition;
  if (path.length > namespace.length) return false;

  if (matchType === "prefix") {
    return path.every(
      (label, index) => label === "*" || namespace[index] === label
    );
  }

  const offset = namespace.length - path.length;
  return path.every(
    (label, index) => label === "*" || namespace[offset + index] === label
  );
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
    Object.keys(value).every((key) =>
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

function jsonPath(field: string): string | undefined {
  const parts = field.split(".");
  if (
    parts.length === 0 ||
    !parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
  ) {
    return undefined;
  }
  return `'$${parts.map((part) => `."${part}"`).join("")}'`;
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

function jsonValueExpression(
  field: string,
  kind: "string" | "number" = "string",
  column = "item_value"
): string | undefined {
  const path = jsonPath(field);
  if (!path) return undefined;
  const returning =
    kind === "number" ? "NUMBER NULL ON ERROR" : "VARCHAR2(4000) NULL ON ERROR";
  return `JSON_VALUE(${column}, ${path} RETURNING ${returning})`;
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

  constructor(options: OracleStoreOptions = {}) {
    super();
    this.pool = options.pool;
    this.connectionOptions = options.connection;
    this.ownsPool = options.pool === undefined;
    this.tableName = validateIdentifier(
      `${options.tablePrefix ?? DEFAULT_TABLE_PREFIX}STORE`
    );
    this.vectorTableName = validateIdentifier(
      `${options.tablePrefix ?? DEFAULT_TABLE_PREFIX}STORE_VECTORS`
    );
    this.migrationTableName = validateIdentifier(
      `${options.tablePrefix ?? DEFAULT_TABLE_PREFIX}STORE_MIGRATIONS`
    );
    this.ensureTable = options.ensureTable ?? true;
    if (options.index) validateVectorDimensions(options.index.dims);
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
        results[i] = await this.listNamespacesOp(
          op as ListNamespacesOperation
        );
      }
      i += 1;
    }

    return results as OperationResults<Op>;
  }

  async start(): Promise<void> {
    await this.setup();
  }

  async stop(): Promise<void> {
    if (this.pool && this.ownsPool) {
      await this.pool.close(0);
      this.pool = undefined;
      this.isSetup = false;
      this.setupPromise = undefined;
    }
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

    const namespacePathValue = namespacePath([
      "__langgraph_dimension_probe__",
    ]);
    const key = `__probe_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}__`;
    const fieldPath = "__probe__";
    const embedding = vectorLiteral(new Array(this.indexConfig.dims).fill(0));

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
  TO_VECTOR(:embedding)
)`,
        {
          namespacePath: namespacePathValue,
          key,
          fieldPath,
          textContent: "dimension probe",
          embedding,
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

  private async executeManyWithDuplicateRetry<T extends Record<string, unknown>>(
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

  private async batchPuts(
    putOpsWithIndex: Array<{ index: number; op: PutOperation }>,
    results: unknown[]
  ): Promise<void> {
    const deduped = new Map<string, PutOperation>();
    for (const { op } of putOpsWithIndex) {
      validateNamespace(op.namespace);
      validateNamespacePathLength(op.namespace);
      validateStoreKey(op.key);
      deduped.set(
        JSON.stringify({ namespace: op.namespace, key: op.key }),
        op
      );
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
          valueJson: JSON.stringify(op.value),
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

          if (this.indexConfig) {
            await connection.executeMany(
              `DELETE FROM ${this.vectorTableName}
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
          }
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

          if (this.indexConfig) {
            await connection.executeMany(
              `DELETE FROM ${this.vectorTableName}
WHERE namespace_path = :namespacePath AND item_key = :key`,
              puts.map(({ namespacePath, key }) => ({ namespacePath, key })),
              {
                autoCommit: false,
                bindDefs: {
                  namespacePath: { type: oracledb.STRING, maxSize: 4000 },
                  key: { type: oracledb.STRING, maxSize: 1024 },
                },
              }
            );
          }
        }

        if (vectorRows.length > 0) {
          await this.executeManyWithDuplicateRetry(
            connection,
            `MERGE INTO ${this.vectorTableName} target
USING (
  SELECT
    :namespacePath AS namespace_path,
    :key AS item_key,
    :fieldPath AS field_path,
    :textContent AS text_content,
    TO_VECTOR(:embedding) AS embedding
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
            vectorRows,
            {
              autoCommit: false,
              bindDefs: {
                namespacePath: { type: oracledb.STRING, maxSize: 4000 },
                key: { type: oracledb.STRING, maxSize: 1024 },
                fieldPath: { type: oracledb.STRING, maxSize: 1024 },
                textContent: { type: oracledb.CLOB },
                embedding: {
                  type: oracledb.STRING,
                  maxSize: VECTOR_STRING_BIND_MAX_BYTES,
                },
              },
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
      validateByteLength("vector field path", field, STORE_FIELD_PATH_MAX_BYTES);
      const texts = getTextAtPath(value, field);
      texts.forEach((text, i) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const fieldPath = texts.length > 1 ? `${field}.${i}` : field;
        validateByteLength(
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
          `OracleStore embedding dimension mismatch: expected ${this.indexConfig!.dims}, got ${embedding?.length ?? 0}.`
        );
      }
      return {
        namespacePath: namespacePathValue,
        key,
        fieldPath: row.fieldPath,
        textContent: row.text,
        embedding: vectorLiteral(embedding),
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
    const hasFilter = op.filter !== undefined && Object.keys(op.filter).length > 0;
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
    const queryVector = vectorLiteral(queryEmbedding);

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
    queryVector: string,
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
    queryVector: string,
    sqlOffset: number,
    fetchLimit: number | undefined
  ): Promise<StoreRow[]> {
    const fetchClause =
      fetchLimit === undefined
        ? ""
        : "\nOFFSET :sqlOffset ROWS FETCH NEXT :fetchLimit ROWS ONLY";

    return this.withConnection(async (connection) => {
      const result = await connection.execute<StoreRow>(
        `WITH scored AS (
  SELECT
    s.namespace_path,
    s.item_key,
    MAX(
      CASE
        WHEN v.embedding IS NULL THEN NULL
        ELSE 1 - VECTOR_DISTANCE(v.embedding, TO_VECTOR(:queryVector), COSINE)
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
          queryVector,
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

    const namespaces = Array.from(namespaceSet.values())
      .filter((namespace) => {
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
