import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointPendingWrite,
  CheckpointTuple,
  copyCheckpoint,
  getCheckpointId,
  PendingWrite,
  SendProtocol,
  SerializerProtocol,
  TASKS,
  WRITES_IDX_MAP,
} from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import { FileThreadDataStorage } from "./utils/file.js";
import { generateKey, getIdsFromRunnableConfig } from "./utils/base.js";
import { IFileSaverStorageData, IFileSaverWritesData } from "./types.js";

export class FileCheckpointSaver extends BaseCheckpointSaver {
  private readonly fileStorage: FileThreadDataStorage;

  constructor(config: {
    basePath: string;
    fileExtension: string;
    serde?: SerializerProtocol;
  }) {
    super(config.serde);
    this.fileStorage = new FileThreadDataStorage(
      config.basePath,
      config.fileExtension
    );
  }

  private async _getPendingSends(
    threadId: string,
    checkpointNamespace: string,
    parentCheckpointId?: string
  ) {
    let pendingSends: SendProtocol[] = [];

    if (parentCheckpointId !== undefined) {
      const writesData =
        await this.fileStorage.loadThreadData<IFileSaverWritesData>(
          threadId,
          "writes"
        );

      const key = generateKey(
        threadId,
        checkpointNamespace,
        parentCheckpointId
      );

      pendingSends =
        Object.values(writesData.writes[key] || {})
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ?.filter(([_taskId, channel]) => {
            return channel === TASKS;
          })
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          .map(([_taskId, _channel, writes]) => writes) ?? [];
    }

    return pendingSends;
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const preparedCheckpoint: Checkpoint = copyCheckpoint(checkpoint);

    // fix the type error
    delete (preparedCheckpoint as unknown as Partial<Checkpoint>).pending_sends;

    const { threadId, checkpointNamespace } = getIdsFromRunnableConfig(config);

    if (threadId === undefined) {
      throw new Error(
        `Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.`
      );
    }

    const threadData =
      await this.fileStorage.loadThreadData<IFileSaverStorageData>(
        threadId,
        "storage"
      );

    threadData.storage[checkpointNamespace] =
      threadData.storage[checkpointNamespace] || {};

    // Notice: checkpoint.id vs config.configurable?.checkpoint_id
    threadData.storage[checkpointNamespace][checkpoint.id] = [
      preparedCheckpoint,
      metadata,
      config.configurable?.checkpoint_id, // parent checkpoint id
    ];

    // Based on the serialize protocol, we need to serialize the checkpoint and metadata,
    // But actually, we don't need to do this based on our file storage design.

    // const [, serializedCheckpoint] = await this.serde.dumpsTyped(preparedCheckpoint);
    // const [, serializedMetadata] = await this.serde.dumpsTyped(metadata);

    await this.fileStorage.saveThreadData(threadId, threadData, "storage");

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const { threadId, checkpointNamespace, checkpointId } =
      getIdsFromRunnableConfig(config);

    if (threadId === undefined) {
      throw new Error(
        `Failed to put writes. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property`
      );
    }

    if (checkpointId === undefined) {
      throw new Error(
        `Failed to put writes. The passed RunnableConfig is missing a required "checkpoint_id" field in its "configurable" property.`
      );
    }

    const outerKey = generateKey(threadId, checkpointNamespace, checkpointId);

    const writesData =
      await this.fileStorage.loadThreadData<IFileSaverWritesData>(
        threadId,
        "writes"
      );

    writesData.writes[outerKey] = writesData.writes[outerKey] || {};

    const outerWrites_ = writesData.writes[outerKey];

    writes.forEach(([channel, value], idx) => {
      const innerKey: [string, number] = [
        taskId,
        WRITES_IDX_MAP[channel] || idx,
      ];

      const innerKeyStr = `${innerKey[0]},${innerKey[1]}`;

      if (innerKey[1] >= 0 && outerWrites_ && innerKeyStr in outerWrites_) {
        return;
      }

      writesData.writes[outerKey][innerKeyStr] = [taskId, channel, value];
    });

    await this.fileStorage.saveThreadData(threadId, writesData, "writes");
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, checkpointNamespace } = getIdsFromRunnableConfig(config);

    // Notice here, checkpointId from configurable?.checkpoint_id || configurable?.thread_ts || ""
    const checkpointId = getCheckpointId(config);

    const storageData =
      await this.fileStorage.loadThreadData<IFileSaverStorageData>(
        threadId,
        "storage"
      );
    const writesData =
      await this.fileStorage.loadThreadData<IFileSaverWritesData>(
        threadId,
        "writes"
      );

    if (checkpointId) {
      const saved = storageData.storage[checkpointNamespace][checkpointId];

      if (saved !== undefined) {
        const [checkpoint, metadata, parentCheckpointId] = saved;

        const key = generateKey(threadId, checkpointNamespace, checkpointId);

        const pendingSends = await this._getPendingSends(
          threadId,
          checkpointNamespace,
          parentCheckpointId
        );

        const pendingWrites: CheckpointPendingWrite[] = Object.values(
          writesData.writes[key] || {}
        ).map(([taskId, channel, value]) => [taskId, channel, value]);

        const checkpointTuple: CheckpointTuple = {
          checkpoint: {
            ...checkpoint,
            pending_sends: pendingSends,
          },
          metadata,
          pendingWrites,
          config,
        };

        if (parentCheckpointId !== undefined) {
          checkpointTuple.parentConfig = {
            configurable: {
              thread_id: threadId,
              checkpoint_ns: checkpointNamespace,
              checkpoint_id: parentCheckpointId,
            },
          };
        }

        return checkpointTuple;
      }
    } else {
      const checkpoints = storageData.storage[checkpointNamespace];

      if (checkpoints === undefined) {
        return undefined;
      }

      const latestCheckpointId = Object.keys(checkpoints).sort((a, b) =>
        b.localeCompare(a)
      )[0];

      const saved = checkpoints[latestCheckpointId];

      const [checkpoint, metadata, parentCheckpointId] = saved;

      const key = generateKey(threadId, checkpointNamespace, checkpointId);

      const pendingSends = await this._getPendingSends(
        threadId,
        checkpointNamespace,
        parentCheckpointId
      );

      const pendingWrites: CheckpointPendingWrite[] = Object.values(
        writesData.writes[key] || {}
      ).map(([taskId, channel, value]) => [taskId, channel, value]);

      const checkpointTuple: CheckpointTuple = {
        checkpoint: {
          ...checkpoint,
          pending_sends: pendingSends,
        },
        metadata,
        pendingWrites,
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_id: latestCheckpointId,
            checkpoint_ns: checkpointNamespace,
          },
        },
      };

      if (parentCheckpointId !== undefined) {
        checkpointTuple.parentConfig = {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNamespace,
            checkpoint_id: parentCheckpointId,
          },
        };
      }

      return checkpointTuple;
    }

    return undefined;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    // eslint-disable-next-line prefer-const
    let { before, limit, filter } = options ?? {};

    const {
      threadId,
      checkpointNamespace: configCheckpointNamespace,
      checkpointId: configCheckpointId,
    } = getIdsFromRunnableConfig(config);

    // Require thread_id
    if (!threadId) {
      throw new Error(
        `Failed to list checkpoints. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.`
      );
    }

    const storageData =
      await this.fileStorage.loadThreadData<IFileSaverStorageData>(
        config.configurable?.thread_id,
        "storage"
      );

    const writesData =
      await this.fileStorage.loadThreadData<IFileSaverWritesData>(
        config.configurable?.thread_id,
        "writes"
      );

    // For aligning with the memory-saver implementation
    const threadIds = [threadId];

    for (const threadId of threadIds) {
      for (const checkpointNamespace of Object.keys(
        storageData.storage ?? {}
      )) {
        if (
          configCheckpointNamespace !== undefined &&
          checkpointNamespace !== configCheckpointNamespace
        ) {
          continue;
        }

        const checkpoints = storageData?.storage?.[checkpointNamespace] ?? {};

        const sortedCheckpoints = Object.entries(checkpoints).sort((a, b) =>
          b[0].localeCompare(a[0])
        );

        for (const [
          checkpointId,
          [checkpoint, metaData, parentCheckpointId],
        ] of sortedCheckpoints) {
          // Filter by checkpoint ID from config
          if (configCheckpointId && checkpointId !== configCheckpointId) {
            continue;
          }

          // Filter by checkpoint ID from before config
          if (
            before &&
            before.configurable?.checkpoint_id &&
            checkpointId >= before.configurable.checkpoint_id
          ) {
            continue;
          }

          // Parse metadata
          const metadata = metaData as CheckpointMetadata;

          if (
            filter &&
            !Object.entries(filter).every(
              ([key, value]) =>
                (metadata as unknown as Record<string, unknown>)[key] === value
            )
          ) {
            continue;
          }

          // Limit search results
          if (limit !== undefined) {
            if (limit <= 0) break;
            limit -= 1;
          }

          const key = generateKey(threadId, checkpointNamespace, checkpointId);

          const writes = Object.values(writesData.writes[key] || {});

          const pending_sends = await this._getPendingSends(
            threadId,
            checkpointNamespace,
            parentCheckpointId
          );

          const pendingWrites: CheckpointPendingWrite[] = writes.map(
            ([taskId, channel, value]) => [taskId, channel, value]
          );

          const checkpointTuple: CheckpointTuple = {
            config: {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: checkpointNamespace,
                checkpoint_id: checkpointId,
              },
            },
            checkpoint: {
              ...checkpoint,
              pending_sends,
            },
            metadata,
            pendingWrites,
          };

          if (parentCheckpointId !== undefined) {
            checkpointTuple.parentConfig = {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: checkpointNamespace,
                checkpoint_id: parentCheckpointId,
              },
            };
          }
          yield checkpointTuple;
        }
      }
    }
  }
}
