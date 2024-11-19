export type All = "*";

export type PendingWriteValue = unknown;

export type PendingWrite<Channel = string> = [Channel, PendingWriteValue];

export type CheckpointPendingWrite<TaskId = string> = [
  TaskId,
  ...PendingWrite<string>
];

export interface CheckpointMetadata {
  /**
   * The source of the checkpoint.
   * - "input": The checkpoint was created from an input to invoke/stream/batch.
   * - "loop": The checkpoint was created from inside the pregel loop.
   * - "update": The checkpoint was created from a manual state update.
   * - "fork": The checkpoint was created as a copy of another checkpoint.
   */
  source: "input" | "loop" | "update" | "fork";
  /**
   * The step number of the checkpoint.
   * -1 for the first "input" checkpoint.
   * 0 for the first "loop" checkpoint.
   * ... for the nth checkpoint afterwards.
   */
  step: number;
  /**
   * The writes that were made between the previous checkpoint and this one.
   * Mapping from node name to writes emitted by that node.
   */
  writes: Record<string, unknown> | null;

  /**
   * The IDs of the parent checkpoints.
   * Mapping from checkpoint namespace to checkpoint ID.
   */
  parents: Record<string, string>;
}
