import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointAt,
  ConfigurableFieldSpec,
  copyCheckpoint,
} from "./base.js";

export class MemorySaver extends BaseCheckpointSaver {
  storage: Record<string, Checkpoint> = {};

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

  get(config: RunnableConfig): Checkpoint | undefined {
    return this.storage[config.configurable?.threadId];
  }

  put(config: RunnableConfig, checkpoint: Checkpoint): void {
    this.storage[config.configurable?.threadId] = checkpoint;
  }
}

export class MemorySaverAssertImmutable extends MemorySaver {
  storageForCopies: Record<string, Record<string, Checkpoint>> = {};

  constructor() {
    super();
    this.storageForCopies = {};
    this.at = CheckpointAt.END_OF_STEP;
  }

  put(config: RunnableConfig, checkpoint: Checkpoint): void {
    const threadId = config.configurable?.threadId;
    if (!this.storageForCopies[threadId]) {
      this.storageForCopies[threadId] = {};
    }
    // assert checkpoint hasn't been modified since last written
    const saved = super.get(config);
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
