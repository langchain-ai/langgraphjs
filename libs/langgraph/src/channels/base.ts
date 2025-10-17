import {
  ReadonlyCheckpoint,
  uuid6,
  Checkpoint,
} from "@langchain/langgraph-checkpoint";
import { EmptyChannelError } from "../errors.js";

export function isBaseChannel(obj: unknown): obj is BaseChannel {
  return obj != null && (obj as BaseChannel).lg_is_channel === true;
}

/** @internal */
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

  /** @ignore */
  lg_is_channel = true;

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
   * This method is called by Pregel for all channels at the end of each step.
   * If there are no updates, it is called with an empty sequence.
   *
   * Raises InvalidUpdateError if the sequence of updates is invalid.
   * Returns True if the channel was updated, False otherwise.
   *
   * @throws {InvalidUpdateError} if the sequence of updates is invalid.
   * @param {Array<UpdateType>} values
   * @returns {void}
   */
  abstract update(values: UpdateType[]): boolean;

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
   * A channel can use this method to modify its state, preventing the value
   * from being consumed again.
   *
   * Returns True if the channel was updated, False otherwise.
   */
  consume(): boolean {
    return false;
  }

  /**
   * Notify the channel that the Pregel run is finishing. By default, no-op.
   * A channel can use this method to modify its state, preventing finish.
   *
   * Returns True if the channel was updated, False otherwise.
   */
  finish(): boolean {
    return false;
  }

  /**
   * Return True if the channel is available (not empty), False otherwise.
   * Subclasses should override this method to provide a more efficient
   * implementation than calling get() and catching EmptyChannelError.
   */
  isAvailable(): boolean {
    try {
      this.get();
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.name === EmptyChannelError.unminifiable_name) {
        return false;
      }
      throw error;
    }
  }
}

const IS_ONLY_BASE_CHANNEL = Symbol.for("LG_IS_ONLY_BASE_CHANNEL");
export function getOnlyChannels(
  channels: Record<string, BaseChannel>
): Record<string, BaseChannel> {
  // @ts-expect-error - we know it's a record of base channels
  if (channels[IS_ONLY_BASE_CHANNEL] === true) return channels;

  const newChannels = {} as Record<string, BaseChannel>;
  for (const k in channels) {
    if (!Object.prototype.hasOwnProperty.call(channels, k)) continue;
    const value = channels[k];
    if (isBaseChannel(value)) newChannels[k] = value;
  }

  Object.assign(newChannels, { [IS_ONLY_BASE_CHANNEL]: true });
  return newChannels;
}

export function emptyChannels<Cc extends Record<string, BaseChannel>>(
  channels: Cc,
  checkpoint: ReadonlyCheckpoint
): Cc {
  const filteredChannels = getOnlyChannels(channels) as Cc;

  const newChannels = {} as Cc;
  for (const k in filteredChannels) {
    if (!Object.prototype.hasOwnProperty.call(filteredChannels, k)) continue;
    const channelValue = checkpoint.channel_values[k];
    newChannels[k] = filteredChannels[k].fromCheckpoint(channelValue);
  }
  Object.assign(newChannels, { [IS_ONLY_BASE_CHANNEL]: true });
  return newChannels;
}

export function createCheckpoint<ValueType>(
  checkpoint: ReadonlyCheckpoint,
  channels: Record<string, BaseChannel<ValueType>> | undefined,
  step: number,
  options?: { id?: string }
): Checkpoint {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let values: Record<string, any>;
  if (channels === undefined) {
    values = checkpoint.channel_values;
  } else {
    values = {};
    for (const k in channels) {
      if (!Object.prototype.hasOwnProperty.call(channels, k)) continue;
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
  }

  return {
    v: 4,
    id: options?.id ?? uuid6(step),
    ts: new Date().toISOString(),
    channel_values: values,
    channel_versions: checkpoint.channel_versions,
    versions_seen: checkpoint.versions_seen,
  };
}
