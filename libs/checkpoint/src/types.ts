export type All = "*";

export type PendingWriteValue = unknown;

export type PendingWrite<Channel = string> = [Channel, PendingWriteValue];

export type CheckpointPendingWrite<TaskId = string> = [
  TaskId,
  ...PendingWrite<string>,
];

/**
 * Additional details about the checkpoint, including the source, step, writes, and parents.
 *
 * @typeParam ExtraProperties - Optional additional properties to include in the metadata.
 */
export type CheckpointMetadata<ExtraProperties extends object = object> = {
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
   * The IDs of the parent checkpoints.
   * Mapping from checkpoint namespace to checkpoint ID.
   */
  parents: Record<string, string>;

  /**
   * Per-channel counters since the last `DeltaSnapshot` was written, backing
   * `DeltaChannel`.
   *
   * Maps channel name to a `[updates, supersteps]` pair:
   * - `updates` (index 0): number of supersteps that wrote to this channel
   *   since its last snapshot blob.
   * - `supersteps` (index 1): total supersteps elapsed since this channel's
   *   last snapshot, regardless of whether the channel was written.
   *
   * A snapshot fires when EITHER `updates >= ch.snapshotFrequency` OR
   * `supersteps >= DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT` (system-wide bound,
   * default 5000, env `LANGGRAPH_DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT`). The
   * supersteps bound prevents unbounded ancestor walks on threads where a
   * delta channel exists but is no longer being updated.
   *
   * Absent on threads that don't use delta channels.
   *
   * @remarks Beta. The key name and contents may change while the
   * delta-channel design stabilizes.
   */
  counters_since_delta_snapshot?: Record<string, [number, number]>;
} & ExtraProperties;

/**
 * Per-channel result entry from
 * {@link BaseCheckpointSaver.getDeltaChannelHistory}.
 *
 * Storage-level view of what one channel contributed across the ancestor
 * chain of a target checkpoint:
 *
 * - `writes` — on-path deltas oldest→newest as {@link CheckpointPendingWrite}
 *   tuples. Always present; possibly empty. Already filtered to one channel.
 *   Writes stored at the target checkpoint itself are pending for the next
 *   super-step and are excluded.
 * - `seed` — the stored value at the nearest ancestor whose
 *   `channel_values[ch]` is populated. Omitted if the walk reached the root
 *   without finding any stored value (the consumer treats absence as "start
 *   empty"). Typically a `DeltaSnapshot` for delta channels with finite
 *   snapshot frequency, or a plain value for threads migrated from a
 *   pre-delta channel type.
 *
 * @remarks Beta. Field names and semantics may change.
 */
export type DeltaChannelHistory = {
  writes: CheckpointPendingWrite[];
  seed?: unknown;
};
