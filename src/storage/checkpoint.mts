import { RunnableConfig } from "@langchain/core/runnables";
import {
  Checkpoint,
  CheckpointMetadata,
  MemorySaver,
} from "@langchain/langgraph";

const EXCLUDED_KEYS = ["checkpoint_ns", "checkpoint_id", "run_id", "thread_id"];

class InMemorySaver extends MemorySaver {
  clear() {
    this.storage = {};
    this.writes = {};
  }

  put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    // TODO: should this be done in OSS as well?
    return super.put(config, checkpoint, {
      ...Object.fromEntries(
        Object.entries(config.configurable ?? {}).filter(
          ([key]) => !EXCLUDED_KEYS.includes(key)
        )
      ),
      ...config.metadata,
      ...metadata,
    });
  }
}

export const checkpointer = new InMemorySaver();
