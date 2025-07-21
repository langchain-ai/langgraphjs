import { Client as ESClient } from '@elastic/elasticsearch'
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

type CheckpointDocument = {
  thread_id: any;
  checkpoint_ns: any;
  checkpoint_id: string;
  parent_checkpoint_id: any;
  checkpoint: Checkpoint<string, string>;
  metadata: CheckpointMetadata;
}

type WritesDocument = {
  thread_id: any;
  checkpoint_ns: any;
  checkpoint_id: any;
  task_id: string;
  idx: number;
  channel: string;
  value: PendingWrite[1];
}

export type ElasticSearchSaverParams = {
  client: ESClient;
  checkpointIndex?: string;
  checkpointWritesIndex?: string;
};

/**
 * A LangGraph checkpoint saver backed by a Elasticsearch database.
 */
export class ElasticSearchSaver extends BaseCheckpointSaver {
  protected client: ESClient;

  static defaultCheckpointIndex = "checkpoints";
  static defaultCheckpointWritesIndex = "checkpoint_writes";

  checkpointIndex = ElasticSearchSaver.defaultCheckpointIndex;
  checkpointWritesIndex = ElasticSearchSaver.defaultCheckpointWritesIndex;

  constructor(
    {
      client,
      checkpointIndex,
      checkpointWritesIndex,
    }: ElasticSearchSaverParams,
    serde?: SerializerProtocol
  ) {
    super(serde);
    this.client = client;
    this.checkpointIndex =
      checkpointIndex ?? this.checkpointIndex;
    this.checkpointWritesIndex =
      checkpointWritesIndex ?? this.checkpointWritesIndex;
  }

  /**
   * Sets up the indices for checkpoints and writes in Elasticsearch.
   * Only creates the indices if they do not already exist.
   * This method should be called once before using the saver.
   */
  async setupIndices(): Promise<void> {
    const exists = await this.client.indices.exists({ index: this.checkpointIndex });
    if (!exists) {
      await this.client.indices.create({
        index: this.checkpointIndex,
        mappings: {
          properties: {
            thread_id: { type: "keyword" },
            checkpoint_ns: { type: "keyword" },
            checkpoint_id: { type: "keyword" },
            parent_checkpoint_id: { type: "keyword" },
            checkpoint: { type: "nested" },
            metadata: { type: "nested" },
          }
        }
      });
    }

    const existsWrites = await this.client.indices.exists({ index: this.checkpointWritesIndex });
    if (!existsWrites) {
      await this.client.indices.create({
        index: this.checkpointWritesIndex,
        mappings: {
          properties: {
            thread_id: { type: "keyword" },
            checkpoint_ns: { type: "keyword" },
            checkpoint_id: { type: "keyword" },
            task_id: { type: "keyword" },
            idx: { type: "integer" },
            channel: { type: "keyword" },
            value: { type: "text" }, // Assuming value can be text, adjust as necessary
          }
        }
      });
    }
  }

  /**
   * Retrieves a checkpoint from Elasticsearch based on the
   * provided config. If the config contains a "checkpoint_id" key, the checkpoint with
   * the matching thread ID and checkpoint ID is retrieved. Otherwise, the latest checkpoint
   * for the given thread ID is retrieved.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};

    const result = await this.client.search<CheckpointDocument>({
      index: this.checkpointIndex,
      size: 1,
      sort: [{ checkpoint_id: { order: "desc" } }],
      query: {
        bool: {
          must: [
            { term: { thread_id } },
            { term: { checkpoint_ns } },
            ...(checkpoint_id ? [{ term: { checkpoint_id } }] : []),
          ]
        }
      }
    }).catch((error) => {
      this.errorWarnings(error);
      throw error;
    })


    if (result.hits.hits.length === 0 || result.hits.hits[0]?._source === undefined) {
      return undefined;
    }

    const doc = result.hits.hits[0]._source;

    const writes = await this.client.search<WritesDocument>({
      index: this.checkpointWritesIndex,
      sort: [{ idx: { order: "asc" } }],
      query: {
        bool: {
          must: [
            { term: { thread_id } },
            { term: { checkpoint_ns } },
            { term: { checkpoint_id: doc.checkpoint_id } },
          ]
        }
      }
    })

    const pendingWrites: CheckpointPendingWrite[] = writes.hits.hits.map((serializedWrite) => {
      return [
        serializedWrite._source!.task_id,
        serializedWrite._source!.channel,
        serializedWrite._source!.value,
      ];
    });

    const configurableValues = {
      thread_id,
      checkpoint_ns,
      checkpoint_id: doc.checkpoint_id,
    };

    return {
      config: { configurable: configurableValues },
      checkpoint: doc.checkpoint,
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
   * Retrieve a list of checkpoint tuples from the MongoDB database based
   * on the provided config. The checkpoints are ordered by checkpoint ID
   * in descending order (newest first).
   */
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    const mustClauses = [];

    if (config?.configurable?.thread_id) {
      mustClauses.push({ term: { thread_id: config.configurable.thread_id } });
    }

    if (config?.configurable?.checkpoint_ns !== undefined && config?.configurable?.checkpoint_ns !== null) {
      mustClauses.push({ term: { checkpoint_ns: config.configurable.checkpoint_ns } });
    }

    if (before) {
      mustClauses.push({ range: { checkpoint_id: { lt: before.configurable?.checkpoint_id } } });
    }

    if (filter) {
      Object.entries(filter).forEach(([key, value]) => {
        mustClauses.push({ term: { [`metadata.${key}`]: value } });
      });
    }

    const result = await this.client.search<CheckpointDocument>({
      index: this.checkpointIndex,
      ...(limit ? { size: limit } : {}),
      sort: [{ checkpoint_id: { order: "desc" } }],
      query: {
        bool: {
          must: mustClauses,
        }
      }
    }).catch((error) => {
      this.errorWarnings(error);
      throw error;
    });

    for await (const doc of result.hits.hits) {
      yield {
        config: {
          configurable: {
            thread_id: doc._source!.thread_id,
            checkpoint_ns: doc._source!.checkpoint_ns,
            checkpoint_id: doc._source!.checkpoint_id,
          },
        },
        checkpoint: doc._source!.checkpoint,
        metadata: doc._source!.metadata,
        parentConfig: doc._source!.parent_checkpoint_id
          ? {
            configurable: {
              thread_id: doc._source!.thread_id,
              checkpoint_ns: doc._source!.checkpoint_ns,
              checkpoint_id: doc._source!.parent_checkpoint_id,
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
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    const checkpoint_id = checkpoint.id;
    if (thread_id === undefined) {
      throw new Error(
        `The provided config must contain a configurable field with a "thread_id" field.`
      );
    }

    const doc: CheckpointDocument = {
      thread_id,
      checkpoint_ns,
      checkpoint_id,
      parent_checkpoint_id: config.configurable?.checkpoint_id,
      checkpoint: checkpoint,
      metadata: metadata,
    };


    const compositeId = `thread_id:${thread_id}|checkpoint_ns:${checkpoint_ns}|checkpoint_id:${checkpoint_id}`;


    await this.client.index({
      index: this.checkpointIndex,
      id: compositeId,
      document: doc,
      refresh: 'wait_for' // Make immediately available for search
    }).catch((error) => {
      this.errorWarnings(error);
      throw error;
    });

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

    const operations = writes.flatMap((write, idx) => {
      const [channel, value] = write;

      const compositeId = `thread_id:${thread_id}|checkpoint_ns:${checkpoint_ns}|checkpoint_id:${checkpoint_id}|task_id:${taskId}|idx:${idx}`;

      const doc: WritesDocument = {
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        task_id: taskId,
        idx,
        channel,
        value: value
      }

      return [
        {
          index: {
            _index: this.checkpointWritesIndex,
            _id: compositeId
          }
        },
        doc
      ]
    })

    await this.client.bulk({
      operations,
      refresh: 'wait_for' // Make immediately available for search
    }).catch((error) => {
      this.errorWarnings(error);
      throw error;
    })
  }

  errorWarnings(error: any): void {
    // check if error is index_not_found_exception
    if (error.meta?.body?.error?.type === 'index_not_found_exception') {
      console.warn(`ElasticSearchSaver error. Did you forget to call setupIndices? e.g. 

const checkpointer = new ElasticSearchSaver({ client });
checkpointer.setupIndices()`);
    }
  }
}
