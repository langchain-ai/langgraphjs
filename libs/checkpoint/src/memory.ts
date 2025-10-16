import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointListOptions,
  CheckpointTuple,
  copyCheckpoint,
  getCheckpointId,
  maxChannelVersion,
  WRITES_IDX_MAP,
} from "./base.js";
import { SerializerProtocol } from "./serde/base.js";
import {
  CheckpointMetadata,
  CheckpointPendingWrite,
  PendingWrite,
} from "./types.js";
import { TASKS } from "./serde/types.js";

function _generateKey(
  threadId: string,
  checkpointNamespace: string,
  checkpointId: string
) {
  return JSON.stringify([threadId, checkpointNamespace, checkpointId]);
}

function _parseKey(key: string) {
  const [threadId, checkpointNamespace, checkpointId] = JSON.parse(key);
  return { threadId, checkpointNamespace, checkpointId };
}

export class MemorySaver extends BaseCheckpointSaver {
  // thread ID ->  checkpoint namespace -> checkpoint ID -> checkpoint mapping
  storage: Record<
    string,
    Record<string, Record<string, [Uint8Array, Uint8Array, string | undefined]>>
  > = {};

  writes: Record<string, Record<string, [string, string, Uint8Array]>> = {};

  constructor(serde?: SerializerProtocol) {
    super(serde);
  }

  /** @internal */
  async _migratePendingSends(
    mutableCheckpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string
  ) {
    const deseriablizableCheckpoint = mutableCheckpoint;
    const parentKey = _generateKey(threadId, checkpointNs, parentCheckpointId);

    const pendingSends = await Promise.all(
      Object.values(this.writes[parentKey] ?? {})
        .filter(([_taskId, channel]) => channel === TASKS)
        .map(
          async ([_taskId, _channel, writes]) =>
            await this.serde.loadsTyped("json", writes)
        )
    );

    deseriablizableCheckpoint.channel_values ??= {};
    deseriablizableCheckpoint.channel_values[TASKS] = pendingSends;

    deseriablizableCheckpoint.channel_versions ??= {};
    deseriablizableCheckpoint.channel_versions[TASKS] =
      Object.keys(deseriablizableCheckpoint.channel_versions).length > 0
        ? maxChannelVersion(
            ...Object.values(deseriablizableCheckpoint.channel_versions)
          )
        : this.getNextVersion(undefined);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    let checkpoint_id = getCheckpointId(config);

    if (checkpoint_id) {
      const saved = this.storage[thread_id]?.[checkpoint_ns]?.[checkpoint_id];
      if (saved !== undefined) {
        const [checkpoint, metadata, parentCheckpointId] = saved;
        const key = _generateKey(thread_id, checkpoint_ns, checkpoint_id);
        const deserializedCheckpoint: Checkpoint = await this.serde.loadsTyped(
          "json",
          checkpoint
        );

        if (deserializedCheckpoint.v < 4 && parentCheckpointId !== undefined) {
          await this._migratePendingSends(
            deserializedCheckpoint,
            thread_id,
            checkpoint_ns,
            parentCheckpointId
          );
        }

        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
          Object.values(this.writes[key] || {}).map(
            async ([taskId, channel, value]) => {
              return [
                taskId,
                channel,
                await this.serde.loadsTyped("json", value),
              ];
            }
          )
        );
        const checkpointTuple: CheckpointTuple = {
          config,
          checkpoint: deserializedCheckpoint,
          metadata: (await this.serde.loadsTyped(
            "json",
            metadata
          )) as CheckpointMetadata,
          pendingWrites,
        };
        if (parentCheckpointId !== undefined) {
          checkpointTuple.parentConfig = {
            configurable: {
              thread_id,
              checkpoint_ns,
              checkpoint_id: parentCheckpointId,
            },
          };
        }
        return checkpointTuple;
      }
    } else {
      const checkpoints = this.storage[thread_id]?.[checkpoint_ns];
      if (checkpoints !== undefined) {
        // eslint-disable-next-line prefer-destructuring
        checkpoint_id = Object.keys(checkpoints).sort((a, b) =>
          b.localeCompare(a)
        )[0];
        const saved = checkpoints[checkpoint_id];
        const [checkpoint, metadata, parentCheckpointId] = saved;
        const key = _generateKey(thread_id, checkpoint_ns, checkpoint_id);
        const deserializedCheckpoint: Checkpoint = await this.serde.loadsTyped(
          "json",
          checkpoint
        );

        if (deserializedCheckpoint.v < 4 && parentCheckpointId !== undefined) {
          await this._migratePendingSends(
            deserializedCheckpoint,
            thread_id,
            checkpoint_ns,
            parentCheckpointId
          );
        }

        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
          Object.values(this.writes[key] || {}).map(
            async ([taskId, channel, value]) => {
              return [
                taskId,
                channel,
                await this.serde.loadsTyped("json", value),
              ];
            }
          )
        );
        const checkpointTuple: CheckpointTuple = {
          config: {
            configurable: {
              thread_id,
              checkpoint_id,
              checkpoint_ns,
            },
          },
          checkpoint: deserializedCheckpoint,
          metadata: (await this.serde.loadsTyped(
            "json",
            metadata
          )) as CheckpointMetadata,
          pendingWrites,
        };
        if (parentCheckpointId !== undefined) {
          checkpointTuple.parentConfig = {
            configurable: {
              thread_id,
              checkpoint_ns,
              checkpoint_id: parentCheckpointId,
            },
          };
        }
        return checkpointTuple;
      }
    }

    return undefined;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    // eslint-disable-next-line prefer-const
    let { before, limit, filter } = options ?? {};
    const threadIds = config.configurable?.thread_id
      ? [config.configurable?.thread_id]
      : Object.keys(this.storage);
    const configCheckpointNamespace = config.configurable?.checkpoint_ns;
    const configCheckpointId = config.configurable?.checkpoint_id;

    for (const threadId of threadIds) {
      for (const checkpointNamespace of Object.keys(
        this.storage[threadId] ?? {}
      )) {
        if (
          configCheckpointNamespace !== undefined &&
          checkpointNamespace !== configCheckpointNamespace
        ) {
          continue;
        }
        const checkpoints = this.storage[threadId]?.[checkpointNamespace] ?? {};
        const sortedCheckpoints = Object.entries(checkpoints).sort((a, b) =>
          b[0].localeCompare(a[0])
        );

        for (const [
          checkpointId,
          [checkpoint, metadataStr, parentCheckpointId],
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
          const metadata = (await this.serde.loadsTyped(
            "json",
            metadataStr
          )) as CheckpointMetadata;

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

          const key = _generateKey(threadId, checkpointNamespace, checkpointId);
          const writes = Object.values(this.writes[key] || {});

          const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
            writes.map(async ([taskId, channel, value]) => {
              return [
                taskId,
                channel,
                await this.serde.loadsTyped("json", value),
              ];
            })
          );

          const deserializedCheckpoint = await this.serde.loadsTyped(
            "json",
            checkpoint
          );

          if (
            deserializedCheckpoint.v < 4 &&
            parentCheckpointId !== undefined
          ) {
            await this._migratePendingSends(
              deserializedCheckpoint,
              threadId,
              checkpointNamespace,
              parentCheckpointId
            );
          }

          const checkpointTuple: CheckpointTuple = {
            config: {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: checkpointNamespace,
                checkpoint_id: checkpointId,
              },
            },
            checkpoint: deserializedCheckpoint,
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

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? "";
    if (threadId === undefined) {
      throw new Error(
        `Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.`
      );
    }

    if (!this.storage[threadId]) {
      this.storage[threadId] = {};
    }
    if (!this.storage[threadId][checkpointNamespace]) {
      this.storage[threadId][checkpointNamespace] = {};
    }

    const [[, serializedCheckpoint], [, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(preparedCheckpoint),
        this.serde.dumpsTyped(metadata),
      ]);

    this.storage[threadId][checkpointNamespace][checkpoint.id] = [
      serializedCheckpoint,
      serializedMetadata,
      config.configurable?.checkpoint_id, // parent
    ];

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
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns;
    const checkpointId = config.configurable?.checkpoint_id;
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
    const outerKey = _generateKey(threadId, checkpointNamespace, checkpointId);
    const outerWrites_ = this.writes[outerKey];
    if (this.writes[outerKey] === undefined) {
      this.writes[outerKey] = {};
    }

    await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [, serializedValue] = await this.serde.dumpsTyped(value);
        const innerKey: [string, number] = [
          taskId,
          WRITES_IDX_MAP[channel] || idx,
        ];
        const innerKeyStr = `${innerKey[0]},${innerKey[1]}`;
        if (innerKey[1] >= 0 && outerWrites_ && innerKeyStr in outerWrites_) {
          return;
        }
        this.writes[outerKey][innerKeyStr] = [taskId, channel, serializedValue];
      })
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    delete this.storage[threadId];
    for (const key of Object.keys(this.writes)) {
      if (_parseKey(key).threadId === threadId) delete this.writes[key];
    }
  }
}
