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
} from "@langchain/langgraph-checkpoint";

export type MongoDBSaverParams = {
  client: MongoClient;
  dbName?: string;
  checkpointCollectionName?: string;
  checkpointWritesCollectionName?: string;
  ttl?: { expireAfterSeconds: number };
};

/**
 * A LangGraph checkpoint saver backed by a MongoDB database.
 */
export class MongoDBSaver extends BaseCheckpointSaver {
  protected client: MongoClient;

  protected db: MongoDatabase;

  protected ttl: { expireAfterSeconds: number } | undefined;

  protected isSetup: boolean;

  checkpointCollectionName = "checkpoints";

  checkpointWritesCollectionName = "checkpoint_writes";

  async setup(): Promise<void> {
    if (this.ttl != null) {
      const { expireAfterSeconds } = this.ttl;
      await Promise.all([
        this.db.createIndex(
          this.checkpointCollectionName,
          { _createdAtForTTL: 1 },
          { expireAfterSeconds }
        ),
        this.db.createIndex(
          this.checkpointWritesCollectionName,
          { _createdAtForTTL: 1 },
          { expireAfterSeconds }
        ),
      ]);
    }

    this.isSetup = true;
  }

  protected assertSetup() {
    // Skip setup check if TTL is not enabled
    if (this.ttl == null) return;

    if (!this.isSetup) {
      throw new Error(
        "MongoDBSaver is not initialized. Please call `MongoDBSaver.setup()` first before using the checkpointer."
      );
    }
  }

  constructor(
    {
      client,
      dbName,
      checkpointCollectionName,
      checkpointWritesCollectionName,
      ttl,
    }: MongoDBSaverParams,
    serde?: SerializerProtocol
  ) {
    super(serde);
    this.client = client;
    this.ttl = ttl;
    this.db = this.client.db(dbName);
    this.isSetup = false;

    this.checkpointCollectionName =
      checkpointCollectionName ?? this.checkpointCollectionName;
    this.checkpointWritesCollectionName =
      checkpointWritesCollectionName ?? this.checkpointWritesCollectionName;
  }

  /**
   * Retrieves a checkpoint from the MongoDB database based on the
   * provided config. If the config contains a "checkpoint_id" key, the checkpoint with
   * the matching thread ID and checkpoint ID is retrieved. Otherwise, the latest checkpoint
   * for the given thread ID is retrieved.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.assertSetup();

    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};
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
    this.assertSetup();

    const { limit, before, filter } = options ?? {};
    const query: Record<string, unknown> = {};

    if (config?.configurable?.thread_id) {
      query.thread_id = config.configurable.thread_id;
    }

    if (
      config?.configurable?.checkpoint_ns !== undefined &&
      config?.configurable?.checkpoint_ns !== null
    ) {
      query.checkpoint_ns = config.configurable.checkpoint_ns;
    }

    if (filter) {
      Object.entries(filter).forEach(([key, value]) => {
        query[`metadata.${key}`] = value;
      });
    }

    if (before) {
      query.checkpoint_id = { $lt: before.configurable?.checkpoint_id };
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

      yield {
        config: {
          configurable: {
            thread_id: doc.thread_id,
            checkpoint_ns: doc.checkpoint_ns,
            checkpoint_id: doc.checkpoint_id,
          },
        },
        checkpoint,
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
    this.assertSetup();

    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    const checkpoint_id = checkpoint.id;
    if (thread_id === undefined) {
      throw new Error(
        `The provided config must contain a configurable field with a "thread_id" field.`
      );
    }
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
      parent_checkpoint_id: config.configurable?.checkpoint_id,
      type: checkpointType,
      checkpoint: serializedCheckpoint,
      metadata: serializedMetadata,
      ...(this.ttl ? { _createdAtForTTL: new Date() } : {}),
    };
    const upsertQuery = {
      thread_id,
      checkpoint_ns,
      checkpoint_id,
    };
    await this.db
      .collection(this.checkpointCollectionName)
      .updateOne(upsertQuery, { $set: doc }, { upsert: true });

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
    this.assertSetup();

    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;
    const checkpoint_id = config.configurable?.checkpoint_id;
    if (
      thread_id === undefined ||
      checkpoint_ns === undefined ||
      checkpoint_id === undefined
    ) {
      throw new Error(
        `The provided config must contain a configurable field with "thread_id", "checkpoint_ns" and "checkpoint_id" fields.`
      );
    }

    const operations = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const upsertQuery = {
          thread_id,
          checkpoint_ns,
          checkpoint_id,
          task_id: taskId,
          idx,
        };

        const [type, serializedValue] = await this.serde.dumpsTyped(value);

        return {
          updateOne: {
            filter: upsertQuery,
            update: { $set: { channel, type, value: serializedValue } },
            upsert: true,
          },
        };
      })
    );

    await this.db
      .collection(this.checkpointWritesCollectionName)
      .bulkWrite(operations);
  }

  async deleteThread(threadId: string) {
    await this.db
      .collection(this.checkpointCollectionName)
      .deleteMany({ thread_id: threadId });

    await this.db
      .collection(this.checkpointWritesCollectionName)
      .deleteMany({ thread_id: threadId });
  }
}
