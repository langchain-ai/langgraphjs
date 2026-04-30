import type {
  BaseCheckpointSaver,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { CHECKPOINT_NAMESPACE_END } from "../constants.js";

export class ReplayState {
  checkpointId: string;

  private _visitedNs: Set<string> = new Set();

  constructor(checkpointId: string) {
    this.checkpointId = checkpointId;
  }

  private _isFirstVisit(checkpointNs: string): boolean {
    const stableNs = checkpointNs.includes(CHECKPOINT_NAMESPACE_END)
      ? checkpointNs.slice(
          0,
          checkpointNs.lastIndexOf(CHECKPOINT_NAMESPACE_END)
        )
      : checkpointNs;
    if (this._visitedNs.has(stableNs)) {
      return false;
    }
    this._visitedNs.add(stableNs);
    return true;
  }

  async getCheckpoint(
    checkpointNs: string,
    checkpointer: BaseCheckpointSaver,
    checkpointConfig: RunnableConfig
  ): Promise<CheckpointTuple | undefined> {
    if (this._isFirstVisit(checkpointNs)) {
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
