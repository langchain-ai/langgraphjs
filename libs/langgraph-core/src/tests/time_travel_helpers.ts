import type { RunnableConfig } from "@langchain/core/runnables";
import type { CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { Annotation } from "../graph/annotation.js";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import type { PregelTaskDescription, StateSnapshot } from "../pregel/types.js";

export const TimeTravelState = Annotation.Root({
  value: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

export type CheckpointSummaryEntry = {
  id: string;
  parentId: string | null;
  source: CheckpointMetadata["source"] | undefined;
  next: StateSnapshot["next"];
  values: StateSnapshot["values"];
};

export type TimeTravelGraph = {
  getState(
    config: RunnableConfig,
    options?: { subgraphs?: boolean }
  ): Promise<StateSnapshot>;
};

export function isStateSnapshot(
  state: LangGraphRunnableConfig | StateSnapshot
): state is StateSnapshot {
  return "values" in state && "next" in state;
}

export function snapshotCheckpointId(
  snapshot: StateSnapshot
): string | undefined {
  const id = snapshot.config.configurable?.checkpoint_id;
  return typeof id === "string" ? id : undefined;
}

export function collectCheckpointIds(history: StateSnapshot[]): Set<string> {
  const ids = history.flatMap((s) => {
    const id = snapshotCheckpointId(s);
    return id ? [id] : [];
  });
  return new Set(ids);
}

export function getTaskRunnableConfig(
  task: PregelTaskDescription
): RunnableConfig | undefined {
  const { state } = task;
  if (!state) return undefined;
  return isStateSnapshot(state) ? state.config : state;
}

export function getTaskThreadId(task: PregelTaskDescription): string | undefined {
  const threadId = getTaskRunnableConfig(task)?.configurable?.thread_id;
  return typeof threadId === "string" ? threadId : undefined;
}

export function checkpointSummary(
  history: StateSnapshot[]
): CheckpointSummaryEntry[] {
  return history.map((s) => {
    const cid = s.config.configurable?.checkpoint_id ?? "";
    const pid = s.parentConfig?.configurable?.checkpoint_id ?? null;
    return {
      id: typeof cid === "string" ? cid.slice(-6) : "",
      parentId: typeof pid === "string" ? pid.slice(-6) : null,
      source: s.metadata?.source,
      next: s.next,
      values: s.values,
    };
  });
}

export function historyHasNext(snapshot: StateSnapshot, node: string): boolean {
  return snapshot.next.includes(node);
}

export function findHistoryByNext(
  history: StateSnapshot[],
  node: string
): StateSnapshot | undefined {
  return history.find((s) => historyHasNext(s, node));
}

export function filterHistoryByNext(
  history: StateSnapshot[],
  node: string
): StateSnapshot[] {
  return history.filter((s) => historyHasNext(s, node));
}

export function findInterruptAtNode(
  history: StateSnapshot[],
  node: string
): StateSnapshot | undefined {
  return history.find(
    (s) =>
      historyHasNext(s, node) &&
      s.tasks.some((t) => (t.interrupts?.length ?? 0) > 0)
  );
}

export async function getSubgraphState(
  graph: TimeTravelGraph,
  config: RunnableConfig,
  subgraphName: string
): Promise<StateSnapshot> {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== "string") {
    throw new Error("config.configurable.thread_id is required");
  }
  return graph.getState(
    {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: subgraphName,
      },
    },
    { subgraphs: true }
  );
}
