import {
  Binary,
  WithId,
  type MongoClient,
  type Db as MongoDatabase,
} from "mongodb";
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
  validCheckpointMetadataKeys,
  ChannelVersions,
  copyCheckpoint,
  TASKS,
  SendProtocol,
} from "@langchain/langgraph-checkpoint";
import { applyMigrations, needsMigration } from "./migrations/index.js";

export * from "./migrations/index.js";

// increment this whenever the structure of the database changes in a way that would require a migration
const CURRENT_SCHEMA_VERSION = 1;

export type MongoDBSaverParams = {
  client: MongoClient;
  dbName?: string;
  checkpointCollectionName?: string;
  checkpointWritesCollectionName?: string;
  channelVersionsCollectionName?: string;
  schemaVersionCollectionName?: string;
};

interface CheckpointDoc {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string;
  checkpoint: Binary;
  metadata: CheckpointMetadata;
}

interface CheckpointWriteDoc {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: Binary;
}

interface ChannelVersionDoc {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  channel: string;
  version: string | number;
  type: string;
  value: Binary;
}

interface SchemaVersionDoc {
  version: number;
}

/**
 * A LangGraph checkpoint saver backed by a MongoDB database.
 */
export class MongoDBSaver extends BaseCheckpointSaver {
  protected client: MongoClient;

  protected db: MongoDatabase;

  private setupPromise: Promise<void> | undefined;

  checkpointCollectionName = "checkpoints";

  checkpointWritesCollectionName = "checkpoint_writes";

  channelVersionsCollectionName = "channel_versions";

  schemaVersionCollectionName = "schema_version";

  constructor(
    {
      client,
      dbName,
      checkpointCollectionName,
      checkpointWritesCollectionName,
      channelVersionsCollectionName,
      schemaVersionCollectionName,
    }: MongoDBSaverParams,
    serde?: SerializerProtocol
  ) {
    super(serde);
    this.client = client;
    this.db = this.client.db(dbName);
    this.checkpointCollectionName =
      checkpointCollectionName ?? this.checkpointCollectionName;
    this.checkpointWritesCollectionName =
      checkpointWritesCollectionName ?? this.checkpointWritesCollectionName;
    this.schemaVersionCollectionName =
      schemaVersionCollectionName ?? this.schemaVersionCollectionName;
    this.channelVersionsCollectionName =
      channelVersionsCollectionName ?? this.channelVersionsCollectionName;
  }

  /**
   * Runs async setup tasks if they haven't been run yet.
   */
  async setup(): Promise<void> {
    if (this.setupPromise) {
      return this.setupPromise;
    }
    this.setupPromise = this.initializeSchemaVersion();
    return this.setupPromise;
  }

  private async isDatabaseEmpty(): Promise<boolean> {
    const results = await Promise.all(
      [this.checkpointCollectionName, this.checkpointWritesCollectionName].map(
        async (collectionName) => {
          const collection = this.db.collection(collectionName);
          // set a limit of 1 to stop scanning if any documents are found
          const count = await collection.countDocuments({}, { limit: 1 });
          return count === 0;
        }
      )
    );

    return results.every((result) => result);
  }

  private async initializeSchemaVersion(): Promise<void> {
    const schemaVersionCollection = this.db.collection<SchemaVersionDoc>(
      this.schemaVersionCollectionName
    );

    // empty database, no migrations needed - just set the schema version and move on
    if (await this.isDatabaseEmpty()) {
      const versionDoc = await schemaVersionCollection.findOne({});
      if (!versionDoc) {
        await schemaVersionCollection.insertOne({
          version: CURRENT_SCHEMA_VERSION,
        });
      }
    } else {
      // non-empty database, check if migrations are needed
      const dbNeedsMigration = await needsMigration({
        client: this.client,
        dbName: this.db.databaseName,
        checkpointCollectionName: this.checkpointCollectionName,
        checkpointWritesCollectionName: this.checkpointWritesCollectionName,
        schemaVersionCollectionName: this.schemaVersionCollectionName,
        serializer: this.serde,
        currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      });

      if (dbNeedsMigration) {
        throw new Error(
          `Database needs migration. Call the migrate() method to migrate the database.`
        );
      }

      // always defined if dbNeedsMigration is false
      const versionDoc = (await schemaVersionCollection.findOne({}))!;

      if (versionDoc.version == null) {
        throw new Error(
          `BUG: Database schema version is corrupt. Manual intervention required.`
        );
      }

      if (versionDoc.version > CURRENT_SCHEMA_VERSION) {
        throw new Error(
          `Database created with newer version of checkpoint-mongodb. This version supports schema version ` +
            `${CURRENT_SCHEMA_VERSION} but the database was created with schema version ${versionDoc.version}.`
        );
      }

      if (versionDoc.version < CURRENT_SCHEMA_VERSION) {
        throw new Error(
          `BUG: Schema version ${versionDoc.version} is outdated (should be >= ${CURRENT_SCHEMA_VERSION}), but no ` +
            `migration wants to execute.`
        );
      }
    }
  }

  async migrate() {
    if (
      await needsMigration({
        client: this.client,
        dbName: this.db.databaseName,
        checkpointCollectionName: this.checkpointCollectionName,
        checkpointWritesCollectionName: this.checkpointWritesCollectionName,
        schemaVersionCollectionName: this.schemaVersionCollectionName,
        serializer: this.serde,
        currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      })
    ) {
      await applyMigrations({
        client: this.client,
        dbName: this.db.databaseName,
        checkpointCollectionName: this.checkpointCollectionName,
        checkpointWritesCollectionName: this.checkpointWritesCollectionName,
        schemaVersionCollectionName: this.schemaVersionCollectionName,
        serializer: this.serde,
        currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      });
    }
  }

  private async getChannelValues(
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string,
    channel_versions: ChannelVersions
  ): Promise<Record<string, unknown>> {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(channel_versions).map(async ([channel, version]) => {
          const doc = await this.db
            .collection<ChannelVersionDoc>(this.channelVersionsCollectionName)
            .findOne({
              thread_id,
              checkpoint_ns,
              checkpoint_id,
              channel,
              version,
            });
          if (!doc) {
            return [];
          }
          return [
            channel,
            await this.serde.loadsTyped(doc.type, doc.value.value()),
          ];
        })
      )
    );
  }

  private async getPendingSends(
    thread_id: string,
    checkpoint_ns: string,
    parent_checkpoint_id: string
  ): Promise<SendProtocol[]> {
    return Promise.all(
      (
        await this.db
          .collection<CheckpointWriteDoc>(this.checkpointWritesCollectionName)
          .find({
            thread_id,
            checkpoint_ns,
            checkpoint_id: parent_checkpoint_id,
            channel: TASKS,
          })
          .toArray()
      ).map((write) => {
        return this.serde.loadsTyped(
          write.type,
          write.value.value()
        ) as SendProtocol;
      })
    );
  }

  private async constructCheckpointTuple(
    thread_id: string,
    checkpoint_ns: string,
    doc: CheckpointDoc
  ): Promise<CheckpointTuple> {
    const configurableValues = {
      thread_id,
      checkpoint_ns,
      checkpoint_id: doc.checkpoint_id,
    };
    const checkpoint = (await this.serde.loadsTyped(
      doc.type,
      doc.checkpoint.value()
    )) as Checkpoint;

    checkpoint.pending_sends = doc.parent_checkpoint_id
      ? await this.getPendingSends(
          thread_id,
          checkpoint_ns,
          doc.parent_checkpoint_id
        )
      : [];

    checkpoint.channel_values = checkpoint.channel_values ?? {};
    checkpoint.channel_versions = checkpoint.channel_versions ?? {};

    // fetch channel values if they weren't stored with the rest of the checkpoint data
    if (
      Object.keys(checkpoint.channel_versions).length !==
      Object.keys(checkpoint.channel_values).length
    ) {
      checkpoint.channel_values =
        (await this.getChannelValues(
          thread_id,
          checkpoint_ns,
          doc.checkpoint_id,
          checkpoint.channel_versions
        )) ?? {};
    }

    const serializedWrites = await this.db
      .collection<CheckpointWriteDoc>(this.checkpointWritesCollectionName)
      .find(configurableValues)
      .toArray();

    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      serializedWrites.map(async (serializedWrite) => {
        return [
          serializedWrite.task_id,
          serializedWrite.channel,
          await this.serde.loadsTyped(
            serializedWrite.type,
            serializedWrite.value.value()
          ),
        ] as CheckpointPendingWrite;
      })
    );
    return {
      config: { configurable: configurableValues },
      checkpoint,
      pendingWrites,
      metadata: doc.metadata,
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
   * Retrieves a checkpoint from the MongoDB database based on the
   * provided config. If the config contains a "checkpoint_id" key, the checkpoint with
   * the matching thread ID and checkpoint ID is retrieved. Otherwise, the latest checkpoint
   * for the given thread ID is retrieved.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.setup();

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
      .collection<CheckpointDoc>(this.checkpointCollectionName)
      .find(query)
      .sort("checkpoint_id", -1)
      .limit(1)
      .toArray();
    if (result.length === 0) {
      return undefined;
    }
    const doc = result[0];
    return this.constructCheckpointTuple(thread_id, checkpoint_ns, doc);
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
    await this.setup();

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
      Object.entries(filter)
        .filter(
          ([key, value]) =>
            validCheckpointMetadataKeys.includes(
              key as keyof CheckpointMetadata
            ) && value !== undefined
        )
        .forEach(([key, value]) => {
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
      yield this.constructCheckpointTuple(
        doc.thread_id,
        doc.checkpoint_ns,
        doc as WithId<CheckpointDoc>
      );
    }
  }

  private async putChannelData(
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string,
    channel_values: Record<string, unknown>,
    newVersions: ChannelVersions
  ) {
    await Promise.all(
      Object.entries(newVersions).map(async ([channel, version]) => {
        const [type, value] = this.serde.dumpsTyped(channel_values[channel]);

        const doc: ChannelVersionDoc = {
          thread_id,
          checkpoint_ns,
          checkpoint_id,
          channel,
          version,
          type,
          value: new Binary(value),
        };

        const upsertQuery = {
          thread_id,
          checkpoint_ns,
          checkpoint_id,
          channel,
          version,
        };

        await this.db
          .collection(this.channelVersionsCollectionName)
          .updateOne(upsertQuery, { $set: doc }, { upsert: true });
      })
    );
  }

  /**
   * Saves a checkpoint to the MongoDB database. The checkpoint is associated
   * with the provided config and its parent config (if any).
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    await this.setup();

    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    const checkpoint_id = checkpoint.id;
    if (thread_id === undefined) {
      throw new Error(
        `The provided config must contain a configurable field with a "thread_id" field.`
      );
    }

    const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);
    delete preparedCheckpoint.pending_sends;
    delete preparedCheckpoint.channel_values;

    await this.putChannelData(
      thread_id,
      checkpoint_ns,
      checkpoint_id,
      checkpoint.channel_values,
      newVersions
    );

    const [checkpointType, serializedCheckpoint] =
      this.serde.dumpsTyped(preparedCheckpoint);
    const doc: CheckpointDoc = {
      thread_id,
      checkpoint_ns,
      checkpoint_id,
      parent_checkpoint_id: config.configurable?.checkpoint_id,
      type: checkpointType,
      checkpoint: new Binary(serializedCheckpoint),
      metadata,
    };
    const upsertQuery = {
      thread_id,
      checkpoint_ns,
      checkpoint_id,
    };
    await this.db
      .collection<CheckpointDoc>(this.checkpointCollectionName)
      .updateOne(
        upsertQuery,
        {
          $set: doc,
        },
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
    await this.setup();

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

    const operations = writes.map(([channel, value], idx) => {
      const upsertQuery = {
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        task_id: taskId,
        idx,
      };

      const [type, serializedValue] = this.serde.dumpsTyped(value);

      return {
        updateOne: {
          filter: upsertQuery,
          update: {
            $set: {
              channel,
              type,
              value: serializedValue,
            },
          },
          upsert: true,
        },
      };
    });

    await this.db
      .collection(this.checkpointWritesCollectionName)
      .bulkWrite(operations);
  }
}
