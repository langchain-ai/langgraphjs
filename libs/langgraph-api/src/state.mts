import type {
  LangGraphRunnableConfig,
  StateSnapshot,
} from "@langchain/langgraph";
import type { ThreadState, Checkpoint, WaitingEdge } from "./storage/types.mjs";
import { runnableConfigToCheckpoint } from "./utils/runnableConfig.mjs";
import { serializeError } from "./utils/serde.mjs";

const isStateSnapshot = (
  state: StateSnapshot | LangGraphRunnableConfig
): state is StateSnapshot => {
  return "values" in state && "next" in state;
};

export const stateSnapshotToThreadState = (
  state: StateSnapshot
): ThreadState => {
  // Annotated rather than inlined below: a conditional spread into the returned
  // literal does not check its type, so a snapshot field this drifts away from
  // would fail at a consumer instead of here.
  const waitingEdges: WaitingEdge[] | undefined = state.waitingEdges?.map(
    (edge) => ({ ...edge })
  );

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
    // Omitted when every waiting edge released, mirroring the snapshot.
    ...(waitingEdges?.length ? { waiting_edges: waitingEdges } : {}),
  };
};
