export const TASKS = "__pregel_tasks";
export const ERROR = "__error__";
export const SCHEDULED = "__scheduled__";
export const INTERRUPT = "__interrupt__";
export const RESUME = "__resume__";

/**
 * Snapshot blob for a `DeltaChannel` with finite snapshot frequency.
 *
 * Stored directly in a checkpoint's `channel_values` in place of the full
 * accumulated value. The ancestor walk in
 * {@link BaseCheckpointSaver.getDeltaChannelHistory} terminates when it
 * encounters a populated `channel_values` entry for a channel; a
 * `DeltaSnapshot` value is the materialized state at that ancestor, so the
 * channel reconstructs directly from `.value` without replaying earlier
 * writes.
 *
 * @remarks Beta. The on-disk representation may change in future releases.
 */
export class DeltaSnapshot<Value = unknown> {
  /** Marker used for structural detection across module/realm boundaries. */
  lg_name = "DeltaSnapshot" as const;

  value: Value;

  constructor(value: Value) {
    this.value = value;
  }
}

/**
 * Structural type guard for {@link DeltaSnapshot}. Uses the `lg_name` marker
 * so it survives serialization round-trips and cross-package duplication.
 */
export function isDeltaSnapshot<Value = unknown>(
  value: unknown
): value is DeltaSnapshot<Value> {
  return (
    value != null &&
    typeof value === "object" &&
    (value as { lg_name?: string }).lg_name === "DeltaSnapshot"
  );
}

// Mirrors BaseChannel in "@langchain/langgraph"
export interface ChannelProtocol<
  ValueType = unknown,
  UpdateType = unknown,
  CheckpointType = unknown,
> {
  ValueType: ValueType;

  UpdateType: UpdateType;

  /**
   * The name of the channel.
   */
  lc_graph_name: string;

  /**
   * Return a new identical channel, optionally initialized from a checkpoint.
   * Can be thought of as a "restoration" from a checkpoint which is a "snapshot" of the channel's state.
   *
   * @param {CheckpointType | undefined} checkpoint
   * @returns {this}
   */
  fromCheckpoint(checkpoint?: CheckpointType): this;

  /**
   * Update the channel's value with the given sequence of updates.
   * The order of the updates in the sequence is arbitrary.
   *
   * @throws {InvalidUpdateError} if the sequence of updates is invalid.
   * @param {Array<UpdateType>} values
   * @returns {void}
   */
  update(values: UpdateType[]): void;

  /**
   * Return the current value of the channel.
   *
   * @throws {EmptyChannelError} if the channel is empty (never updated yet).
   * @returns {ValueType}
   */
  get(): ValueType;

  /**
   * Return a string representation of the channel's current state.
   *
   * @throws {EmptyChannelError} if the channel is empty (never updated yet), or doesn't support checkpoints.
   * @returns {CheckpointType | undefined}
   */
  checkpoint(): CheckpointType | undefined;
}

// Mirrors SendInterface in "@langchain/langgraph"
export interface SendProtocol {
  node: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any;
  // Optional per-task timeout policy. Structural to avoid a dependency on the
  // langgraph package; mirrors `TimeoutPolicy` in "@langchain/langgraph".
  timeout?: {
    runTimeout?: number;
    idleTimeout?: number;
    refreshOn?: "auto" | "heartbeat";
  };
}
