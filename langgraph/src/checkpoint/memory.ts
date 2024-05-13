import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointTuple,
  copyCheckpoint,
} from "./base.js";
import { SerializerProtocol } from "../serde/base.js";

export class MemorySaver extends BaseCheckpointSaver {
  storage: Record<string, Record<string, string>>;

  constructor(serde?: SerializerProtocol<Checkpoint>) {
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
          checkpoint: this.serde.parse(checkpoint),
        };
      }
    } else {
      if (checkpoints) {
        const maxThreadTs = Object.keys(checkpoints).sort((a, b) =>
          b.localeCompare(a)
        )[0];
        return {
          config: { configurable: { threadId, threadTs: maxThreadTs } },
          checkpoint: this.serde.parse(checkpoints[maxThreadTs.toString()]),
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
        checkpoint: this.serde.parse(checkpoint),
      };
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.threadId;

    if (this.storage[threadId]) {
      this.storage[threadId][checkpoint.ts] = this.serde.stringify(checkpoint);
    } else {
      this.storage[threadId] = {
        [checkpoint.ts]: this.serde.stringify(checkpoint),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class MemorySaverAssertImmutable extends MemorySaver {
  storageForCopies: Record<string, Record<string, Checkpoint>> = {};

  constructor() {
    super();
    this.storageForCopies = {};
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.threadId;
    if (!this.storageForCopies[threadId]) {
      this.storageForCopies[threadId] = {};
    }
    // assert checkpoint hasn't been modified since last written
    const saved = await super.get(config);
    if (saved) {
      const savedTs = saved.ts;
      if (this.storageForCopies[threadId][savedTs]) {
        console.assert(
          this.storageForCopies[threadId][savedTs] === saved,
          "Checkpoint has been modified"
        );
      }
    }
    this.storageForCopies[threadId][checkpoint.ts] = copyCheckpoint(checkpoint);

    return super.put(config, checkpoint);
  }
}
