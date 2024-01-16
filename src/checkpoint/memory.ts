import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  ConfigurableFieldSpec,
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
