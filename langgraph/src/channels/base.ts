import { ReadonlyCheckpoint, deepCopy } from "../checkpoint/base.js";
import { uuid6 } from "../checkpoint/id.js";
import { Checkpoint } from "../checkpoint/index.js";
import { EmptyChannelError } from "../errors.js";

export abstract class BaseChannel<
  ValueType = unknown,
  UpdateType = unknown,
  CheckpointType = unknown
> {
  ValueType: ValueType;

  UpdateType: UpdateType;

  /**
   * The name of the channel.
   */
  abstract lc_graph_name: string;

  /**
   * Return a new identical channel, optionally initialized from a checkpoint.
   * Can be thought of as a "restoration" from a checkpoint which is a "snapshot" of the channel's state.
   *
   * @param {CheckpointType | undefined} checkpoint
   * @param {CheckpointType | undefined} initialValue
   * @returns {this}
   */
  abstract fromCheckpoint(checkpoint?: CheckpointType): this;

  /**
   * Update the channel's value with the given sequence of updates.
   * The order of the updates in the sequence is arbitrary.
   *
   * @throws {InvalidUpdateError} if the sequence of updates is invalid.
   * @param {Array<UpdateType>} values
   * @returns {void}
   */
  abstract update(values: UpdateType[]): void;

  /**
   * Return the current value of the channel.
   *
   * @throws {EmptyChannelError} if the channel is empty (never updated yet).
   * @returns {ValueType}
   */
  abstract get(): ValueType;

  /**
   * Return a string representation of the channel's current state.
   *
   * @throws {EmptyChannelError} if the channel is empty (never updated yet), or doesn't support checkpoints.
   * @returns {CheckpointType | undefined}
   */
  abstract checkpoint(): CheckpointType | undefined;

  /**
   * Mark the current value of the channel as consumed. By default, no-op.
   * This is called by Pregel before the start of the next step, for all
   * channels that triggered a node. If the channel was updated, return true.
   */
  consume(): boolean {
    return true;
  }
}

export function emptyChannels<Cc extends Record<string, BaseChannel>>(
  channels: Cc,
  checkpoint: ReadonlyCheckpoint
): Cc {
  const newChannels = {} as Cc;
  for (const k in channels) {
    if (Object.prototype.hasOwnProperty.call(channels, k)) {
      const channelValue = checkpoint.channel_values[k];
      newChannels[k] = channels[k].fromCheckpoint(channelValue);
    }
  }
  return newChannels;
}

export function createCheckpoint<ValueType>(
  checkpoint: ReadonlyCheckpoint,
  channels: Record<string, BaseChannel<ValueType>>,
  step: number
): Checkpoint {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const values: Record<string, any> = {};
  for (const k of Object.keys(channels)) {
    try {
      values[k] = channels[k].checkpoint();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.name === EmptyChannelError.unminifiable_name) {
        // no-op
      } else {
        throw error; // Rethrow unexpected errors
      }
    }
  }
  return {
    v: 1,
    id: uuid6(step),
    ts: new Date().toISOString(),
    channel_values: values,
    channel_versions: { ...checkpoint.channel_versions },
    versions_seen: deepCopy(checkpoint.versions_seen),
    pending_sends: checkpoint.pending_sends ?? [],
  };
}
