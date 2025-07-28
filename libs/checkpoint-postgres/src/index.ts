import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
  type ChannelVersions,
  WRITES_IDX_MAP,
  TASKS,
  maxChannelVersion,
} from "@langchain/langgraph-checkpoint";
import pg from "pg";

import { getMigrations } from "./migrations.js";
import {
  type SQL_STATEMENTS,
  type SQL_TYPES,
  getSQLStatements,
  getTablesWithSchema,
} from "./sql.js";

interface PostgresSaverOptions {
  schema: string;
}

const _defaultOptions: PostgresSaverOptions = {
  schema: "public",
};

const _ensureCompleteOptions = (
  options?: Partial<PostgresSaverOptions>
): PostgresSaverOptions => {
  return {
    ...options,
    schema: options?.schema ?? _defaultOptions.schema,
  };
};

const { Pool } = pg;

/**
 * LangGraph checkpointer that uses a Postgres instance as the backing store.
 * Uses the [node-postgres](https://node-postgres.com/) package internally
 * to connect to a Postgres instance.
 *
 * @example
 * ```
 * import { ChatOpenAI } from "@langchain/openai";
 * import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
 * import { createReactAgent } from "@langchain/langgraph/prebuilt";
 *
 * const checkpointer = PostgresSaver.fromConnString(
 *   "postgresql://user:password@localhost:5432/db",
 *   // optional configuration object
 *   {
 *     schema: "custom_schema" // defaults to "public"
 *   }
 * );
 *
 * // NOTE: you need to call .setup() the first time you're using your checkpointer
 * await checkpointer.setup();
 *
 * const graph = createReactAgent({
 *   tools: [getWeather],
 *   llm: new ChatOpenAI({
 *     model: "gpt-4o-mini",
 *   }),
 *   checkpointSaver: checkpointer,
 * });
 * const config = { configurable: { thread_id: "1" } };
 *
 * await graph.invoke({
 *   messages: [{
 *     role: "user",
 *     content: "what's the weather in sf"
 *   }],
 * }, config);
 * ```
 */
export class PostgresSaver extends BaseCheckpointSaver {
  private readonly pool: pg.Pool;

  private readonly options: PostgresSaverOptions;

  private readonly SQL_STATEMENTS: SQL_STATEMENTS;

  protected isSetup: boolean;

  constructor(
    pool: pg.Pool,
    serde?: SerializerProtocol,
    options?: Partial<PostgresSaverOptions>
  ) {
    super(serde);
    this.pool = pool;
    this.isSetup = false;
    this.options = _ensureCompleteOptions(options);
    this.SQL_STATEMENTS = getSQLStatements(this.options.schema);
  }

  /**
   * Creates a new instance of PostgresSaver from a connection string.
   *
   * @param {string} connString - The connection string to connect to the Postgres database.
   * @param {PostgresSaverOptions} [options] - Optional configuration object.
   * @returns {PostgresSaver} A new instance of PostgresSaver.
   *
   * @example
   * const connString = "postgresql://user:password@localhost:5432/db";
   * const checkpointer = PostgresSaver.fromConnString(connString, {
   *  schema: "custom_schema" // defaults to "public"
   * });
   * await checkpointer.setup();
   */
  static fromConnString(
    connString: string,
    options?: Partial<PostgresSaverOptions>
  ): PostgresSaver {
    const pool = new Pool({ connectionString: connString });
    return new PostgresSaver(pool, undefined, options);
  }

  /**
   * Set up the checkpoint database asynchronously.
   *
   * This method creates the necessary tables in the Postgres database if they don't
   * already exist and runs database migrations. It MUST be called directly by the user
   * the first time checkpointer is used.
   */
  async setup(): Promise<void> {
    const client = await this.pool.connect();
    const SCHEMA_TABLES = getTablesWithSchema(this.options.schema);
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.options.schema}`);
      let version = -1;
      const MIGRATIONS = getMigrations(this.options.schema);

      try {
        const result = await client.query(
          `SELECT v FROM ${SCHEMA_TABLES.checkpoint_migrations} ORDER BY v DESC LIMIT 1`
        );
        if (result.rows.length > 0) {
          version = result.rows[0].v;
        }
      } catch (error: unknown) {
        // Assume table doesn't exist if there's an error
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string" &&
          error.code === "42P01" // Postgres error code for undefined_table
        ) {
          version = -1;
        } else {
          throw error;
        }
      }

      for (let v = version + 1; v < MIGRATIONS.length; v += 1) {
        await client.query(MIGRATIONS[v]);
        await client.query(
          `INSERT INTO ${SCHEMA_TABLES.checkpoint_migrations} (v) VALUES ($1)`,
          [v]
        );
      }
    } finally {
      client.release();
    }
  }

  protected async _loadCheckpoint(
    checkpoint: Omit<Checkpoint, "pending_sends" | "channel_values">,
    channelValues: [Uint8Array, Uint8Array, Uint8Array][]
  ): Promise<Checkpoint> {
    return {
      ...checkpoint,
      channel_values: await this._loadBlobs(channelValues),
    };
  }

  protected async _loadBlobs(
    blobValues: [Uint8Array, Uint8Array, Uint8Array][]
  ): Promise<Record<string, unknown>> {
    if (!blobValues || blobValues.length === 0) {
      return {};
    }
    const textDecoder = new TextDecoder();
    const entries = await Promise.all(
      blobValues
        .filter(([, t]) => textDecoder.decode(t) !== "empty")
        .map(async ([k, t, v]) => [
          textDecoder.decode(k),
          await this.serde.loadsTyped(textDecoder.decode(t), v),
        ])
    );
    return Object.fromEntries(entries);
  }

  protected async _loadMetadata(metadata: Record<string, unknown>) {
    const [type, dumpedValue] = await this.serde.dumpsTyped(metadata);
    return this.serde.loadsTyped(type, dumpedValue);
  }

  protected async _loadWrites(
    writes: [Uint8Array, Uint8Array, Uint8Array, Uint8Array][]
  ): Promise<[string, string, unknown][]> {
    const decoder = new TextDecoder();
    return writes
      ? await Promise.all(
          writes.map(async ([tid, channel, t, v]) => [
            decoder.decode(tid),
            decoder.decode(channel),
            await this.serde.loadsTyped(decoder.decode(t), v),
          ])
        )
      : [];
  }

  protected async _dumpBlobs(
    threadId: string,
    checkpointNs: string,
    values: Record<string, unknown>,
    versions: ChannelVersions
  ): Promise<
    [string, string, string, string, string, Uint8Array | undefined][]
  > {
    if (Object.keys(versions).length === 0) {
      return [];
    }

    return Promise.all(
      Object.entries(versions).map(async ([k, ver]) => {
        const [type, value] =
          k in values
            ? await this.serde.dumpsTyped(values[k])
            : ["empty", null];
        return [
          threadId,
          checkpointNs,
          k,
          ver.toString(),
          type,
          value ? new Uint8Array(value) : undefined,
        ];
      })
    );
  }

  protected _dumpCheckpoint(checkpoint: Checkpoint) {
    const serialized: Record<string, unknown> = { ...checkpoint };
    if ("channel_values" in serialized) delete serialized.channel_values;
    return serialized;
  }

  protected async _dumpMetadata(metadata: CheckpointMetadata) {
    const [, serializedMetadata] = await this.serde.dumpsTyped(metadata);
    // We need to remove null characters before writing
    return JSON.parse(
      new TextDecoder().decode(serializedMetadata).replace(/\0/g, "")
    );
  }

  protected async _dumpWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
    taskId: string,
    writes: [string, unknown][]
  ): Promise<
    [string, string, string, string, number, string, string, Uint8Array][]
  > {
    return Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [type, serializedValue] = await this.serde.dumpsTyped(value);
        return [
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          WRITES_IDX_MAP[channel] ?? idx,
          channel,
          type,
          new Uint8Array(serializedValue),
        ];
      })
    );
  }

  /**
   * Return WHERE clause predicates for a given list() config, filter, cursor.
   *
   * This method returns a tuple of a string and a tuple of values. The string
   * is the parameterized WHERE clause predicate (including the WHERE keyword):
   * "WHERE column1 = $1 AND column2 IS $2". The list of values contains the
   * values for each of the corresponding parameters.
   */
  protected _searchWhere(
    config?: RunnableConfig,
    filter?: Record<string, unknown>,
    before?: RunnableConfig
  ): [string, unknown[]] {
    const wheres: string[] = [];
    const paramValues: unknown[] = [];

    // construct predicate for config filter
    if (config?.configurable?.thread_id) {
      wheres.push(`thread_id = $${paramValues.length + 1}`);
      paramValues.push(config.configurable.thread_id);
    }

    // strict checks for undefined/null because empty strings are falsy
    if (
      config?.configurable?.checkpoint_ns !== undefined &&
      config?.configurable?.checkpoint_ns !== null
    ) {
      wheres.push(`checkpoint_ns = $${paramValues.length + 1}`);
      paramValues.push(config.configurable.checkpoint_ns);
    }

    if (config?.configurable?.checkpoint_id) {
      wheres.push(`checkpoint_id = $${paramValues.length + 1}`);
      paramValues.push(config.configurable.checkpoint_id);
    }

    // construct predicate for metadata filter
    if (filter && Object.keys(filter).length > 0) {
      wheres.push(`metadata @> $${paramValues.length + 1}`);
      paramValues.push(JSON.stringify(filter));
    }

    // construct predicate for `before`
    if (before?.configurable?.checkpoint_id !== undefined) {
      wheres.push(`checkpoint_id < $${paramValues.length + 1}`);
      paramValues.push(before.configurable.checkpoint_id);
    }

    return [
      wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "",
      paramValues,
    ];
  }

  /**
   * Get a checkpoint tuple from the database.
   * This method retrieves a checkpoint tuple from the Postgres database
   * based on the provided config. If the config's configurable field contains
   * a "checkpoint_id" key, the checkpoint with the matching thread_id and
   * namespace is retrieved. Otherwise, the latest checkpoint for the given
   * thread_id is retrieved.
   * @param config The config to use for retrieving the checkpoint.
   * @returns The retrieved checkpoint tuple, or undefined.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};

    let args: unknown[];
    let where: string;
    if (checkpoint_id) {
      where =
        "WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3";
      args = [thread_id, checkpoint_ns, checkpoint_id];
    } else {
      where =
        "WHERE thread_id = $1 AND checkpoint_ns = $2 ORDER BY checkpoint_id DESC LIMIT 1";
      args = [thread_id, checkpoint_ns];
    }

    const result = await this.pool.query<SQL_TYPES["SELECT_SQL"]>(
      this.SQL_STATEMENTS.SELECT_SQL + where,
      args
    );

    const [row] = result.rows;
    if (row === undefined) return undefined;

    if (row.checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      const sendsResult = await this.pool.query<
        SQL_TYPES["SELECT_PENDING_SENDS_SQL"]
      >(this.SQL_STATEMENTS.SELECT_PENDING_SENDS_SQL, [
        thread_id,
        [row.parent_checkpoint_id],
      ]);

      const [sendsRow] = sendsResult.rows;
      if (sendsRow != null) {
        await this._migratePendingSends(sendsRow.pending_sends, row);
      }
    }

    const checkpoint = await this._loadCheckpoint(
      row.checkpoint,
      row.channel_values
    );

    const finalConfig = {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: row.checkpoint_id,
      },
    };
    const metadata = await this._loadMetadata(row.metadata);
    const parentConfig = row.parent_checkpoint_id
      ? {
          configurable: {
            thread_id,
            checkpoint_ns,
            checkpoint_id: row.parent_checkpoint_id,
          },
        }
      : undefined;
    const pendingWrites = await this._loadWrites(row.pending_writes);

    return {
      config: finalConfig,
      checkpoint,
      metadata,
      parentConfig,
      pendingWrites,
    };
  }

  /**
   * List checkpoints from the database.
   *
   * This method retrieves a list of checkpoint tuples from the Postgres database based
   * on the provided config. The checkpoints are ordered by checkpoint ID in descending order (newest first).
   */
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { filter, before, limit } = options ?? {};
    const [where, args] = this._searchWhere(config, filter, before);
    let query = `${this.SQL_STATEMENTS.SELECT_SQL}${where} ORDER BY checkpoint_id DESC`;
    if (limit !== undefined) {
      query += ` LIMIT ${Number.parseInt(limit.toString(), 10)}`; // sanitize via parseInt, as limit could be an externally provided value
    }

    const result = await this.pool.query<SQL_TYPES["SELECT_SQL"]>(query, args);
    const toMigrate = result.rows.filter(
      (row) => row.checkpoint.v < 4 && row.parent_checkpoint_id != null
    );

    if (toMigrate.length > 0) {
      const sendsResult = await this.pool.query<
        SQL_TYPES["SELECT_PENDING_SENDS_SQL"]
      >(this.SQL_STATEMENTS.SELECT_PENDING_SENDS_SQL, [
        toMigrate[0].thread_id,
        toMigrate.map((row) => row.parent_checkpoint_id),
      ]);

      const parentMap = toMigrate.reduce<
        Record<string, SQL_TYPES["SELECT_SQL"][]>
      >((acc, row) => {
        if (!row.parent_checkpoint_id) return acc;

        acc[row.parent_checkpoint_id] ??= [];
        acc[row.parent_checkpoint_id].push(row);
        return acc;
      }, {});

      // add to values
      for (const sendsRow of sendsResult.rows) {
        for (const row of parentMap[sendsRow.checkpoint_id]) {
          await this._migratePendingSends(sendsRow.pending_sends, row);
        }
      }
    }

    for (const value of result.rows) {
      yield {
        config: {
          configurable: {
            thread_id: value.thread_id,
            checkpoint_ns: value.checkpoint_ns,
            checkpoint_id: value.checkpoint_id,
          },
        },
        checkpoint: await this._loadCheckpoint(
          value.checkpoint,
          value.channel_values
        ),
        metadata: await this._loadMetadata(value.metadata),
        parentConfig: value.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: value.thread_id,
                checkpoint_ns: value.checkpoint_ns,
                checkpoint_id: value.parent_checkpoint_id,
              },
            }
          : undefined,
        pendingWrites: await this._loadWrites(value.pending_writes),
      };
    }
  }

  async _migratePendingSends(
    pendingSends: [Uint8Array, Uint8Array][],
    mutableRow: {
      channel_values: [Uint8Array, Uint8Array, Uint8Array][];
      checkpoint: Omit<Checkpoint, "pending_sends" | "channel_values">;
    }
  ) {
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();
    const row = mutableRow;

    const [enc, blob] = await this.serde.dumpsTyped(
      await Promise.all(
        pendingSends.map(([enc, blob]) =>
          this.serde.loadsTyped(textDecoder.decode(enc), blob)
        )
      )
    );

    row.channel_values ??= [];
    row.channel_values.push([
      textEncoder.encode(TASKS),
      textEncoder.encode(enc),
      blob,
    ]);

    // add to versions
    row.checkpoint.channel_versions[TASKS] =
      Object.keys(mutableRow.checkpoint.channel_versions).length > 0
        ? maxChannelVersion(
            ...Object.values(mutableRow.checkpoint.channel_versions)
          )
        : this.getNextVersion(undefined);
  }

  /**
   * Save a checkpoint to the database.
   *
   * This method saves a checkpoint to the Postgres database. The checkpoint is associated
   * with the provided config and its parent config (if any).
   * @param config
   * @param checkpoint
   * @param metadata
   * @returns
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    if (config.configurable === undefined) {
      throw new Error(`Missing "configurable" field in "config" param`);
    }
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable;

    const nextConfig = {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
    const client = await this.pool.connect();
    const serializedCheckpoint = this._dumpCheckpoint(checkpoint);
    try {
      await client.query("BEGIN");
      const serializedBlobs = await this._dumpBlobs(
        thread_id,
        checkpoint_ns,
        checkpoint.channel_values,
        newVersions
      );
      for (const serializedBlob of serializedBlobs) {
        await client.query(
          this.SQL_STATEMENTS.UPSERT_CHECKPOINT_BLOBS_SQL,
          serializedBlob
        );
      }
      await client.query(this.SQL_STATEMENTS.UPSERT_CHECKPOINTS_SQL, [
        thread_id,
        checkpoint_ns,
        checkpoint.id,
        checkpoint_id,
        serializedCheckpoint,
        await this._dumpMetadata(metadata),
      ]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return nextConfig;
  }

  /**
   * Store intermediate writes linked to a checkpoint.
   *
   * This method saves intermediate writes associated with a checkpoint to the Postgres database.
   * @param config Configuration of the related checkpoint.
   * @param writes List of writes to store.
   * @param taskId Identifier for the task creating the writes.
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const query = writes.every((w) => w[0] in WRITES_IDX_MAP)
      ? this.SQL_STATEMENTS.UPSERT_CHECKPOINT_WRITES_SQL
      : this.SQL_STATEMENTS.INSERT_CHECKPOINT_WRITES_SQL;

    const dumpedWrites = await this._dumpWrites(
      config.configurable?.thread_id,
      config.configurable?.checkpoint_ns,
      config.configurable?.checkpoint_id,
      taskId,
      writes
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for await (const dumpedWrite of dumpedWrites) {
        await client.query(query, dumpedWrite);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async end() {
    return this.pool.end();
  }

  async deleteThread(threadId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(this.SQL_STATEMENTS.DELETE_CHECKPOINT_BLOBS_SQL, [
        threadId,
      ]);
      await client.query(this.SQL_STATEMENTS.DELETE_CHECKPOINTS_SQL, [
        threadId,
      ]);
      await client.query(this.SQL_STATEMENTS.DELETE_CHECKPOINT_WRITES_SQL, [
        threadId,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
