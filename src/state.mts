import { StateSnapshot } from "@langchain/langgraph";
import { ThreadState, Checkpoint } from "./storage/ops.mjs";
import { runnableConfigToCheckpoint } from "./utils/config.mjs";
import { serializeError } from "./utils/serde.mjs";

export const stateSnapshotToThreadState = (
  state: StateSnapshot
): ThreadState => {
  return {
    values: state.values,
    next: state.next,
    tasks: state.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      error: task.error != null ? serializeError(task.error).message : null,
      interrupts: task.interrupts,
      // TODO: too many type assertions, check if this is actually correct
      checkpoint:
        task.state != null && "configurable" in task.state
          ? ((task.state.configurable as Checkpoint) ?? null)
          : null,
      state: task.state as ThreadState | undefined,
      // result: task.result,
    })),
    metadata: state.metadata as Record<string, unknown> | undefined,
    created_at: state.createdAt ? new Date(state.createdAt) : null,
    checkpoint: runnableConfigToCheckpoint(state.config),
    parent_checkpoint: runnableConfigToCheckpoint(state.parentConfig),
  };
};
