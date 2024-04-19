import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointAt,
  CheckpointTuple,
  ConfigurableFieldSpec,
  copyCheckpoint,
  SerializerProtocol,
} from "./base.js";

export class NoopSerializer implements SerializerProtocol {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dumps(obj: any): any {
    return obj;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loads(data: any): any {
    return data;
  }
}

export class MemorySaver extends BaseCheckpointSaver {
  serde = new NoopSerializer();

  storage: Record<string, Record<string, Checkpoint>> = {};

  get configSpecs(): ConfigurableFieldSpec[] {
    return [
      {
        id: "threadId",
        name: "Thread ID",
        annotation: null,
        description: null,
        default: null,
        isShared: true,
        dependencies: null,
      },
    ];
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.threadId;
    const ts = config.configurable?.threadTs;
    const checkpoints = this.storage[threadId];

    if (ts) {
      const checkpoint = checkpoints[ts];
      if (checkpoint) {
        return {
          config,
          checkpoint: this.serde.loads(checkpoint),
        };
      }
    } else {
      if (checkpoints) {
        const threadTs = Object.keys(checkpoints).sort((a, b) =>
          b.localeCompare(a)
        )[0];
        return {
          config: { configurable: { threadId, threadTs } },
          checkpoint: this.serde.loads(checkpoints[threadTs.toString()]),
        };
      }
    }

    return undefined;
  }

  async *list(config: RunnableConfig): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.threadId;
    const checkpoints = this.storage[threadId] ?? {};
    for (const [threadTs, checkpoint] of Object.entries(checkpoints).sort(
      (a, b) => b[0].localeCompare(a[0])
    )) {
      yield {
        config: { configurable: { threadId, threadTs } },
        checkpoint: this.serde.loads(checkpoint),
      };
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.threadId;

    if (this.storage[threadId]) {
      this.storage[threadId][checkpoint.ts] = this.serde.dumps(checkpoint);
    } else {
      this.storage[threadId] = {
        [checkpoint.ts]: this.serde.dumps(checkpoint),
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

export class MemorySaverAssertImmutable extends MemorySaver {
  storageForCopies: Record<string, Record<string, Checkpoint>> = {};

  constructor() {
    super();
    this.storageForCopies = {};
    this.at = CheckpointAt.END_OF_STEP;
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
