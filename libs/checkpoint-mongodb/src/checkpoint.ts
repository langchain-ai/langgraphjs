import { type MongoClient, type Db as MongoDatabase } from "mongodb";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
  CheckpointPendingWrite,
  WRITES_IDX_MAP,
} from "@langchain/langgraph-checkpoint";

export type MongoDBSaverParams = {
  client: MongoClient;
  dbName?: string;
  checkpointCollectionName?: string;
  checkpointWritesCollectionName?: string;
  /**
   * When true, writes an `upserted_at` BSON date to documents on every upsert.
   * Useful for MongoDB TTL indexes, auditing, or debugging.
   */
  enableTimestamps?: boolean;
  /**
   * Time-to-live in seconds for checkpoint documents. When set, an
   * `upserted_at` timestamp is written on every upsert (implies
   * `enableTimestamps`) and {@link MongoDBSaver.setup} creates MongoDB TTL
   * indexes so documents expire after the configured period of inactivity.
   */
  ttl?: number;
};

function getStringConfigValue(
  name: string,
  value: unknown,
  { required = false }: { required?: boolean } = {}
): string | undefined {
  if (value === undefined) {
    if (required) {
      throw new Error(`Invalid configurable.${name}: expected a string`);
    }
    return undefined;
  }

  if (value === null || typeof value !== "string") {
    throw new Error(`Invalid configurable.${name}: expected a string`);
  }

  return value;
}

/**
 * A LangGraph checkpoint saver backed by a MongoDB database.
 *
 * NOTE: you need to call .setup() the first time you're using your checkpointer.
 *
 * @example
 * ```typescript
 * const checkpointer = new MongoDBSaver({ client });
 * await checkpointer.setup();
 * ```
 */
export class MongoDBSaver extends BaseCheckpointSaver {
  protected client: MongoClient;

  protected db: MongoDatabase;

  checkpointCollectionName = "checkpoints";

  checkpointWritesCollectionName = "checkpoint_writes";

  protected enableTimestamps: boolean;

  protected ttl?: number;

  private get timestampOp() {
    return this.enableTimestamps
      ? ({ $currentDate: { upserted_at: true } } as const)
      : {};
  }

  constructor(
    {
      client,
      dbName,
      checkpointCollectionName,
      checkpointWritesCollectionName,
      enableTimestamps,
      ttl,
    }: MongoDBSaverParams,
    serde?: SerializerProtocol
  ) {
    super(serde);
    this.client = client;
    this.client.appendMetadata({
      name: "langgraphjs_checkpoint_saver",
    });
    this.db = this.client.db(dbName);
    this.checkpointCollectionName =
      checkpointCollectionName ?? this.checkpointCollectionName;
    this.checkpointWritesCollectionName =
      checkpointWritesCollectionName ?? this.checkpointWritesCollectionName;
    this.ttl = ttl;
    // TTL expiry relies on the `upserted_at` timestamp, so configuring a `ttl`
    // forces timestamps on (otherwise the TTL index would never match any
    // document and nothing would ever expire).
    this.enableTimestamps = (enableTimestamps ?? false) || ttl != null;
  }

  /**
   * Creates the indexes required by the checkpoint saver.
   *
   * Always creates compound indexes on the `checkpoints` and
   * `checkpoint_writes` collections matching the query and upsert patterns so
   * that lookups don't degrade into full collection scans as the collections
   * grow. When a `ttl` is configured, additionally creates MongoDB TTL indexes
   * on `upserted_at` so documents expire after the configured period of
   * inactivity.
   *
   * This method is idempotent and safe to call on every application start (and
   * concurrently). It returns an array of errors (empty if successful) so the
   * caller can decide how to handle failures.
   */
  async setup(): Promise<Error[]> {
    const operations: Promise<unknown>[] = [
      this.db
        .collection(this.checkpointCollectionName)
        .createIndex(
          { thread_id: 1, checkpoint_ns: 1, checkpoint_id: -1 },
          { name: "thread_ns_checkpoint_idx" }
        ),
      this.db.collection(this.checkpointWritesCollectionName).createIndex(
        {
          thread_id: 1,
          checkpoint_ns: 1,
          checkpoint_id: 1,
          task_id: 1,
          idx: 1,
        },
        { name: "thread_ns_checkpoint_task_idx" }
      ),
    ];

    if (this.ttl != null) {
      const ttlIndex = { upserted_at: 1 };
      const options = { expireAfterSeconds: this.ttl };
      operations.push(
        this.db
          .collection(this.checkpointCollectionName)
          .createIndex(ttlIndex, options),
        this.db
          .collection(this.checkpointWritesCollectionName)
          .createIndex(ttlIndex, options)
      );
    }

    const results = await Promise.allSettled(operations);
    return results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason as Error);
  }

  /**
   * Retrieves a checkpoint from the MongoDB database based on the
   * provided config. If the config contains a "checkpoint_id" key, the checkpoint with
   * the matching thread ID and checkpoint ID is retrieved. Otherwise, the latest checkpoint
   * for the given thread ID is retrieved.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const thread_id = getStringConfigValue(
      "thread_id",
      config.configurable?.thread_id
    );
    if (thread_id === undefined) {
      return undefined;
    }
    const checkpoint_ns =
      getStringConfigValue(
        "checkpoint_ns",
        config.configurable?.checkpoint_ns
      ) ?? "";
    const checkpoint_id = getStringConfigValue(
      "checkpoint_id",
      config.configurable?.checkpoint_id
    );

    let query;
    if (checkpoint_id) {
      query = {
        thread_id,
        checkpoint_ns,
        checkpoint_id,
      };
    } else {
      query = { thread_id, checkpoint_ns };
    }
    const result = await this.db
      .collection(this.checkpointCollectionName)
      .find(query)
      .sort("checkpoint_id", -1)
      .limit(1)
      .toArray();
    if (result.length === 0) {
      return undefined;
    }
    const doc = result[0];
    const configurableValues = {
      thread_id,
      checkpoint_ns,
      checkpoint_id: doc.checkpoint_id,
    };
    const checkpoint = (await this.serde.loadsTyped(
      doc.type,
      doc.checkpoint.value("utf8")
    )) as Checkpoint;
    const serializedWrites = await this.db
      .collection(this.checkpointWritesCollectionName)
      .find(configurableValues)
      .toArray();
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      serializedWrites.map(async (serializedWrite) => {
        return [
          serializedWrite.task_id,
          serializedWrite.channel,
          await this.serde.loadsTyped(
            serializedWrite.type,
            serializedWrite.value.value("utf8")
          ),
        ] as CheckpointPendingWrite;
      })
    );
    return {
      config: { configurable: configurableValues },
      checkpoint,
      pendingWrites,
      metadata: (await this.serde.loadsTyped(
        doc.type,
        doc.metadata.value("utf8")
      )) as CheckpointMetadata,
      parentConfig:
        doc.parent_checkpoint_id != null
          ? {
              configurable: {
                thread_id,
                checkpoint_ns,
                checkpoint_id: doc.parent_checkpoint_id,
              },
            }
          : undefined,
    };
  }

  /**
   * Retrieve a list of checkpoint tuples from the MongoDB database based
   * on the provided config. The checkpoints are ordered by checkpoint ID
   * in descending order (newest first).
   */
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    const query: Record<string, unknown> = {};
    const thread_id = getStringConfigValue(
      "thread_id",
      config.configurable?.thread_id
    );
    const checkpoint_ns = getStringConfigValue(
      "checkpoint_ns",
      config.configurable?.checkpoint_ns
    );

    if (thread_id) {
      query.thread_id = thread_id;
    }
    if (checkpoint_ns !== undefined) {
      query.checkpoint_ns = checkpoint_ns;
    }

    if (filter) {
      Object.entries(filter).forEach(([key, value]) => {
        // Prevent MongoDB operator injection - only allow primitive values
        if (value !== null && typeof value === "object") {
          throw new Error(
            `Invalid filter value for key "${key}": filter values must be primitives (string, number, boolean, or null)`
          );
        }
        query[`metadata_search.${key}`] = value;
      });
    }

    if (before?.configurable?.checkpoint_id !== undefined) {
      const before_checkpoint_id = getStringConfigValue(
        "checkpoint_id",
        before.configurable?.checkpoint_id
      );
      query.checkpoint_id = { $lt: before_checkpoint_id };
    }

    let result = this.db
      .collection(this.checkpointCollectionName)
      .find(query)
      .sort("checkpoint_id", -1);

    if (limit !== undefined) {
      result = result.limit(limit);
    }

    for await (const doc of result) {
      const checkpoint = (await this.serde.loadsTyped(
        doc.type,
        doc.checkpoint.value("utf8")
      )) as Checkpoint;
      const metadata = (await this.serde.loadsTyped(
        doc.type,
        doc.metadata.value("utf8")
      )) as CheckpointMetadata;

      // Query pending writes for this checkpoint, matching getTuple() behavior
      const serializedWrites = await this.db
        .collection(this.checkpointWritesCollectionName)
        .find({
          thread_id: doc.thread_id,
          checkpoint_ns: doc.checkpoint_ns,
          checkpoint_id: doc.checkpoint_id,
        })
        .toArray();
      const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
        serializedWrites.map(async (serializedWrite) => {
          return [
            serializedWrite.task_id,
            serializedWrite.channel,
            await this.serde.loadsTyped(
              serializedWrite.type,
              serializedWrite.value.value("utf8")
            ),
          ] as CheckpointPendingWrite;
        })
      );

      yield {
        config: {
          configurable: {
            thread_id: doc.thread_id,
            checkpoint_ns: doc.checkpoint_ns,
            checkpoint_id: doc.checkpoint_id,
          },
        },
        checkpoint,
        pendingWrites,
        metadata,
        parentConfig: doc.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: doc.thread_id,
                checkpoint_ns: doc.checkpoint_ns,
                checkpoint_id: doc.parent_checkpoint_id,
              },
            }
          : undefined,
      };
    }
  }

  /**
   * Saves a checkpoint to the MongoDB database. The checkpoint is associated
   * with the provided config and its parent config (if any).
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const thread_id = getStringConfigValue(
      "thread_id",
      config.configurable?.thread_id,
      { required: true }
    );
    const checkpoint_ns =
      getStringConfigValue(
        "checkpoint_ns",
        config.configurable?.checkpoint_ns
      ) ?? "";
    const parent_checkpoint_id = getStringConfigValue(
      "checkpoint_id",
      config.configurable?.checkpoint_id
    );
    const checkpoint_id = checkpoint.id;

    const [
      [checkpointType, serializedCheckpoint],
      [metadataType, serializedMetadata],
    ] = await Promise.all([
      this.serde.dumpsTyped(checkpoint),
      this.serde.dumpsTyped(metadata),
    ]);

    if (checkpointType !== metadataType) {
      throw new Error("Mismatched checkpoint and metadata types.");
    }
    const doc = {
      parent_checkpoint_id,
      type: checkpointType,
      checkpoint: serializedCheckpoint,
      metadata: serializedMetadata,
      metadata_search: metadata,
    };
    const upsertQuery = {
      thread_id,
      checkpoint_ns,
      checkpoint_id,
    };
    await this.db
      .collection(this.checkpointCollectionName)
      .updateOne(
        upsertQuery,
        { $set: doc, ...this.timestampOp },
        { upsert: true }
      );

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id,
      },
    };
  }

  /**
   * Saves intermediate writes associated with a checkpoint to the MongoDB database.
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const thread_id = getStringConfigValue(
      "thread_id",
      config.configurable?.thread_id,
      { required: true }
    );
    const checkpoint_ns = getStringConfigValue(
      "checkpoint_ns",
      config.configurable?.checkpoint_ns,
      { required: true }
    );
    const checkpoint_id = getStringConfigValue(
      "checkpoint_id",
      config.configurable?.checkpoint_id,
      { required: true }
    );

    // Conflict resolution matches the Python MongoDB checkpointer and the
    // langgraph-checkpoint contract (BaseCheckpointSaver.put_writes):
    //   - When every write targets a special channel (ERROR / SCHEDULED /
    //     INTERRUPT / RESUME, each pinned to a negative `idx` by
    //     WRITES_IDX_MAP), we $set so e.g. INTERRUPT can be overwritten on
    //     RESUME.
    //   - Otherwise we $setOnInsert so a regular write from one task can
    //     never clobber a regular write that another concurrent task already
    //     stored at the same (task_id, idx).
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);

    const operations = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const upsertQuery = {
          thread_id,
          checkpoint_ns,
          checkpoint_id,
          task_id: taskId,
          // Special channels are stored at fixed negative indices so they
          // never collide with regular per-step writes (whose `idx` is the
          // ordinal within `writes`).
          idx: WRITES_IDX_MAP[channel] ?? idx,
        };

        const [type, serializedValue] = await this.serde.dumpsTyped(value);
        const fields = { channel, type, value: serializedValue };

        return {
          updateOne: {
            filter: upsertQuery,
            update: allSpecial
              ? { $set: fields, ...this.timestampOp }
              : {
                  // Insert-or-ignore: the row's channel/value AND its
                  // upserted_at timestamp must only be written on first insert
                  // so a no-op update against a peer task's existing row
                  // doesn't bump that row's "last modified" stamp.
                  $setOnInsert: this.enableTimestamps
                    ? { ...fields, upserted_at: new Date() }
                    : fields,
                },
            upsert: true,
          },
        };
      })
    );

    // The MongoDB driver rejects `bulkWrite([])` with "Invalid BulkOperation,
    // Batch cannot be empty". `writes` can be empty in human-in-the-loop /
    // `interrupt()` flows, so skip the call when there is nothing to persist.
    if (operations.length > 0) {
      await this.db
        .collection(this.checkpointWritesCollectionName)
        .bulkWrite(operations);
    }
  }

  async deleteThread(threadId: string) {
    if (typeof threadId !== "string") {
      throw new Error("Invalid threadId: expected a string");
    }

    await this.db
      .collection(this.checkpointCollectionName)
      .deleteMany({ thread_id: threadId });

    await this.db
      .collection(this.checkpointWritesCollectionName)
      .deleteMany({ thread_id: threadId });
  }
}
