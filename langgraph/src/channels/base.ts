import { Checkpoint, deepCopy } from "../checkpoint/index.js";

export abstract class BaseChannel<
  ValueType = unknown,
  UpdateType = unknown,
  CheckpointType = unknown
> {
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
  abstract fromCheckpoint(
    checkpoint?: CheckpointType
  ): BaseChannel<ValueType, UpdateType, CheckpointType>;

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
}

export class EmptyChannelError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "EmptyChannelError";
  }
}

export class InvalidUpdateError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "InvalidUpdateError";
  }
}

export function emptyChannels(
  channels: Record<string, BaseChannel>,
  checkpoint: Checkpoint
): Record<string, BaseChannel> {
  const newChannels: Record<string, BaseChannel> = {};
  for (const k in channels) {
    if (Object.prototype.hasOwnProperty.call(channels, k)) {
      const channelValue = checkpoint.channelValues[k];
      newChannels[k] = channels[k].fromCheckpoint(channelValue);
    }
  }
  return newChannels;
}

export function createCheckpoint<ValueType>(
  checkpoint: Checkpoint,
  channels: Record<string, BaseChannel<ValueType>>
): Checkpoint {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const values: Record<string, any> = {};
  for (const k of Object.keys(channels)) {
    try {
      values[k] = channels[k].checkpoint();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.name === EmptyChannelError.name) {
        // no-op
      } else {
        throw error; // Rethrow unexpected errors
      }
    }
  }
  return {
    v: 1,
    ts: new Date().toISOString(),
    channelValues: values,
    channelVersions: { ...checkpoint.channelVersions },
    versionsSeen: deepCopy(checkpoint.versionsSeen),
  };
}
