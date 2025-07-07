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
} from "@langchain/langgraph-checkpoint";
import { QueryTypes, Sequelize } from "sequelize";
import { TextDecoder, TextEncoder } from "util";
import {
  _initializeModels,
  CheckpointBlob,
  CheckpointMigration,
  CheckpointModel,
  CheckpointWrite,
} from "./models.js";

/**
 * LangGraph checkpointer that uses a MySQL instance as the backing store.
 * Uses the [sequelize](https://sequelize.org/) package internally
 * to connect to a MySQL instance.
 *
 * @example
 * ```
 * import { ChatOpenAI } from "@langchain/openai";
 * import { MySQLSaver } from "@langchain/langgraph-checkpoint-mysql";
 * import { createReactAgent } from "@langchain/langgraph/prebuilt";
 * import { Sequelize } from "sequelize";
 *
 * const sequelize = new Sequelize({
 *   database: "langgraph_checkpoint",
 *   username: "root",
 *   password: "password",
 *   host: "localhost",
 *   port: 3306,
 *   dialect: "mysql",
 * });
 *
 * const checkpointer = new MySQLSaver(sequelize);
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
export class MySQLSaver extends BaseCheckpointSaver {
  private readonly sequelize: Sequelize;

  protected isSetup: boolean;

  constructor(sequelize: Sequelize, serde?: SerializerProtocol) {
    super(serde);

    this.sequelize = sequelize;

    this.isSetup = false;

    this._initializeModels();
  }

  /**
   * Creates a new instance of MySQLSaver from a connection string.
   *
   * @param {string} connString - The connection string to connect to the MySQL database.
   * @returns {MySQLSaver} A new instance of MySQLSaver.
   *
   * @example
   * const connString = "mysql://user:password@localhost:3306/db";
   * const checkpointer = MySQLSaver.fromConnString(connString);
   * await checkpointer.setup();
   */
  static fromConnString(connString: string): MySQLSaver {
    const sequelize = new Sequelize(connString);
    return new MySQLSaver(sequelize);
  }

  private _initializeModels() {
    _initializeModels(this.sequelize);
  }

  /**
   * Set up the checkpoint database asynchronously.
   *
   * This method creates the necessary tables in the MySQL database if they don't
   * already exist and runs database migrations. It MUST be called directly by the user
   * the first time checkpointer is used.
   */
  async setup(
    options: Partial<{ force: boolean }> = { force: false }
  ): Promise<void> {
    try {
      await this.sequelize.authenticate();
      console.log("✅ Mysql connected successfully");

      // Use force: true to force recreation of table structure, ensuring consistency with model definitions
      // Note: This will delete existing data, only for development environment
      await this.sequelize.sync({ force: options.force });
      console.log("✅ Models synced successfully");

      const latestMigration = await CheckpointMigration.findOne({
        order: [["v", "DESC"]],
      });

      console.log("ℹ️ latestMigration is: ", latestMigration?.v);

      // Migration logic can be added here if needed
      // Currently all table structures are in model definitions, so no additional migration is needed

      this.isSetup = true;

      console.log("✅ MySQLSaver setup successfully");
    } catch (error) {
      console.error("❌ MySQLSaver setup failed: ", error);
      throw new Error(`Failed to setup MySQL database: ${error}`);
    }
  }

  /**
   * Return WHERE clause predicates for a given list() config, filter, cursor.
   *
   * This method returns a tuple of a string and a tuple of values. The string
   * is the parameterized WHERE clause predicate (including the WHERE keyword):
   * "WHERE column1 = ? AND column2 IS ?". The list of values contains the
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
      wheres.push(`thread_id = ?`);
      paramValues.push(config.configurable.thread_id);
    }

    // strict checks for undefined/null because empty strings are falsy
    if (
      config?.configurable?.checkpoint_ns !== undefined &&
      config?.configurable?.checkpoint_ns !== null
    ) {
      wheres.push(`checkpoint_ns = ?`);
      paramValues.push(config.configurable.checkpoint_ns);
    }

    if (config?.configurable?.checkpoint_id) {
      wheres.push(`checkpoint_id = ?`);
      paramValues.push(config.configurable.checkpoint_id);
    }

    // construct predicate for metadata filter
    if (filter && Object.keys(filter).length > 0) {
      // MySQL 的 JSON_CONTAINS 需要检查每个键值对
      const filterConditions = Object.entries(filter).map(([key]) => {
        return `JSON_EXTRACT(metadata, '$.${key}') = ?`;
      });
      wheres.push(`(${filterConditions.join(" AND ")})`);
      paramValues.push(...Object.values(filter));
    }

    // construct predicate for `before`
    if (before?.configurable?.checkpoint_id !== undefined) {
      wheres.push(`checkpoint_id < ?`);
      paramValues.push(before.configurable.checkpoint_id);
    }

    return [
      wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "",
      paramValues,
    ];
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
      ? Promise.all(
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
    const metadataWithoutNull = JSON.parse(
      new TextDecoder().decode(serializedMetadata).replace(/\0/g, "")
    );
    return metadataWithoutNull;
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
        WRITES_IDX_MAP[channel] ?? idx,
        channel,
        type,
        new Uint8Array(serializedValue),
      ];
    });
  }

  /**
   * Get a checkpoint tuple from the database.
   * This method retrieves a checkpoint tuple from the MySQL database
   * based on the provided config. If the config's configurable field contains
   * a "checkpoint_id" key, the checkpoint with the matching thread_id and
   * namespace is retrieved. Otherwise, the latest checkpoint for the given
   * thread_id is retrieved.
   *
   * Optimized for MySQL 5.7+ InnoDB with improved query performance and compatibility.
   * @param config The config to use for retrieving the checkpoint.
   * @returns The retrieved checkpoint tuple, or undefined.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};

    if (!thread_id) {
      throw new Error("Missing required thread_id in config");
    }

    const checkpointQuery = checkpoint_id
      ? "SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? LIMIT 1"
      : "SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1";

    const checkpointArgs = checkpoint_id
      ? [thread_id, checkpoint_ns, checkpoint_id]
      : [thread_id, checkpoint_ns];

    const checkpointResults = await this.sequelize.query(checkpointQuery, {
      replacements: checkpointArgs,
      type: QueryTypes.SELECT,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const checkpointRow = (checkpointResults as any[])[0];

    if (!checkpointRow) {
      return undefined;
    }

    const [channelBlobs, pendingWrites, pendingSends] = await Promise.all([
      //  channel_values
      this._getChannelBlobs(
        checkpointRow.thread_id,
        checkpointRow.checkpoint_ns,
        checkpointRow.checkpoint
      ),
      //  pending_writes
      this._getPendingWrites(
        checkpointRow.thread_id,
        checkpointRow.checkpoint_ns,
        checkpointRow.checkpoint_id
      ),
      // get pending_sends (from parent checkpoint)
      checkpointRow.parent_checkpoint_id
        ? this._getPendingSends(
            checkpointRow.thread_id,
            checkpointRow.checkpoint_ns,
            checkpointRow.parent_checkpoint_id
          )
        : Promise.resolve([]),
    ]);

    // build final result
    const checkpoint = await this._loadCheckpoint(
      checkpointRow.checkpoint,
      channelBlobs,
      pendingSends
    );

    const finalConfig = {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpointRow.checkpoint_id,
      },
    };

    const metadata = await this._loadMetadata(checkpointRow.metadata);

    const parentConfig = checkpointRow.parent_checkpoint_id
      ? {
          configurable: {
            thread_id,
            checkpoint_ns,
            checkpoint_id: checkpointRow.parent_checkpoint_id,
          },
        }
      : undefined;

    const pendingWritesResult = await this._loadWrites(pendingWrites);

    return {
      config: finalConfig,
      checkpoint,
      metadata,
      parentConfig,
      pendingWrites: pendingWritesResult,
    };
  }

  /**
   * get channel blobs data
   * compatible with MySQL 5.7, use JSON_EXTRACT instead of JSON_TABLE
   */
  private async _getChannelBlobs(
    threadId: string,
    checkpointNs: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    checkpoint: any
  ): Promise<[Uint8Array, Uint8Array, Uint8Array][]> {
    try {
      // extract channel_versions from checkpoint
      const channelVersions = checkpoint?.channel_versions || {};
      const channels = Object.keys(channelVersions);

      if (channels.length === 0) {
        return [];
      }

      // Build IN query conditions
      const channelConditions = channels
        .map(() => {
          return `(channel = ? AND version = ?)`;
        })
        .join(" OR ");

      const query = `
        SELECT channel, type, \`blob\` 
        FROM checkpoint_blobs 
        WHERE thread_id = ? AND checkpoint_ns = ? AND (${channelConditions})
        AND type != 'empty' AND \`blob\` IS NOT NULL AND \`blob\` != ''
      `;

      const args = [threadId, checkpointNs];
      channels.forEach((channel) => {
        args.push(channel, channelVersions[channel]);
      });

      const results = await this.sequelize.query(query, {
        replacements: args,
        type: QueryTypes.SELECT,
      });

      const channelValues: [Uint8Array, Uint8Array, Uint8Array][] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const row of results as any[]) {
        if (row.channel && row.type && row.blob && row.blob.length > 0) {
          channelValues.push([
            new TextEncoder().encode(row.channel),
            new TextEncoder().encode(row.type),
            new Uint8Array(row.blob),
          ]);
        }
      }

      return channelValues;
    } catch (error) {
      console.error("Error fetching channel blobs:", error);
      return [];
    }
  }

  /**
   * get pending writes data
   */
  private async _getPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<[Uint8Array, Uint8Array, Uint8Array, Uint8Array][]> {
    try {
      const query = `
        SELECT task_id, channel, type, \`blob\` 
        FROM checkpoint_writes 
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
        AND \`blob\` IS NOT NULL AND \`blob\` != ''
        ORDER BY task_id ASC, idx ASC
      `;

      const results = await this.sequelize.query(query, {
        replacements: [threadId, checkpointNs, checkpointId],
        type: QueryTypes.SELECT,
      });

      const pendingWrites: [Uint8Array, Uint8Array, Uint8Array, Uint8Array][] =
        [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const row of results as any[]) {
        if (row.task_id && row.channel && row.blob && row.blob.length > 0) {
          pendingWrites.push([
            new TextEncoder().encode(row.task_id),
            new TextEncoder().encode(row.channel),
            new TextEncoder().encode(row.type || ""),
            new Uint8Array(row.blob),
          ]);
        }
      }

      return pendingWrites;
    } catch (error) {
      console.error("Error fetching pending writes:", error);
      return [];
    }
  }

  /**
   * get pending sends data
   */
  private async _getPendingSends(
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string
  ): Promise<[Uint8Array, Uint8Array][]> {
    try {
      const query = `
        SELECT type, \`blob\` 
        FROM checkpoint_writes 
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
        AND channel = ? AND \`blob\` IS NOT NULL AND \`blob\` != ''
        ORDER BY idx ASC
      `;

      const results = await this.sequelize.query(query, {
        replacements: [threadId, checkpointNs, parentCheckpointId, TASKS],
        type: QueryTypes.SELECT,
      });

      const pendingSends: [Uint8Array, Uint8Array][] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const row of results as any[]) {
        if (row.type && row.blob && row.blob.length > 0) {
          pendingSends.push([
            new TextEncoder().encode(row.type),
            new Uint8Array(row.blob),
          ]);
        }
      }

      return pendingSends;
    } catch (error) {
      console.error("Error fetching pending sends:", error);
      return [];
    }
  }

  /**
   * List checkpoints from the database.
   *
   * This method retrieves a list of checkpoint tuples from the MySQL database based
   * on the provided config. The checkpoints are ordered by checkpoint ID in descending order (newest first).
   */
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { filter, before, limit } = options ?? {};
    const [where, paramValues] = this._searchWhere(config, filter, before);

    // Build the query using raw SQL to avoid Sequelize literal issues
    let query = "SELECT * FROM checkpoints";
    if (where && where.trim() !== "") {
      query += ` ${where}`;
    }
    query += " ORDER BY checkpoint_id DESC";

    if (limit !== undefined) {
      query += ` LIMIT ${Number.parseInt(limit.toString(), 10)}`;
    }

    const checkpoints = (await this.sequelize.query(query, {
      replacements: paramValues,
      type: QueryTypes.SELECT,
    })) as Array<{
      thread_id: string;
      checkpoint_ns: string;
      checkpoint_id: string;
      parent_checkpoint_id?: string;
      checkpoint: Omit<Checkpoint, "pending_sends" | "channel_values">;
      metadata: Record<string, unknown>;
    }>;

    for (const checkpointRecord of checkpoints) {
      // Get channel_values
      const channelBlobs = await CheckpointBlob.findAll({
        where: {
          thread_id: checkpointRecord.thread_id,
          checkpoint_ns: checkpointRecord.checkpoint_ns,
        },
      });

      // Build channel_values array
      const channelValues: [Uint8Array, Uint8Array, Uint8Array][] = [];
      for (const blob of channelBlobs) {
        // Ensure all fields are not empty
        if (
          blob.channel &&
          blob.channel.trim() !== "" &&
          blob.type &&
          blob.type.trim() !== "" &&
          blob.blob &&
          blob.blob.length > 0
        ) {
          channelValues.push([
            new TextEncoder().encode(blob.channel),
            new TextEncoder().encode(blob.type),
            new Uint8Array(blob.blob),
          ]);
        }
      }

      // Get pending_writes
      const pendingWritesRecords = await CheckpointWrite.findAll({
        where: {
          thread_id: checkpointRecord.thread_id,
          checkpoint_ns: checkpointRecord.checkpoint_ns,
          checkpoint_id: checkpointRecord.checkpoint_id,
        },
        order: [
          ["task_id", "ASC"],
          ["idx", "ASC"],
        ],
      });

      const pendingWrites: [Uint8Array, Uint8Array, Uint8Array, Uint8Array][] =
        [];
      for (const write of pendingWritesRecords) {
        // Ensure all fields are not empty
        if (
          write.task_id &&
          write.task_id.trim() !== "" &&
          write.channel &&
          write.channel.trim() !== "" &&
          write.blob &&
          write.blob.length > 0
        ) {
          pendingWrites.push([
            new TextEncoder().encode(write.task_id),
            new TextEncoder().encode(write.channel),
            new TextEncoder().encode(write.type || ""),
            new Uint8Array(write.blob),
          ]);
        }
      }

      // Get pending_sends (from parent checkpoint)
      const pendingSends: [Uint8Array, Uint8Array][] = [];
      if (checkpointRecord.parent_checkpoint_id) {
        const parentWrites = await CheckpointWrite.findAll({
          where: {
            thread_id: checkpointRecord.thread_id,
            checkpoint_ns: checkpointRecord.checkpoint_ns,
            checkpoint_id: checkpointRecord.parent_checkpoint_id,
            channel: TASKS,
          },
          order: [["idx", "ASC"]],
        });

        for (const write of parentWrites) {
          // Ensure type is not empty
          if (
            write.type &&
            write.type.trim() !== "" &&
            write.blob &&
            write.blob.length > 0
          ) {
            pendingSends.push([
              new TextEncoder().encode(write.type),
              new Uint8Array(write.blob),
            ]);
          }
        }
      }

      yield {
        config: {
          configurable: {
            thread_id: checkpointRecord.thread_id,
            checkpoint_ns: checkpointRecord.checkpoint_ns,
            checkpoint_id: checkpointRecord.checkpoint_id,
          },
        },
        checkpoint: await this._loadCheckpoint(
          checkpointRecord.checkpoint,
          channelValues,
          pendingSends
        ),
        metadata: await this._loadMetadata(checkpointRecord.metadata),
        parentConfig: checkpointRecord.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: checkpointRecord.thread_id,
                checkpoint_ns: checkpointRecord.checkpoint_ns,
                checkpoint_id: checkpointRecord.parent_checkpoint_id,
              },
            }
          : undefined,
        pendingWrites: await this._loadWrites(pendingWrites),
      };
    }
  }

  /**
   * Save a checkpoint to the database.
   *
   * This method saves a checkpoint to the MySQL database. The checkpoint is associated
   * with the provided config and its parent config (if any).
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    if (config.configurable?.thread_id === undefined) {
      throw new Error(
        `Missing "thread_id" field in "config.configurable" param`
      );
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

    const transaction = await this.sequelize.transaction();

    try {
      const serializedBlobs = this._dumpBlobs(
        thread_id,
        checkpoint_ns,
        checkpoint.channel_values,
        newVersions
      );

      for (const [
        threadId,
        checkpointNs,
        channel,
        version,
        type,
        blob,
      ] of serializedBlobs) {
        await CheckpointBlob.upsert(
          {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            channel,
            version,
            type,
            blob: blob ? Buffer.from(blob) : null,
          },
          { transaction }
        );
      }

      // Save checkpoint
      await CheckpointModel.upsert(
        {
          thread_id,
          checkpoint_ns,
          checkpoint_id: checkpoint.id,
          parent_checkpoint_id: checkpoint_id,
          checkpoint: this._dumpCheckpoint(checkpoint),
          metadata: this._dumpMetadata(metadata),
        },
        { transaction }
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      console.error("❌ MySQLSaver put failed: ", error);
      throw error;
    }

    return nextConfig;
  }

  /**
   * Store intermediate writes linked to a checkpoint.
   *
   * This method saves intermediate writes associated with a checkpoint to the MySQL database.
   * @param config Configuration of the related checkpoint.
   * @param writes List of writes to store.
   * @param taskId Identifier for the task creating the writes.
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const dumpedWrites = this._dumpWrites(
      config.configurable?.thread_id,
      config.configurable?.checkpoint_ns,
      config.configurable?.checkpoint_id,
      taskId,
      writes
    );

    const transaction = await this.sequelize.transaction();

    try {
      for (const [
        threadId,
        checkpointNs,
        checkpointId,
        taskId,
        idx,
        channel,
        type,
        blob,
      ] of dumpedWrites) {
        await CheckpointWrite.upsert(
          {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: checkpointId,
            task_id: taskId,
            idx,
            channel,
            type,
            blob: Buffer.from(blob),
          },
          { transaction }
        );
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async end() {
    return this.sequelize.close();
  }
}
