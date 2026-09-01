// Copyright (c) 2026, Oracle and/or its affiliates.
import type { RunnableConfig } from "@langchain/core/runnables";
import { decode as decodeMessagePack } from "@msgpack/msgpack";
import { Buffer } from "node:buffer";
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
  TASKS,
  WRITES_IDX_MAP,
  copyCheckpoint,
  maxChannelVersion,
} from "@langchain/langgraph-checkpoint";
import oracledb from "oracledb";
import type {
  BindDefinition,
  BindParameters,
  ExecuteManyOptions,
  ExecuteOptions,
} from "oracledb";

import {
  getOracleDiagnosticsStatus,
  getOracleRuntimeDiagnostics,
  inspectOracleMigrations,
  inspectOracleSchema,
  type ExpectedOracleTable,
  type OracleCheckpointSaverDiagnostics,
  type OracleDiagnosticsOptions,
} from "./diagnostics.js";
import { getMigrations } from "./migrations.js";
import {
  type OracleBindParams,
  buildSelectCheckpointSQL,
  decodeCheckpointNamespace,
  encodeCheckpointNamespace,
  encodeTaskPath,
  getOracleCheckpointTables,
  getOracleSQLStatements,
  getOracleSetupStatements,
  getPendingSendsParams,
  validateTableSuffix,
} from "./sql.js";
import {
  isOracleError,
  parseOracleConnectionString,
  poolConfigToConnectionOptions,
  rowValue,
  validateUtf8ByteLength,
  type OraclePoolConfig,
} from "./utils.js";

export interface OracleConnectionOptions {
  [key: string]: unknown;
  user?: string;
  password?: string;
  connectString?: string;
}

type OracleExecuteResult<RowT> = {
  rows?: RowT[];
  rowsAffected?: number;
};

type OracleDriverBindParams = Extract<BindParameters, Record<string, unknown>>;

export interface OracleConnectionLike {
  execute<RowT = Record<string, unknown>>(
    sql: string,
    binds?: OracleDriverBindParams,
    options?: ExecuteOptions
  ): Promise<OracleExecuteResult<RowT>>;
  executeMany?(
    sql: string,
    binds: OracleDriverBindParams[],
    options?: ExecuteManyOptions
  ): Promise<OracleExecuteResult<Record<string, unknown>>>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  close?(): Promise<void>;
  release?(): Promise<void>;
}

export interface OraclePoolLike {
  getConnection(): Promise<OracleConnectionLike>;
  close?(drainTime?: number): Promise<void>;
}

export interface OracleCheckpointSaverOptions {
  connection?: OracleConnectionLike | OracleConnectionOptions;
  pool?: OraclePoolLike;
  tableSuffix?: string;
  serde?: SerializerProtocol;
  /**
   * Maximum serialized size, in MiB, for plain JSON channel values stored
   * inline with the checkpoint. Defaults to the Python saver's 1 MiB limit.
   */
  jsonSizeThresholdMb?: number;
}

type OracleRow = Record<string, unknown>;

type ExecuteOptionsWithBindDefs = ExecuteOptions & {
  bindDefs?: Record<string, BindDefinition>;
};

const STRING_2000: BindDefinition = { type: oracledb.STRING, maxSize: 2000 };
const NUMBER_BIND: BindDefinition = { type: oracledb.NUMBER };
const BLOB_BIND: BindDefinition = { type: oracledb.BLOB };
const JSON_BIND: BindDefinition = { type: oracledb.DB_TYPE_JSON };
const CHECKPOINT_KEY_MAX_BYTES = 2000;
const CHECKPOINT_TYPE_MAX_BYTES = 2000;
const CHECKPOINT_BYTE_CONTEXT = "Oracle checkpoint";
const CHECKPOINT_BYTE_SUFFIX = " after encoding";
const DEFAULT_JSON_SIZE_THRESHOLD_MB = 1;

const isIdempotentMigrationError = (error: unknown): boolean =>
  isOracleError(error, 955) || isOracleError(error, 1408);

const CHECKPOINT_BINDS: Record<string, BindDefinition> = {
  thread_id: STRING_2000,
  checkpoint_ns: STRING_2000,
  checkpoint_id: STRING_2000,
  parent_checkpoint_id: STRING_2000,
  checkpoint: JSON_BIND,
  metadata: JSON_BIND,
};

const CHECKPOINT_BLOB_BINDS: Record<string, BindDefinition> = {
  thread_id: STRING_2000,
  checkpoint_ns: STRING_2000,
  channel: STRING_2000,
  version: STRING_2000,
  type: STRING_2000,
  blob: BLOB_BIND,
};

const CHECKPOINT_WRITE_BINDS: Record<string, BindDefinition> = {
  thread_id: STRING_2000,
  checkpoint_ns: STRING_2000,
  checkpoint_id: STRING_2000,
  task_id: STRING_2000,
  task_path: STRING_2000,
  idx: NUMBER_BIND,
  channel: STRING_2000,
  type: STRING_2000,
  blob: BLOB_BIND,
};

const toExecuteBinds = (
  binds: OracleBindParams,
  bindDefs?: Record<string, BindDefinition>
): OracleDriverBindParams => {
  if (!bindDefs) return binds as OracleDriverBindParams;
  return Object.fromEntries(
    Object.entries(binds).map(([key, val]) => {
      const def = bindDefs[key];
      return [key, def ? { val, ...def } : val];
    })
  ) as OracleDriverBindParams;
};

const getExpectedCheckpointTables = (
  tables: ReturnType<typeof getOracleCheckpointTables>
): ExpectedOracleTable[] => [
  {
    name: tables.checkpoint_migrations,
    required: true,
    columns: [{ name: "v", dataTypes: ["NUMBER"] }],
    primaryKey: ["v"],
  },
  {
    name: tables.checkpoints,
    required: true,
    columns: [
      { name: "thread_id", dataTypes: ["VARCHAR2"] },
      { name: "checkpoint_ns", dataTypes: ["VARCHAR2"] },
      { name: "checkpoint_id", dataTypes: ["VARCHAR2"] },
      { name: "parent_checkpoint_id", dataTypes: ["VARCHAR2"] },
      { name: "type", dataTypes: ["VARCHAR2"] },
      { name: "checkpoint", dataTypes: ["JSON"] },
      { name: "metadata", dataTypes: ["JSON"] },
    ],
    primaryKey: ["thread_id", "checkpoint_ns", "checkpoint_id"],
  },
  {
    name: tables.checkpoint_blobs,
    required: true,
    columns: [
      { name: "thread_id", dataTypes: ["VARCHAR2"] },
      { name: "checkpoint_ns", dataTypes: ["VARCHAR2"] },
      { name: "channel", dataTypes: ["VARCHAR2"] },
      { name: "version", dataTypes: ["VARCHAR2"] },
      { name: "type", dataTypes: ["VARCHAR2"] },
      { name: "blob", dataTypes: ["BLOB"] },
    ],
    primaryKey: ["thread_id", "checkpoint_ns", "channel", "version"],
  },
  {
    name: tables.checkpoint_writes,
    required: true,
    columns: [
      { name: "thread_id", dataTypes: ["VARCHAR2"] },
      { name: "checkpoint_ns", dataTypes: ["VARCHAR2"] },
      { name: "checkpoint_id", dataTypes: ["VARCHAR2"] },
      { name: "task_id", dataTypes: ["VARCHAR2"] },
      { name: "idx", dataTypes: ["NUMBER"] },
      { name: "channel", dataTypes: ["VARCHAR2"] },
      { name: "type", dataTypes: ["VARCHAR2"] },
      { name: "blob", dataTypes: ["BLOB"] },
      { name: "task_path", dataTypes: ["VARCHAR2"] },
    ],
    primaryKey: [
      "thread_id",
      "checkpoint_ns",
      "checkpoint_id",
      "task_id",
      "idx",
    ],
  },
];

const checkpointStorageModeFromDiagnostics = (
  diagnostics: OracleCheckpointSaverDiagnostics
): OracleCheckpointSaverDiagnostics["storageMode"] => {
  const checkpointTable = diagnostics.schema.tables.find(
    (table) => table.name === diagnostics.tables.checkpoints
  );
  if (!checkpointTable?.exists) return "missing";
  const checkpointColumn = checkpointTable.columns.find(
    (column) => column.name.toUpperCase() === "CHECKPOINT"
  );
  if (!checkpointColumn) return "unknown";
  const dataType = checkpointColumn.dataType.toUpperCase();
  if (dataType === "JSON") return "json";
  if (dataType === "BLOB") return "blob";
  if (dataType === "CLOB") return "clob";
  return "unknown";
};

function isConnection(value: unknown): value is OracleConnectionLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof (value as OracleConnectionLike).execute === "function"
  );
}

function validateNonEmptyByteLength(
  label: string,
  value: string | null | undefined,
  maxBytes: number
): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Oracle checkpoint ${label} must be a non-empty string.`);
  }
  validateUtf8ByteLength(
    CHECKPOINT_BYTE_CONTEXT,
    label,
    value,
    maxBytes,
    CHECKPOINT_BYTE_SUFFIX
  );
}

function validateOptionalNonEmptyByteLength(
  label: string,
  value: string | null | undefined,
  maxBytes: number
): void {
  if (value === null || value === undefined) return;
  validateNonEmptyByteLength(label, value, maxBytes);
}

function validateCheckpointKeyFields({
  threadId,
  encodedCheckpointNs,
  checkpointId,
  parentCheckpointId,
}: {
  threadId: string;
  encodedCheckpointNs: string;
  checkpointId?: string | null;
  parentCheckpointId?: string | null;
}): void {
  validateNonEmptyByteLength("thread_id", threadId, CHECKPOINT_KEY_MAX_BYTES);
  validateUtf8ByteLength(
    CHECKPOINT_BYTE_CONTEXT,
    "checkpoint_ns",
    encodedCheckpointNs,
    CHECKPOINT_KEY_MAX_BYTES,
    CHECKPOINT_BYTE_SUFFIX
  );
  validateOptionalNonEmptyByteLength(
    "checkpoint_id",
    checkpointId,
    CHECKPOINT_KEY_MAX_BYTES
  );
  validateOptionalNonEmptyByteLength(
    "parent_checkpoint_id",
    parentCheckpointId,
    CHECKPOINT_KEY_MAX_BYTES
  );
}

function validateCheckpointListFields(
  threadId?: string,
  checkpointNs?: string | null,
  checkpointId?: string,
  beforeCheckpointId?: string
): void {
  if (threadId !== undefined) {
    validateNonEmptyByteLength("thread_id", threadId, CHECKPOINT_KEY_MAX_BYTES);
  }
  if (checkpointNs !== undefined && checkpointNs !== null) {
    validateUtf8ByteLength(
      CHECKPOINT_BYTE_CONTEXT,
      "checkpoint_ns",
      encodeCheckpointNamespace(checkpointNs),
      CHECKPOINT_KEY_MAX_BYTES,
      CHECKPOINT_BYTE_SUFFIX
    );
  }
  validateOptionalNonEmptyByteLength(
    "checkpoint_id",
    checkpointId,
    CHECKPOINT_KEY_MAX_BYTES
  );
  validateOptionalNonEmptyByteLength(
    "before.checkpoint_id",
    beforeCheckpointId,
    CHECKPOINT_KEY_MAX_BYTES
  );
}

function validateCheckpointListLimit(
  limit: number | undefined
): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0) {
    throw new Error(
      "Oracle checkpoint list limit must be a non-negative integer."
    );
  }
  return limit;
}

async function closeConnection(
  connection: OracleConnectionLike
): Promise<void> {
  if (connection.close) {
    await connection.close();
  } else if (connection.release) {
    await connection.release();
  }
}

async function valueToUint8Array(value: unknown): Promise<Uint8Array> {
  if (value == null) return new Uint8Array();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return new TextEncoder().encode(value);

  if (
    typeof value === "object" &&
    value !== null &&
    "getData" in value &&
    typeof (value as { getData: () => Promise<unknown> }).getData === "function"
  ) {
    return valueToUint8Array(
      await (value as { getData: () => Promise<unknown> }).getData()
    );
  }

  if (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  ) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of value as AsyncIterable<Uint8Array | string>) {
      chunks.push(await valueToUint8Array(chunk));
    }
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  return new TextEncoder().encode(String(value));
}

function normalizeJsonValue(value: unknown, valueName: string): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // Report one stable backend error instead of engine-specific JSON errors.
  }
  if (serialized === undefined) {
    throw new Error(
      `Oracle checkpoint ${valueName} must be JSON serializable.`
    );
  }
  return JSON.parse(serialized);
}

function isPlainJsonValue(
  value: unknown,
  ancestors: Set<object> = new Set()
): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;

  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        Reflect.ownKeys(value).length !== value.length + 1 ||
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        return false;
      }
      return value.every((item) => isPlainJsonValue(item, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Reflect.ownKeys(value).length !== Object.keys(value).length)
      return false;
    return Object.values(value).every((item) =>
      isPlainJsonValue(item, ancestors)
    );
  } finally {
    ancestors.delete(value);
  }
}

function shouldUseBlob(value: unknown, jsonSizeThresholdMb: number): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return false;
  }
  if (!isPlainJsonValue(value)) return true;

  const serialized = JSON.stringify(value);
  return (
    Buffer.byteLength(serialized, "utf8") > jsonSizeThresholdMb * 1024 * 1024
  );
}

function validateJsonSizeThreshold(value: number | undefined): number {
  const threshold = value ?? DEFAULT_JSON_SIZE_THRESHOLD_MB;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(
      "Oracle checkpoint jsonSizeThresholdMb must be a non-negative finite number."
    );
  }
  return threshold;
}

/**
 * LangGraph checkpointer backed by Oracle Database.
 *
 * This MVP uses the package-local migration and SQL helpers, node-oracledb
 * bind parameters, and LangGraph serde for checkpoint values and writes.
 */
export class OracleCheckpointSaver extends BaseCheckpointSaver {
  private pool?: OraclePoolLike;

  private poolPromise?: Promise<OraclePoolLike>;

  private readonly ownsPool: boolean;

  private connection?: OracleConnectionLike;

  private readonly ownsConnection: boolean;

  private readonly connectionOptions?: OracleConnectionOptions;

  private readonly tableSuffix: string;

  private readonly sql: ReturnType<typeof getOracleSQLStatements>;

  private readonly setupSql: ReturnType<typeof getOracleSetupStatements>;

  private readonly jsonSizeThresholdMb: number;

  private setupPromise?: Promise<void>;

  private readonly usesDefaultSerde: boolean;

  private rawConnectionLock: Promise<void> = Promise.resolve();

  constructor(options: OracleCheckpointSaverOptions = {}) {
    super(options.serde);
    this.usesDefaultSerde = options.serde === undefined;
    this.pool = options.pool;
    this.ownsPool = options.pool === undefined;
    if (isConnection(options.connection)) {
      this.connection = options.connection;
      this.ownsConnection = false;
    } else {
      this.connectionOptions = options.connection;
      this.ownsConnection = true;
    }
    this.tableSuffix = options.tableSuffix
      ? validateTableSuffix(options.tableSuffix)
      : "";
    this.jsonSizeThresholdMb = validateJsonSizeThreshold(
      options.jsonSizeThresholdMb
    );
    this.sql = getOracleSQLStatements(this.tableSuffix);
    this.setupSql = getOracleSetupStatements(this.tableSuffix);
  }

  /**
   * Build a saver from a `user/password@dsn` connection string, as Python's
   * `OracleSaver.from_conn_string` does.
   */
  static fromConnString(
    connString: string,
    options: Omit<OracleCheckpointSaverOptions, "connection" | "pool"> & {
      poolConfig?: OraclePoolConfig;
    } = {}
  ): OracleCheckpointSaver {
    const { poolConfig, ...saverOptions } = options;
    return new OracleCheckpointSaver({
      connection: {
        ...parseOracleConnectionString(connString),
        ...poolConfigToConnectionOptions(poolConfig),
      },
      ...saverOptions,
    });
  }

  async setup(): Promise<void> {
    this.setupPromise ??= this.withTransaction(async (connection) => {
      const migrations = getMigrations(this.tableSuffix);
      let currentVersion = -1;

      try {
        const result = await connection.execute<OracleRow>(
          this.setupSql.SELECT_LATEST_MIGRATION_SQL,
          {},
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const [row] = result.rows ?? [];
        if (row) currentVersion = Number(rowValue(row, "v"));
      } catch (error) {
        if (!isOracleError(error, 942)) throw error;
      }

      if (currentVersion >= migrations.length) {
        throw new Error(
          `Oracle checkpoint schema version ${currentVersion} is newer than the highest supported version ${migrations.length - 1}.`
        );
      }

      for (
        let version = currentVersion + 1;
        version < migrations.length;
        version += 1
      ) {
        const migrationSql = migrations[version];
        try {
          await connection.execute(migrationSql);
        } catch (error) {
          if (!isIdempotentMigrationError(error)) throw error;
        }

        try {
          await connection.execute(this.setupSql.INSERT_MIGRATION_SQL, {
            version,
          });
        } catch (error) {
          if (!isOracleError(error, 1)) throw error;
        }
      }

      await this.validateCheckpointSchema(connection);
    }).catch((error) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  async end(): Promise<void> {
    if (this.connection && this.ownsConnection) {
      await closeConnection(this.connection);
    }
    this.connection = undefined;
    if (!this.pool && this.poolPromise && this.ownsPool) {
      try {
        await this.poolPromise;
      } catch {
        // Pool creation already failed for the operation that requested it.
      }
    }
    if (this.pool?.close && this.ownsPool) {
      await this.pool.close(0);
    }
    this.pool = undefined;
    this.poolPromise = undefined;
    this.setupPromise = undefined;
  }

  async getDiagnostics(
    options: OracleDiagnosticsOptions = {}
  ): Promise<OracleCheckpointSaverDiagnostics> {
    return this.withConnection(async (connection) => {
      const tables = getOracleCheckpointTables(this.tableSuffix);
      const expectedTables = getExpectedCheckpointTables(tables);
      const expectedVersions = getMigrations(this.tableSuffix).map(
        (_migration, version) => version
      );
      const schema = await inspectOracleSchema(
        connection,
        expectedTables,
        options
      );
      const migrations = await inspectOracleMigrations(
        connection,
        tables.checkpoint_migrations,
        expectedVersions,
        expectedVersions
      );
      const diagnostics: OracleCheckpointSaverDiagnostics = {
        kind: "checkpoint",
        status: getOracleDiagnosticsStatus(schema, migrations),
        tableSuffix: this.tableSuffix,
        tables,
        runtime: getOracleRuntimeDiagnostics(oracledb, connection),
        migrations,
        schema,
        storageMode: "unknown",
        issues: [...schema.issues],
      };
      diagnostics.storageMode =
        checkpointStorageModeFromDiagnostics(diagnostics);
      return diagnostics;
    });
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) return undefined;

    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;
    const encodedCheckpointNs = encodeCheckpointNamespace(checkpointNs);
    validateCheckpointKeyFields({
      threadId,
      encodedCheckpointNs,
      checkpointId,
    });
    await this.setup();
    const query = buildSelectCheckpointSQL(
      {
        threadId,
        checkpointNs,
        checkpointId,
        limit: 1,
      },
      this.tableSuffix
    );

    const rows = await this.selectCheckpointRows(query.sql, query.binds);
    const [row] = rows;
    if (!row) return undefined;
    return this.rowToTuple(row);
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    validateCheckpointListFields(
      config.configurable?.thread_id,
      config.configurable?.checkpoint_ns,
      config.configurable?.checkpoint_id,
      options?.before?.configurable?.checkpoint_id
    );
    const limit = validateCheckpointListLimit(options?.limit);
    const query = buildSelectCheckpointSQL(
      {
        threadId: config.configurable?.thread_id,
        checkpointNs:
          config.configurable?.checkpoint_ns === undefined ||
          config.configurable?.checkpoint_ns === null
            ? undefined
            : config.configurable.checkpoint_ns,
        checkpointId: config.configurable?.checkpoint_id,
        beforeCheckpointId: options?.before?.configurable?.checkpoint_id,
        metadataFilter: options?.filter,
        limit,
      },
      this.tableSuffix
    );
    if (limit !== undefined && limit <= 0) return;
    await this.setup();

    const rows = await this.selectCheckpointRows(query.sql, query.binds);
    for (const row of rows) {
      yield await this.rowToTuple(row);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    if (config.configurable === undefined) {
      throw new Error(`Missing "configurable" field in "config" param.`);
    }

    const threadId = config.configurable.thread_id;
    if (!threadId) {
      throw new Error(
        `Missing "thread_id" field in passed "config.configurable".`
      );
    }

    const checkpointNs = config.configurable.checkpoint_ns ?? "";
    const encodedCheckpointNs = encodeCheckpointNamespace(checkpointNs);
    const parentCheckpointId = config.configurable.checkpoint_id ?? null;
    validateCheckpointKeyFields({
      threadId,
      encodedCheckpointNs,
      checkpointId: checkpoint.id,
      parentCheckpointId,
    });
    for (const [channel, version] of Object.entries(newVersions)) {
      validateNonEmptyByteLength("channel", channel, CHECKPOINT_KEY_MAX_BYTES);
      validateNonEmptyByteLength(
        "channel version",
        String(version),
        CHECKPOINT_KEY_MAX_BYTES
      );
    }
    const checkpointValue = copyCheckpoint(checkpoint);
    const blobValues: Record<string, unknown> = {};
    for (const [channel, value] of Object.entries(
      checkpointValue.channel_values
    )) {
      if (shouldUseBlob(value, this.jsonSizeThresholdMb)) {
        blobValues[channel] = value;
        delete checkpointValue.channel_values[channel];
      }
    }
    checkpointValue.channel_versions = {
      ...checkpointValue.channel_versions,
      ...newVersions,
    };
    const blobVersions = Object.fromEntries(
      Object.entries(newVersions).filter(([channel]) => channel in blobValues)
    );
    const blobRows = await this.dumpBlobs(
      threadId,
      checkpointNs,
      blobValues,
      blobVersions
    );
    const checkpointJson = normalizeJsonValue(checkpointValue, "checkpoint");
    const metadataJson = normalizeJsonValue(metadata, "metadata");
    await this.setup();

    await this.withTransaction(async (connection) => {
      await this.executeManyWithDuplicateRetry(
        connection,
        this.sql.UPSERT_CHECKPOINT_BLOBS_SQL,
        blobRows,
        { bindDefs: CHECKPOINT_BLOB_BINDS }
      );

      await this.executeWithDuplicateRetry(
        connection,
        this.sql.UPSERT_CHECKPOINTS_SQL,
        {
          thread_id: threadId,
          checkpoint_ns: encodedCheckpointNs,
          checkpoint_id: checkpoint.id,
          parent_checkpoint_id: parentCheckpointId,
          checkpoint: checkpointJson,
          metadata: metadataJson,
        },
        {
          bindDefs: CHECKPOINT_BINDS,
        }
      );
    });

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = ""
  ): Promise<void> {
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId) {
      throw new Error("Missing thread_id field in config.configurable.");
    }
    if (!checkpointId) {
      throw new Error("Missing checkpoint_id field in config.configurable.");
    }

    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const encodedCheckpointNs = encodeCheckpointNamespace(checkpointNs);
    validateCheckpointKeyFields({
      threadId,
      encodedCheckpointNs,
      checkpointId,
    });
    validateNonEmptyByteLength("task_id", taskId, CHECKPOINT_KEY_MAX_BYTES);
    const encodedTaskPath = encodeTaskPath(taskPath);
    validateNonEmptyByteLength(
      "task_path",
      encodedTaskPath,
      CHECKPOINT_KEY_MAX_BYTES
    );
    const query = writes.every(([channel]) => channel in WRITES_IDX_MAP)
      ? this.sql.UPSERT_CHECKPOINT_WRITES_SQL
      : this.sql.INSERT_CHECKPOINT_WRITES_SQL;
    const rows = await this.dumpWrites(
      threadId,
      checkpointNs,
      checkpointId,
      taskId,
      encodedTaskPath,
      writes
    );
    await this.setup();

    await this.withTransaction(async (connection) => {
      for (const row of rows) {
        try {
          if (query === this.sql.UPSERT_CHECKPOINT_WRITES_SQL) {
            await this.executeWithDuplicateRetry(connection, query, row, {
              bindDefs: CHECKPOINT_WRITE_BINDS,
            });
          } else {
            await connection.execute(
              query,
              toExecuteBinds(row, CHECKPOINT_WRITE_BINDS)
            );
          }
        } catch (error) {
          if (
            query === this.sql.INSERT_CHECKPOINT_WRITES_SQL &&
            isOracleError(error, 1)
          ) {
            continue;
          }
          throw error;
        }
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    validateNonEmptyByteLength("thread_id", threadId, CHECKPOINT_KEY_MAX_BYTES);
    await this.setup();
    await this.withTransaction(async (connection) => {
      await connection.execute(this.sql.DELETE_CHECKPOINT_WRITES_SQL, {
        thread_id: threadId,
      });
      await connection.execute(this.sql.DELETE_CHECKPOINT_BLOBS_SQL, {
        thread_id: threadId,
      });
      await connection.execute(this.sql.DELETE_CHECKPOINTS_SQL, {
        thread_id: threadId,
      });
    });
  }

  private async getConnection(): Promise<{
    connection: OracleConnectionLike;
    shouldClose: boolean;
  }> {
    if (this.pool) {
      return {
        connection: await this.pool.getConnection(),
        shouldClose: true,
      };
    }

    if (this.connection) {
      return { connection: this.connection, shouldClose: false };
    }

    const pool = await this.ensurePool();
    return {
      connection: await pool.getConnection(),
      shouldClose: true,
    };
  }

  private async ensurePool(): Promise<OraclePoolLike> {
    if (this.pool) return this.pool;
    this.poolPromise ??= (
      oracledb.createPool(
        this.connectionOptions ?? {}
      ) as Promise<OraclePoolLike>
    )
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
    callback: (connection: OracleConnectionLike) => Promise<T>
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const { connection, shouldClose } = await this.getConnection();
      try {
        return await callback(connection);
      } finally {
        if (shouldClose) await closeConnection(connection);
      }
    };

    if (this.connection && !this.ownsConnection) {
      return this.withRawConnectionLock(run);
    }
    return run();
  }

  private async withRawConnectionLock<T>(
    callback: () => Promise<T>
  ): Promise<T> {
    const previous = this.rawConnectionLock;
    let release!: () => void;
    this.rawConnectionLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  private async withTransaction<T>(
    callback: (connection: OracleConnectionLike) => Promise<T>
  ): Promise<T> {
    return this.withConnection(async (connection) => {
      try {
        const result = await callback(connection);
        await connection.commit?.();
        return result;
      } catch (error) {
        await connection.rollback?.();
        throw error;
      }
    });
  }

  private async executeWithDuplicateRetry(
    connection: OracleConnectionLike,
    sql: string,
    binds: OracleBindParams,
    options?: ExecuteOptionsWithBindDefs
  ): Promise<OracleExecuteResult<OracleRow>> {
    const { bindDefs, ...executeOptions } = options ?? {};
    const executeBinds = toExecuteBinds(binds, bindDefs);
    try {
      return await connection.execute(sql, executeBinds, executeOptions);
    } catch (error) {
      if (!isOracleError(error, 1)) throw error;
      return connection.execute(sql, executeBinds, executeOptions);
    }
  }

  private async executeManyWithDuplicateRetry(
    connection: OracleConnectionLike,
    sql: string,
    binds: OracleBindParams[],
    options?: ExecuteOptionsWithBindDefs
  ): Promise<void> {
    if (binds.length === 0) return;
    if (!connection.executeMany) {
      for (const row of binds) {
        await this.executeWithDuplicateRetry(connection, sql, row, options);
      }
      return;
    }
    try {
      await connection.executeMany(
        sql,
        binds as OracleDriverBindParams[],
        options
      );
    } catch (error) {
      if (!isOracleError(error, 1)) throw error;
      await connection.executeMany(
        sql,
        binds as OracleDriverBindParams[],
        options
      );
    }
  }

  private async selectCheckpointRows(
    sql: string,
    binds: OracleBindParams
  ): Promise<OracleRow[]> {
    return this.withConnection(async (connection) => {
      const result = await connection.execute<OracleRow>(
        sql,
        toExecuteBinds(binds),
        {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        }
      );
      return result.rows ?? [];
    });
  }

  private async validateCheckpointSchema(
    connection: OracleConnectionLike
  ): Promise<void> {
    const tables = getOracleCheckpointTables(this.tableSuffix);
    const result = await connection.execute<OracleRow>(
      `SELECT table_name, column_name, data_type
FROM user_tab_columns
WHERE (table_name = UPPER(:checkpoints)
       AND column_name IN ('CHECKPOINT', 'METADATA'))
   OR (table_name = UPPER(:checkpoint_writes)
       AND column_name = 'TASK_PATH')`,
      {
        checkpoints: tables.checkpoints,
        checkpoint_writes: tables.checkpoint_writes,
      },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const columns = new Map(
      (result.rows ?? []).map((row) => [
        `${String(rowValue(row, "table_name")).toUpperCase()}.${String(
          rowValue(row, "column_name")
        ).toUpperCase()}`,
        String(rowValue(row, "data_type")).toUpperCase(),
      ])
    );
    const expected = [
      [`${tables.checkpoints}.CHECKPOINT`, "JSON"],
      [`${tables.checkpoints}.METADATA`, "JSON"],
      [`${tables.checkpoint_writes}.TASK_PATH`, "VARCHAR2"],
    ] as const;
    const incompatibility = expected.find(
      ([column, dataType]) => columns.get(column) !== dataType
    );
    if (incompatibility) {
      const [column, expectedType] = incompatibility;
      const observedType = columns.get(column) ?? "missing";
      throw new Error(
        `Oracle checkpoint schema is incompatible: ${column} must be ${expectedType}, found ${observedType}. The JavaScript and Python Oracle savers require the same native-JSON schema.`
      );
    }
  }

  private async loadCheckpoint(row: OracleRow): Promise<Checkpoint> {
    const checkpointValue = rowValue<unknown>(row, "checkpoint");
    const checkpoint = (
      typeof checkpointValue === "string"
        ? JSON.parse(checkpointValue)
        : checkpointValue
    ) as Checkpoint;

    const blobs = await this.selectChannelValueRows(
      rowValue(row, "thread_id"),
      rowValue(row, "checkpoint_ns"),
      checkpoint
    );
    return {
      ...checkpoint,
      channel_values: {
        ...(checkpoint.channel_values ?? {}),
        ...(await this.loadBlobs(blobs)),
      },
    };
  }

  private async selectChannelValueRows(
    threadId: string,
    encodedCheckpointNs: string,
    checkpoint: Omit<Checkpoint, "channel_values">
  ): Promise<OracleRow[]> {
    const channelVersions = Object.entries(
      checkpoint.channel_versions ?? {}
    ).map(([channel, version]) => ({ channel, version: String(version) }));
    if (channelVersions.length === 0) return [];

    return this.withConnection(async (connection) => {
      const result = await connection.execute<OracleRow>(
        this.sql.SELECT_CHECKPOINT_BLOBS_SQL,
        {
          thread_id: threadId,
          checkpoint_ns: encodedCheckpointNs,
          channel_versions_json: JSON.stringify(channelVersions),
        },
        {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          fetchInfo: { BLOB: { type: oracledb.BUFFER } },
        }
      );
      return result.rows ?? [];
    });
  }

  private async selectWrites(
    threadId: string,
    encodedCheckpointNs: string,
    checkpointId: string
  ): Promise<OracleRow[]> {
    return this.withConnection(async (connection) => {
      const result = await connection.execute<OracleRow>(
        this.sql.SELECT_CHECKPOINT_WRITES_SQL,
        {
          thread_id: threadId,
          checkpoint_ns: encodedCheckpointNs,
          checkpoint_id: checkpointId,
        },
        {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          fetchInfo: { BLOB: { type: oracledb.BUFFER } },
        }
      );
      return result.rows ?? [];
    });
  }

  private async rowToTuple(row: OracleRow): Promise<CheckpointTuple> {
    const encodedCheckpointNs = rowValue<string>(row, "checkpoint_ns");
    const checkpointNs = decodeCheckpointNamespace(encodedCheckpointNs);
    const checkpoint = await this.loadCheckpoint(row);
    const parentCheckpointId = rowValue<string | null | undefined>(
      row,
      "parent_checkpoint_id"
    );

    if (checkpoint.v < 4 && parentCheckpointId) {
      await this.addPendingSendsFromParent(
        checkpoint,
        rowValue(row, "thread_id"),
        checkpointNs,
        parentCheckpointId
      );
    }

    const writes = await this.selectWrites(
      rowValue(row, "thread_id"),
      encodedCheckpointNs,
      rowValue(row, "checkpoint_id")
    );

    return {
      config: {
        configurable: {
          thread_id: rowValue(row, "thread_id"),
          checkpoint_ns: checkpointNs,
          checkpoint_id: rowValue(row, "checkpoint_id"),
        },
      },
      checkpoint,
      metadata: await this.loadMetadata(row),
      parentConfig: parentCheckpointId
        ? {
            configurable: {
              thread_id: rowValue(row, "thread_id"),
              checkpoint_ns: checkpointNs,
              checkpoint_id: parentCheckpointId,
            },
          }
        : undefined,
      pendingWrites: await this.loadWrites(writes),
    };
  }

  private async loadMetadata(row: OracleRow): Promise<CheckpointMetadata> {
    const metadata = rowValue<unknown>(row, "metadata");
    return (
      typeof metadata === "string" ? JSON.parse(metadata) : metadata
    ) as CheckpointMetadata;
  }

  private async loadBlobs(rows: OracleRow[]): Promise<Record<string, unknown>> {
    const entries = await Promise.all(
      rows
        .filter((row) => rowValue<string>(row, "type") !== "empty")
        .map(async (row) => [
          rowValue<string>(row, "channel"),
          await this.loadTyped(
            rowValue<string>(row, "type"),
            await valueToUint8Array(rowValue(row, "blob"))
          ),
        ])
    );
    return Object.fromEntries(entries);
  }

  private async loadWrites(
    rows: OracleRow[]
  ): Promise<[string, string, unknown][]> {
    return Promise.all(
      rows.map(
        async (row) =>
          [
            rowValue<string>(row, "task_id"),
            rowValue<string>(row, "channel"),
            await this.loadTyped(
              rowValue<string | null | undefined>(row, "type") ?? "json",
              await valueToUint8Array(rowValue(row, "blob"))
            ),
          ] as [string, string, unknown]
      )
    );
  }

  private async addPendingSendsFromParent(
    checkpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string
  ): Promise<void> {
    const rows = await this.withConnection(async (connection) => {
      const result = await connection.execute<OracleRow>(
        this.sql.SELECT_PENDING_SENDS_SQL,
        toExecuteBinds(
          getPendingSendsParams(threadId, checkpointNs, [parentCheckpointId])
        ),
        {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          fetchInfo: { BLOB: { type: oracledb.BUFFER } },
        }
      );
      return result.rows ?? [];
    });
    if (rows.length === 0) return;

    checkpoint.channel_values ??= {};
    checkpoint.channel_values[TASKS] = await Promise.all(
      rows.map(async (row) =>
        this.loadTyped(
          rowValue<string | null | undefined>(row, "type") ?? "json",
          await valueToUint8Array(rowValue(row, "blob"))
        )
      )
    );
    checkpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }

  private async loadTyped(type: string, bytes: Uint8Array): Promise<unknown> {
    if (this.usesDefaultSerde) {
      if (type === "null") return null;
      if (type === "bytearray") return bytes;
      if (type === "msgpack") return decodeMessagePack(bytes);
    }
    return this.serde.loadsTyped(type, bytes);
  }

  private async dumpBlobs(
    threadId: string,
    checkpointNs: string,
    values: Record<string, unknown>,
    versions: ChannelVersions
  ): Promise<OracleBindParams[]> {
    const encodedCheckpointNs = encodeCheckpointNamespace(checkpointNs);
    return Promise.all(
      Object.entries(versions).map(async ([channel, version]) => {
        validateCheckpointKeyFields({
          threadId,
          encodedCheckpointNs,
        });
        validateNonEmptyByteLength(
          "channel",
          channel,
          CHECKPOINT_KEY_MAX_BYTES
        );
        validateNonEmptyByteLength(
          "channel version",
          String(version),
          CHECKPOINT_KEY_MAX_BYTES
        );
        if (!(channel in values)) {
          return {
            thread_id: threadId,
            checkpoint_ns: encodedCheckpointNs,
            channel,
            version: String(version),
            type: "empty",
            blob: null,
          };
        }
        const [type, blob] = await this.serde.dumpsTyped(values[channel]);
        validateUtf8ByteLength(
          CHECKPOINT_BYTE_CONTEXT,
          "channel serializer type",
          type,
          CHECKPOINT_TYPE_MAX_BYTES,
          CHECKPOINT_BYTE_SUFFIX
        );
        return {
          thread_id: threadId,
          checkpoint_ns: encodedCheckpointNs,
          channel,
          version: String(version),
          type,
          blob: Buffer.from(blob),
        };
      })
    );
  }

  private async dumpWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
    taskId: string,
    encodedTaskPath: string,
    writes: PendingWrite[]
  ): Promise<OracleBindParams[]> {
    const encodedCheckpointNs = encodeCheckpointNamespace(checkpointNs);
    return Promise.all(
      writes.map(async ([channel, value], idx) => {
        validateCheckpointKeyFields({
          threadId,
          encodedCheckpointNs,
          checkpointId,
        });
        validateNonEmptyByteLength("task_id", taskId, CHECKPOINT_KEY_MAX_BYTES);
        validateNonEmptyByteLength(
          "write channel",
          channel,
          CHECKPOINT_KEY_MAX_BYTES
        );
        const [type, blob] = await this.serde.dumpsTyped(value);
        validateUtf8ByteLength(
          CHECKPOINT_BYTE_CONTEXT,
          "write serializer type",
          type,
          CHECKPOINT_TYPE_MAX_BYTES,
          CHECKPOINT_BYTE_SUFFIX
        );
        return {
          thread_id: threadId,
          checkpoint_ns: encodedCheckpointNs,
          checkpoint_id: checkpointId,
          task_id: taskId,
          task_path: encodedTaskPath,
          idx: WRITES_IDX_MAP[channel] ?? idx,
          channel,
          type,
          blob: Buffer.from(blob),
        };
      })
    );
  }
}
