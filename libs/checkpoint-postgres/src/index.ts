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
} from "@langchain/langgraph-checkpoint";
import pg from "pg";

import { getMigrations } from "./migrations.js";
import {
  type SQL_STATEMENTS,
  getSQLStatements,
  getTablesWithSchema,
} from "./sql.js";

export interface PostgresSaverOptions {
  schema?: string;
}

interface DefaultPostgresSaverOptions extends PostgresSaverOptions {
  schema: "public" | string;
}

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
 *   },
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
  private pool: pg.Pool;
  private readonly options: DefaultPostgresSaverOptions = {
    schema: "public",
  };
  private readonly SQL_STATEMENTS: SQL_STATEMENTS;

  protected isSetup: boolean;

  constructor(
    pool: pg.Pool,
    serde?: SerializerProtocol,
    options?: PostgresSaverOptions
  ) {
    super(serde);
    this.pool = pool;
    this.isSetup = false;
    this.options = {
      ...this.options,
      ...options,
    };
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
   * const checkpointer = PostgresSaver.fromConnString(connString, );
   * await checkpointer.setup();
   */
  static fromConnString(
    connString: string,
    options: PostgresSaverOptions = {}
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
      try {
        const result = await client.query(
          `SELECT v FROM ${SCHEMA_TABLES.checkpoint_migrations} ORDER BY v DESC LIMIT 1`
        );
        if (result.rows.length > 0) {
          version = result.rows[0].v;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        // Assume table doesn't exist if there's an error
        if (
          error?.message.includes(
            `relation "${SCHEMA_TABLES.checkpoint_migrations}" does not exist`
          )
        ) {
          version = -1;
        } else {
          throw error;
        }
      }

      const MIGRATIONS = getMigrations(this.options.schema);
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
    channelValues: [Uint8Array, Uint8Array, Uint8Array][],
    pendingSends: [Uint8Array, Uint8Array][]
  ): Promise<Checkpoint> {
    return {
      ...checkpoint,
      pending_sends: await Promise.all(
        (pendingSends || []).map(([c, b]) =>
          this.serde.loadsTyped(c.toString(), b)
        )
      ),
      channel_values: await this._loadBlobs(channelValues),
    };
  }

  protected async _loadBlobs(
    blobValues: [Uint8Array, Uint8Array, Uint8Array][]
  ): Promise<Record<string, unknown>> {
    if (!blobValues || blobValues.length === 0) {
      return {};
    }
    const entries = await Promise.all(
      blobValues
        .filter(([, t]) => new TextDecoder().decode(t) !== "empty")
        .map(async ([k, t, v]) => [
          new TextDecoder().decode(k),
          await this.serde.loadsTyped(new TextDecoder().decode(t), v),
        ])
    );
    return Object.fromEntries(entries);
  }

  protected async _loadMetadata(metadata: Record<string, unknown>) {
    const [type, dumpedValue] = this.serde.dumpsTyped(metadata);
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

  protected _dumpBlobs(
    threadId: string,
    checkpointNs: string,
    values: Record<string, unknown>,
    versions: ChannelVersions
  ): [string, string, string, string, string, Uint8Array | undefined][] {
    if (Object.keys(versions).length === 0) {
      return [];
    }

    return Object.entries(versions).map(([k, ver]) => {
      const [type, value] =
        k in values ? this.serde.dumpsTyped(values[k]) : ["empty", null];
      return [
        threadId,
        checkpointNs,
        k,
        ver.toString(),
        type,
        value ? new Uint8Array(value) : undefined,
      ];
    });
  }

  protected _dumpCheckpoint(checkpoint: Checkpoint) {
    const serialized: Record<string, unknown> = {
      ...checkpoint,
      pending_sends: [],
    };
    if ("channel_values" in serialized) {
      delete serialized.channel_values;
    }
    return serialized;
  }

  protected _dumpMetadata(metadata: CheckpointMetadata) {
    const [, serializedMetadata] = this.serde.dumpsTyped(metadata);
    // We need to remove null characters before writing
    return JSON.parse(
      new TextDecoder().decode(serializedMetadata).replace(/\0/g, "")
    );
  }

  protected _dumpWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
    taskId: string,
    writes: [string, unknown][]
  ): [string, string, string, string, number, string, string, Uint8Array][] {
    return writes.map(([channel, value], idx) => {
      const [type, serializedValue] = this.serde.dumpsTyped(value);
      return [
        threadId,
        checkpointNs,
        checkpointId,
        taskId,
        WRITES_IDX_MAP[channel] !== undefined ? WRITES_IDX_MAP[channel] : idx,
        channel,
        type,
        new Uint8Array(serializedValue),
      ];
    });
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
      where = `WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3`;
      args = [thread_id, checkpoint_ns, checkpoint_id];
    } else {
      where = `WHERE thread_id = $1 AND checkpoint_ns = $2 ORDER BY checkpoint_id DESC LIMIT 1`;
      args = [thread_id, checkpoint_ns];
    }

    const result = await this.pool.query(
      this.SQL_STATEMENTS.SELECT_SQL + where,
      args
    );

    const [row] = result.rows;

    if (row === undefined) {
      return undefined;
    }

    const checkpoint = await this._loadCheckpoint(
      row.checkpoint,
      row.channel_values,
      row.pending_sends
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query += ` LIMIT ${parseInt(limit as any, 10)}`; // sanitize via parseInt, as limit could be an externally provided value
    }

    const result = await this.pool.query(query, args);
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
          value.channel_values,
          value.pending_sends
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
      const serializedBlobs = this._dumpBlobs(
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
        this._dumpMetadata(metadata),
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

    const dumpedWrites = this._dumpWrites(
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
}
