import type {
  BaseCheckpointSaver,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { CHECKPOINT_NAMESPACE_END } from "../constants.js";

/**
 * Tracks subgraph checkpoint loading during parent-graph time travel.
 *
 * When a parent replays from a historical checkpoint, nested subgraphs must
 * load the checkpoint that existed *before* the replay point on their first
 * visit, then fall back to normal latest-checkpoint loading on later visits
 * within the same run.
 */
export class ReplayState {
  /** Parent checkpoint ID used as the `before` cursor for subgraph lookups. */
  checkpointId: string;

  #visitedNs: Set<string> = new Set();

  /**
   * @param checkpointId - Checkpoint ID from the parent graph at the replay point.
   */
  constructor(checkpointId: string) {
    this.checkpointId = checkpointId;
  }

  /**
   * Whether this is the first visit to a logical subgraph namespace in the run.
   *
   * Task-id suffixes are stripped so the same subgraph invoked across loop
   * iterations shares one visit record.
   *
   * @param checkpointNs - Subgraph checkpoint namespace.
   */
  #isFirstVisit(checkpointNs: string): boolean {
    const stableNs = checkpointNs.includes(CHECKPOINT_NAMESPACE_END)
      ? checkpointNs.slice(
          0,
          checkpointNs.lastIndexOf(CHECKPOINT_NAMESPACE_END)
        )
      : checkpointNs;
    if (this.#visitedNs.has(stableNs)) {
      return false;
    }
    this.#visitedNs.add(stableNs);
    return true;
  }

  /**
   * Load the checkpoint tuple for a subgraph namespace during replay.
   *
   * On the first visit to `checkpointNs`, returns the latest checkpoint saved
   * before {@link ReplayState.checkpointId}. On subsequent visits, delegates to
   * `checkpointer.getTuple` for the current config.
   *
   * @param checkpointNs - Subgraph checkpoint namespace.
   * @param checkpointer - Checkpointer shared with the parent graph.
   * @param checkpointConfig - Runnable config for the subgraph lookup.
   * @returns The resolved checkpoint tuple, if any.
   */
  async getCheckpoint(
    checkpointNs: string,
    checkpointer: BaseCheckpointSaver,
    checkpointConfig: RunnableConfig
  ): Promise<CheckpointTuple | undefined> {
    if (this.#isFirstVisit(checkpointNs)) {
      const results: CheckpointTuple[] = [];
      for await (const saved of checkpointer.list(checkpointConfig, {
        before: {
          configurable: { checkpoint_id: this.checkpointId },
        },
        limit: 1,
      })) {
        results.push(saved);
      }
      return results.length > 0 ? results[0] : undefined;
    }
    return (await checkpointer.getTuple(checkpointConfig)) ?? undefined;
  }
}
