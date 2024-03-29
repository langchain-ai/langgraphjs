import { Checkpoint } from "../checkpoint/index.js";

export abstract class BaseChannel<
  Value = unknown,
  Update = unknown, // Expected type of the parameter `update` is called with.
  C = unknown // Type of the channel's checkpoint
> {
  /**
   * The name of the channel.
   */
  abstract lc_graph_name: string;

  /**
   * Return a new identical channel, optionally initialized from a checkpoint.
   * Can be thought of as a "restoration" from a checkpoint which is a "snapshot" of the channel's state.
   *
   * @param {C | undefined} checkpoint
   * @param {C | undefined} initialValue
   * @returns {this}
   */
  abstract empty(
    checkpoint?: C,
    initialValueFactory?: () => C
  ): BaseChannel<Value, Update, C>;

  /**
   * Update the channel's value with the given sequence of updates.
   * The order of the updates in the sequence is arbitrary.
   *
   * @throws {InvalidUpdateError} if the sequence of updates is invalid.
   * @param {Array<Update>} values
   * @returns {void}
   */
  abstract update(values: Update[]): void;

  /**
   * Return the current value of the channel.
   *
   * @throws {EmptyChannelError} if the channel is empty (never updated yet).
   * @returns {Value}
   */
  abstract get(): Value;

  /**
   * Return a string representation of the channel's current state.
   *
   * @throws {EmptyChannelError} if the channel is empty (never updated yet), or doesn't support checkpoints.
   * @returns {C | undefined}
   */
  abstract checkpoint(): C | undefined;
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
      newChannels[k] = channels[k].empty(channelValue);
    }
  }
  return newChannels;
}

export async function createCheckpoint<Value>(
  checkpoint: Checkpoint,
  channels: Record<string, BaseChannel<Value>>
): Promise<Checkpoint> {
  const newCheckpoint: Checkpoint = {
    v: 1,
    ts: new Date().toISOString(),
    channelValues: { ...checkpoint.channelValues },
    channelVersions: { ...checkpoint.channelVersions },
    versionsSeen: { ...checkpoint.versionsSeen },
  };
  for (const k of Object.keys(channels)) {
    try {
      newCheckpoint.channelValues[k] = await channels[k].checkpoint();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.name === EmptyChannelError.name) {
        // no-op
      } else {
        throw error; // Rethrow unexpected errors
      }
    }
  }
  return newCheckpoint;
}
