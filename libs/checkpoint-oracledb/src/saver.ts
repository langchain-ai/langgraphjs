import type { RunnableConfig } from "@langchain/core/runnables";
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

import { getMigrations } from "./migrations.js";
import {
  type OracleBindParams,
  buildSelectCheckpointSQL,
  decodeCheckpointNamespace,
  encodeCheckpointNamespace,
  getOracleSQLStatements,
  getOracleSetupStatements,
  getPendingSendsParams,
  validateTablePrefix,
} from "./sql.js";

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

export interface OracleConnectionLike {
  execute<RowT = Record<string, unknown>>(
    sql: string,
    binds?: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<OracleExecuteResult<RowT>>;
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
  tablePrefix?: string;
  serde?: SerializerProtocol;
}

type OracleRow = Record<string, unknown>;

type SerializedBytes = [type: string, bytes: Buffer];

type BindDefinition = {
  type: number;
  maxSize?: number;
};

const STRING_512: BindDefinition = { type: oracledb.STRING, maxSize: 512 };
const STRING_255: BindDefinition = { type: oracledb.STRING, maxSize: 255 };
const NUMBER_BIND: BindDefinition = { type: oracledb.NUMBER };
const BLOB_BIND: BindDefinition = { type: oracledb.BLOB };
const CHECKPOINT_KEY_MAX_BYTES = 512;
const CHECKPOINT_TYPE_MAX_BYTES = 255;

const CHECKPOINT_BINDS: Record<string, BindDefinition> = {
  thread_id: STRING_512,
  checkpoint_ns: STRING_512,
  checkpoint_id: STRING_512,
  parent_checkpoint_id: STRING_512,
  type: STRING_255,
  metadata_type: STRING_255,
  checkpoint: BLOB_BIND,
  metadata: BLOB_BIND,
};

const CHECKPOINT_CLOB_BINDS: Record<string, BindDefinition> = {
  ...CHECKPOINT_BINDS,
  checkpoint: { type: oracledb.CLOB },
  metadata: { type: oracledb.CLOB },
};

const CHECKPOINT_BLOB_BINDS: Record<string, BindDefinition> = {
  thread_id: STRING_512,
  checkpoint_ns: STRING_512,
  channel: STRING_512,
  version: STRING_512,
  type: STRING_255,
  blob: BLOB_BIND,
};

const CHECKPOINT_WRITE_BINDS: Record<string, BindDefinition> = {
  thread_id: STRING_512,
  checkpoint_ns: STRING_512,
  checkpoint_id: STRING_512,
  task_id: STRING_512,
  idx: NUMBER_BIND,
  channel: STRING_512,
  type: STRING_255,
  blob: BLOB_BIND,
};

function isConnection(value: unknown): value is OracleConnectionLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof (value as OracleConnectionLike).execute === "function"
  );
}

function rowValue<T>(row: OracleRow, key: string): T {
  return (row[key] ?? row[key.toUpperCase()]) as T;
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

function validateByteLength(
  label: string,
  value: string | null | undefined,
  maxBytes: number
): void {
  if (value === null || value === undefined) return;
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > maxBytes) {
    throw new Error(
      `Oracle checkpoint ${label} exceeds ${maxBytes} bytes after encoding. Received ${byteLength} bytes.`
    );
  }
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
  validateByteLength("thread_id", threadId, CHECKPOINT_KEY_MAX_BYTES);
  validateByteLength(
    "checkpoint_ns",
    encodedCheckpointNs,
    CHECKPOINT_KEY_MAX_BYTES
  );
  validateByteLength("checkpoint_id", checkpointId, CHECKPOINT_KEY_MAX_BYTES);
  validateByteLength(
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
    validateByteLength("thread_id", threadId, CHECKPOINT_KEY_MAX_BYTES);
  }
  if (checkpointNs !== undefined && checkpointNs !== null) {
    validateByteLength(
      "checkpoint_ns",
      encodeCheckpointNamespace(checkpointNs),
      CHECKPOINT_KEY_MAX_BYTES
    );
  }
  validateByteLength("checkpoint_id", checkpointId, CHECKPOINT_KEY_MAX_BYTES);
  validateByteLength(
    "before.checkpoint_id",
    beforeCheckpointId,
    CHECKPOINT_KEY_MAX_BYTES
  );
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

/**
 * LangGraph checkpointer backed by Oracle Database.
 *
 * This MVP uses the package-local migration and SQL helpers, node-oracledb
 * bind parameters, and LangGraph serde for checkpoint values and writes.
 */
export class OracleCheckpointSaver extends BaseCheckpointSaver {
  private pool?: OraclePoolLike;

  private readonly ownsPool: boolean;

  private connection?: OracleConnectionLike;

  private readonly ownsConnection: boolean;

  private readonly connectionOptions?: OracleConnectionOptions;

  private readonly tablePrefix: string;

  private readonly sql: ReturnType<typeof getOracleSQLStatements>;

  private readonly setupSql: ReturnType<typeof getOracleSetupStatements>;

  private setupPromise?: Promise<void>;

  private checkpointStorageMode?: "blob" | "clob";

  private rawConnectionLock: Promise<void> = Promise.resolve();

  constructor(options: OracleCheckpointSaverOptions = {}) {
    super(options.serde);
    this.pool = options.pool;
    this.ownsPool = options.pool === undefined;
    if (isConnection(options.connection)) {
      this.connection = options.connection;
      this.ownsConnection = false;
    } else {
      this.connectionOptions = options.connection;
      this.ownsConnection = true;
    }
    this.tablePrefix = validateTablePrefix(options.tablePrefix);
    this.sql = getOracleSQLStatements(this.tablePrefix);
    this.setupSql = getOracleSetupStatements(this.tablePrefix);
  }

  async setup(): Promise<void> {
    this.setupPromise ??= this.withTransaction(async (connection) => {
      const migrations = getMigrations(this.tablePrefix);
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

      for (
        let version = currentVersion + 1;
        version < migrations.length;
        version += 1
      ) {
        try {
          await connection.execute(migrations[version]);
        } catch (error) {
          if (!isOracleError(error, 955) && !isOracleError(error, 1430)) {
            throw error;
          }
        }

        try {
          await connection.execute(this.setupSql.INSERT_MIGRATION_SQL, {
            version,
          });
        } catch (error) {
          if (!isOracleError(error, 1)) throw error;
        }
      }

      this.checkpointStorageMode =
        await this.detectCheckpointStorageMode(connection);
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
    if (this.pool?.close && this.ownsPool) {
      await this.pool.close(0);
    }
    this.pool = undefined;
    this.setupPromise = undefined;
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
      this.tablePrefix
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
    await this.setup();
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
        limit: options?.filter ? undefined : options?.limit,
      },
      this.tablePrefix
    );

    const rows = await this.selectCheckpointRows(query.sql, query.binds);
    let yielded = 0;
    const limit =
      options?.limit !== undefined
        ? Number.parseInt(options.limit.toString(), 10)
        : undefined;
    if (limit !== undefined && limit <= 0) return;

    for (const row of rows) {
      const tuple = await this.rowToTuple(row);
      if (!this.metadataMatches(tuple.metadata, options?.filter)) continue;
      yield tuple;
      yielded += 1;
      if (limit !== undefined && yielded >= limit) break;
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
    const [checkpointType, checkpointBytes] =
      await this.dumpCheckpoint(checkpoint);
    const [metadataType, metadataBytes] = await this.dumpValue(metadata);
    validateByteLength(
      "checkpoint serializer type",
      checkpointType,
      CHECKPOINT_TYPE_MAX_BYTES
    );
    validateByteLength(
      "metadata serializer type",
      metadataType,
      CHECKPOINT_TYPE_MAX_BYTES
    );
    const blobRows = await this.dumpBlobs(
      threadId,
      checkpointNs,
      checkpoint.channel_values,
      newVersions
    );
    await this.setup();
    const useClobStorage = this.checkpointStorageMode === "clob";

    await this.withTransaction(async (connection) => {
      for (const row of blobRows) {
        await this.executeWithDuplicateRetry(
          connection,
          this.sql.UPSERT_CHECKPOINT_BLOBS_SQL,
          row,
          { bindDefs: CHECKPOINT_BLOB_BINDS }
        );
      }

      await this.executeWithDuplicateRetry(
        connection,
        this.sql.UPSERT_CHECKPOINTS_SQL,
        {
          thread_id: threadId,
          checkpoint_ns: encodedCheckpointNs,
          checkpoint_id: checkpoint.id,
          parent_checkpoint_id: parentCheckpointId,
          type: checkpointType,
          metadata_type: metadataType,
          checkpoint: useClobStorage
            ? new TextDecoder().decode(checkpointBytes)
            : checkpointBytes,
          metadata: useClobStorage
            ? new TextDecoder().decode(metadataBytes)
            : metadataBytes,
        },
        {
          bindDefs: useClobStorage ? CHECKPOINT_CLOB_BINDS : CHECKPOINT_BINDS,
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
    taskId: string
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
    validateByteLength("task_id", taskId, CHECKPOINT_KEY_MAX_BYTES);
    const query = writes.every(([channel]) => channel in WRITES_IDX_MAP)
      ? this.sql.UPSERT_CHECKPOINT_WRITES_SQL
      : this.sql.INSERT_CHECKPOINT_WRITES_SQL;
    const rows = await this.dumpWrites(
      threadId,
      checkpointNs,
      checkpointId,
      taskId,
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
            await connection.execute(query, row, {
              bindDefs: CHECKPOINT_WRITE_BINDS,
            });
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
    validateByteLength("thread_id", threadId, CHECKPOINT_KEY_MAX_BYTES);
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

    this.pool = (await oracledb.createPool(
      this.connectionOptions ?? {}
    )) as OraclePoolLike;
    return {
      connection: await this.pool.getConnection(),
      shouldClose: true,
    };
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
    options?: Record<string, unknown>
  ): Promise<OracleExecuteResult<OracleRow>> {
    try {
      return await connection.execute(sql, binds, options);
    } catch (error) {
      if (!isOracleError(error, 1)) throw error;
      return connection.execute(sql, binds, options);
    }
  }

  private async selectCheckpointRows(
    sql: string,
    binds: OracleBindParams
  ): Promise<OracleRow[]> {
    return this.withConnection(async (connection) => {
      const result = await connection.execute<OracleRow>(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        fetchInfo: {
          CHECKPOINT: {
            type:
              this.checkpointStorageMode === "clob"
                ? oracledb.STRING
                : oracledb.BUFFER,
          },
          METADATA: {
            type:
              this.checkpointStorageMode === "clob"
                ? oracledb.STRING
                : oracledb.BUFFER,
          },
        },
      });
      return result.rows ?? [];
    });
  }

  private async detectCheckpointStorageMode(
    connection: OracleConnectionLike
  ): Promise<"blob" | "clob"> {
    const result = await connection.execute<OracleRow>(
      `SELECT data_type
FROM user_tab_columns
WHERE table_name = UPPER(:table_name)
  AND column_name = 'CHECKPOINT'`,
      { table_name: `${this.tablePrefix}CHECKPOINTS` },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const [row] = result.rows ?? [];
    const dataType = row
      ? String(rowValue<string>(row, "data_type")).toUpperCase()
      : "BLOB";
    return dataType === "CLOB" ? "clob" : "blob";
  }

  private async loadCheckpoint(row: OracleRow): Promise<Checkpoint> {
    const type = rowValue<string | null | undefined>(row, "type") ?? "json";
    const checkpoint = (await this.serde.loadsTyped(
      type,
      await valueToUint8Array(rowValue(row, "checkpoint"))
    )) as Omit<Checkpoint, "channel_values">;

    const blobs = await this.selectChannelValueRows(
      rowValue(row, "thread_id"),
      rowValue(row, "checkpoint_ns"),
      checkpoint
    );
    return {
      ...checkpoint,
      channel_values: await this.loadBlobs(blobs),
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
    return this.serde.loadsTyped(
      rowValue<string | null | undefined>(row, "metadata_type") ??
        rowValue<string | null | undefined>(row, "type") ??
        "json",
      await valueToUint8Array(rowValue(row, "metadata"))
    ) as Promise<CheckpointMetadata>;
  }

  private async loadBlobs(rows: OracleRow[]): Promise<Record<string, unknown>> {
    const entries = await Promise.all(
      rows
        .filter((row) => rowValue<string>(row, "type") !== "empty")
        .map(async (row) => [
          rowValue<string>(row, "channel"),
          await this.serde.loadsTyped(
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
            await this.serde.loadsTyped(
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
        getPendingSendsParams(threadId, checkpointNs, [parentCheckpointId]),
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
        this.serde.loadsTyped(
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

  private async dumpValue(value: unknown): Promise<SerializedBytes> {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    return [type, Buffer.from(bytes)];
  }

  private async dumpCheckpoint(
    checkpoint: Checkpoint
  ): Promise<SerializedBytes> {
    const serialized: Partial<Checkpoint> = copyCheckpoint(checkpoint);
    delete serialized.channel_values;
    return this.dumpValue(serialized);
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
        validateByteLength("channel", channel, CHECKPOINT_KEY_MAX_BYTES);
        validateByteLength(
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
        validateByteLength(
          "channel serializer type",
          type,
          CHECKPOINT_TYPE_MAX_BYTES
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
        validateByteLength("task_id", taskId, CHECKPOINT_KEY_MAX_BYTES);
        validateByteLength("write channel", channel, CHECKPOINT_KEY_MAX_BYTES);
        const [type, blob] = await this.serde.dumpsTyped(value);
        validateByteLength(
          "write serializer type",
          type,
          CHECKPOINT_TYPE_MAX_BYTES
        );
        return {
          thread_id: threadId,
          checkpoint_ns: encodedCheckpointNs,
          checkpoint_id: checkpointId,
          task_id: taskId,
          idx: WRITES_IDX_MAP[channel] ?? idx,
          channel,
          type,
          blob: Buffer.from(blob),
        };
      })
    );
  }

  private metadataMatches(
    metadata: CheckpointMetadata | undefined,
    filter: CheckpointListOptions["filter"] | undefined
  ): boolean {
    if (!filter || Object.keys(filter).length === 0) return true;
    if (!metadata) return false;
    return Object.entries(filter).every(([key, value]) => {
      return jsonContains((metadata as Record<string, unknown>)[key], value);
    });
  }
}

function jsonContains(actual: unknown, expected: unknown): boolean {
  if (expected === actual) return true;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((expectedItem) =>
      actual.some((actualItem) => jsonContains(actualItem, expectedItem))
    );
  }

  if (
    typeof expected === "object" &&
    expected !== null &&
    !Array.isArray(expected)
  ) {
    if (
      typeof actual !== "object" ||
      actual === null ||
      Array.isArray(actual)
    ) {
      return false;
    }

    return Object.entries(expected).every(([key, value]) =>
      jsonContains((actual as Record<string, unknown>)[key], value)
    );
  }

  return false;
}
