import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  ConfigurableFieldSpec,
} from "./base.js";

export class MemorySaver<C extends object, N extends string> extends BaseCheckpointSaver<C, N> {
  storage: Record<string, Checkpoint<C, N>> = {};

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

  get(config: RunnableConfig): Checkpoint<C, N> | undefined {
    return this.storage[config.configurable?.threadId];
  }

  put(config: RunnableConfig, checkpoint: Checkpoint<C, N>): void {
    this.storage[config.configurable?.threadId] = checkpoint;
  }
}
