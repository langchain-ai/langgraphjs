import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointListOptions,
  CheckpointTuple,
} from "./base.js";
import { SerializerProtocol } from "../serde/base.js";
import {
  CheckpointMetadata,
  CheckpointPendingWrite,
  PendingWrite,
} from "../checkpoint/types.js";

function _generateKey(
  threadId: string,
  checkpointNamespace: string,
  checkpointId: string
) {
  return JSON.stringify([threadId, checkpointNamespace, checkpointId]);
}

export class MemorySaver extends BaseCheckpointSaver {
  // thread ID ->  checkpoint namespace -> checkpoint ID -> checkpoint mapping
  storage: Record<
    string,
    Record<string, Record<string, [string, string, string | undefined]>>
  > = {};

  writes: Record<string, CheckpointPendingWrite[]> = {};

  constructor(serde?: SerializerProtocol<unknown>) {
    super(serde);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    const checkpoint_id = config.configurable?.checkpoint_id;

    if (checkpoint_id) {
      const saved = this.storage[thread_id]?.[checkpoint_ns]?.[checkpoint_id];
      if (saved !== undefined) {
        const [checkpoint, metadata, parentCheckpointId] = saved;
        const writes =
          this.writes[_generateKey(thread_id, checkpoint_ns, checkpoint_id)] ??
          [];
        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
          writes.map(async ([taskId, channel, value]) => {
            return [taskId, channel, await this.serde.parse(value as string)];
          })
        );
        const parentConfig =
          parentCheckpointId !== undefined
            ? {
                configurable: {
                  thread_id,
                  checkpoint_ns,
                  checkpoint_id,
                },
              }
            : undefined;
        return {
          config,
          checkpoint: (await this.serde.parse(checkpoint)) as Checkpoint,
          metadata: (await this.serde.parse(metadata)) as CheckpointMetadata,
          pendingWrites,
          parentConfig,
        };
      }
    } else {
      const checkpoints = this.storage[thread_id]?.[checkpoint_ns];
      if (checkpoints !== undefined) {
        const maxThreadTs = Object.keys(checkpoints).sort((a, b) =>
          b.localeCompare(a)
        )[0];
        const saved = checkpoints[maxThreadTs];
        const [checkpoint, metadata, parentCheckpointId] = saved;
        const writes =
          this.writes[_generateKey(thread_id, checkpoint_ns, checkpoint_id)] ??
          [];
        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
          writes.map(async ([taskId, channel, value]) => {
            return [taskId, channel, await this.serde.parse(value as string)];
          })
        );
        const parentConfig =
          parentCheckpointId !== undefined
            ? {
                configurable: {
                  thread_id,
                  checkpoint_ns,
                  checkpoint_id: parentCheckpointId,
                },
              }
            : undefined;
        return {
          config: {
            configurable: {
              thread_id,
              checkpoint_id: maxThreadTs,
              checkpoint_ns,
            },
          },
          checkpoint: (await this.serde.parse(checkpoint)) as Checkpoint,
          metadata: (await this.serde.parse(metadata)) as CheckpointMetadata,
          pendingWrites,
          parentConfig,
        };
      }
    }

    return undefined;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    // eslint-disable-next-line prefer-const
    let { before, limit } = options ?? {};
    const threadIds = config.configurable?.thread_id
      ? [config.configurable?.thread_id]
      : Object.keys(this.storage);
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? "";

    for (const threadId of threadIds) {
      const checkpoints = this.storage[threadId]?.[checkpointNamespace] ?? {};
      const sortedCheckpoints = Object.entries(checkpoints).sort((a, b) =>
        b[0].localeCompare(a[0])
      );

      for (const [
        checkpointId,
        [checkpoint, metadataStr, parentCheckpointId],
      ] of sortedCheckpoints) {
        // Filter by checkpoint ID
        if (
          before &&
          before.configurable?.checkpoint_id &&
          checkpointId >= before.configurable.checkpoint_id
        ) {
          continue;
        }

        // Parse metadata
        const metadata = (await this.serde.parse(
          metadataStr
        )) as CheckpointMetadata;

        // Limit search results
        if (limit !== undefined) {
          if (limit <= 0) break;
          // eslint-disable-next-line no-param-reassign
          limit -= 1;
        }

        const writes =
          this.writes[
            _generateKey(threadId, checkpointNamespace, checkpointId)
          ] ?? [];
        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
          writes.map(async ([taskId, channel, value]) => {
            return [taskId, channel, await this.serde.parse(value as string)];
          })
        );

        yield {
          config: {
            configurable: {
              thread_id: threadId,
              checkpoint_ns: checkpointNamespace,
              checkpoint_id: checkpointId,
            },
          },
          checkpoint: (await this.serde.parse(checkpoint)) as Checkpoint,
          metadata,
          pendingWrites,
          parentConfig: parentCheckpointId
            ? {
                configurable: {
                  thread_id: threadId,
                  checkpoint_ns: checkpointNamespace,
                  checkpoint_id: parentCheckpointId,
                },
              }
            : undefined,
        };
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns;
    if (threadId === undefined) {
      throw new Error(
        `Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.`
      );
    }
    if (checkpointNamespace === undefined) {
      throw new Error(
        `Failed to put checkpoint. The passed RunnableConfig is missing a required "checkpoint_ns" field in its "configurable" property.`
      );
    }

    if (!this.storage[threadId]) {
      this.storage[threadId] = {};
    }
    if (!this.storage[threadId][checkpointNamespace]) {
      this.storage[threadId][checkpointNamespace] = {};
    }

    this.storage[threadId][checkpointNamespace][checkpoint.id] = [
      this.serde.stringify(checkpoint),
      this.serde.stringify(metadata),
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
    const key = _generateKey(threadId, checkpointNamespace, checkpointId);
    if (this.writes[key] === undefined) {
      this.writes[key] = [];
    }
    const pendingWrites: CheckpointPendingWrite[] = writes.map(
      ([channel, value]) => {
        return [taskId, channel, this.serde.stringify(value)];
      }
    );
    this.writes[key].push(...pendingWrites);
  }
}
