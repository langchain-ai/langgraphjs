import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from "./base.js";
import { SerializerProtocol } from "../serde/base.js";

export class MemorySaver extends BaseCheckpointSaver {
  storage: Record<string, Record<string, [string, string]>>;

  constructor(serde?: SerializerProtocol<unknown>) {
    super(serde);
    this.storage = {};
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.threadId;
    const threadTs = config.configurable?.threadTs;
    const checkpoints = this.storage[threadId];

    if (threadTs) {
      const checkpoint = checkpoints[threadTs];
      if (checkpoint) {
        return {
          config,
          checkpoint: this.serde.parse(checkpoint[0]) as Checkpoint,
          metadata: this.serde.parse(checkpoint[1]) as CheckpointMetadata,
        };
      }
    } else {
      if (checkpoints) {
        const maxThreadTs = Object.keys(checkpoints).sort((a, b) =>
          b.localeCompare(a)
        )[0];
        const checkpoint = checkpoints[maxThreadTs];
        return {
          config: { configurable: { threadId, threadTs: maxThreadTs } },
          checkpoint: this.serde.parse(checkpoint[0]) as Checkpoint,
          metadata: this.serde.parse(checkpoint[1]) as CheckpointMetadata,
        };
      }
    }

    return undefined;
  }

  async *list(config: RunnableConfig): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.threadId;
    const checkpoints = this.storage[threadId] ?? {};

    // sort in desc order
    for (const [threadTs, checkpoint] of Object.entries(checkpoints).sort(
      (a, b) => b[0].localeCompare(a[0])
    )) {
      yield {
        config: { configurable: { threadId, threadTs } },
        checkpoint: this.serde.parse(checkpoint[0]) as Checkpoint,
        metadata: this.serde.parse(checkpoint[1]) as CheckpointMetadata,
      };
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.threadId;

    if (this.storage[threadId]) {
      this.storage[threadId][checkpoint.ts] = [
        this.serde.stringify(checkpoint),
        this.serde.stringify(metadata),
      ];
    } else {
      this.storage[threadId] = {
        [checkpoint.ts]: [
          this.serde.stringify(checkpoint),
          this.serde.stringify(metadata),
        ],
      };
    }

    return {
      configurable: {
        threadId,
        threadTs: checkpoint.ts,
      },
    };
  }
}
