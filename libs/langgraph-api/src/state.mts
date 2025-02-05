import type {
  LangGraphRunnableConfig,
  StateSnapshot,
} from "@langchain/langgraph";
import type { ThreadState, Checkpoint } from "./storage/ops.mjs";
import { runnableConfigToCheckpoint } from "./utils/runnableConfig.mjs";
import { serializeError } from "./utils/serde.mjs";

const isStateSnapshot = (
  state: StateSnapshot | LangGraphRunnableConfig,
): state is StateSnapshot => {
  return "values" in state && "next" in state;
};

export const stateSnapshotToThreadState = (
  state: StateSnapshot,
): ThreadState => {
  return {
    values: state.values,
    next: state.next,
    tasks: state.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      error: task.error != null ? serializeError(task.error).message : null,
      interrupts: task.interrupts,
      path: task.path,
      // TODO: too many type assertions, check if this is actually correct
      checkpoint:
        task.state != null && "configurable" in task.state
          ? ((task.state.configurable as Checkpoint) ?? null)
          : null,
      state:
        task.state != null && isStateSnapshot(task.state)
          ? stateSnapshotToThreadState(task.state)
          : null,
      // TODO: add missing result to the library
      // @ts-expect-error
      result: task.result ?? null,
    })),
    metadata: state.metadata as Record<string, unknown> | undefined,
    created_at: state.createdAt ? new Date(state.createdAt) : null,
    checkpoint: runnableConfigToCheckpoint(state.config),
    parent_checkpoint: runnableConfigToCheckpoint(state.parentConfig),
  };
};
