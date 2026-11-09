import type {
  LangGraphRunnableConfig,
  StateSnapshot,
} from "@langchain/langgraph";
import type { ThreadState, Checkpoint } from "./storage/types.mjs";
import { runnableConfigToCheckpoint } from "./utils/runnableConfig.mjs";
import { serializeError } from "./utils/serde.mjs";

/**
 * Keep the fields of a thread state that `select` names, as the Python
 * Agent Server does. `values.<key>` keeps one key of the values.
 */
export const selectThreadState = (
  state: ThreadState,
  select: string[] | undefined
): Partial<ThreadState> => {
  if (!select?.length) return state;

  const selected: Partial<ThreadState> = Object.fromEntries(
    Object.entries(state).filter(([key]) => select.includes(key))
  );
  const valueKeys = select
    .filter((field) => field.startsWith("values."))
    .map((field) => field.slice("values.".length));

  if (!select.includes("values") && valueKeys.length > 0) {
    selected.values = Object.fromEntries(
      valueKeys
        .filter((key) => key in state.values)
        .map((key) => [key, state.values[key]])
    );
  }
  return selected;
};

const isStateSnapshot = (
  state: StateSnapshot | LangGraphRunnableConfig
): state is StateSnapshot => {
  return "values" in state && "next" in state;
};

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
      result: task.result ?? null,
    })),
    metadata: state.metadata as Record<string, unknown> | undefined,
    created_at: state.createdAt ? new Date(state.createdAt) : null,
    checkpoint: runnableConfigToCheckpoint(state.config),
    parent_checkpoint: runnableConfigToCheckpoint(state.parentConfig),
  };
};
