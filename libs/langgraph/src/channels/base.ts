import {
  ReadonlyCheckpoint,
  deepCopy,
  uuid6,
  Checkpoint,
} from "@langchain/langgraph-checkpoint";
import { EmptyChannelError } from "../errors.js";

export function isBaseChannel(obj: unknown): obj is BaseChannel {
  return obj != null && (obj as BaseChannel).lg_is_channel === true;
}

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
   * This is called by Pregel before the start of the next step, for all
   * channels that triggered a node. If the channel was updated, return true.
   */
  consume(): boolean {
    return false;
  }
}

export function emptyChannels<Channels extends Record<string, BaseChannel>>(
  channels: Channels,
  checkpoint: ReadonlyCheckpoint
): Channels {
  const filteredChannels = Object.fromEntries(
    Object.entries(channels).filter(([, value]) => isBaseChannel(value))
  ) as Channels;

  const newChannels = {} as Channels;
  for (const k in filteredChannels) {
    if (Object.prototype.hasOwnProperty.call(filteredChannels, k)) {
      const channelValue = checkpoint.channel_values[k];
      newChannels[k] = filteredChannels[k].fromCheckpoint(channelValue);
    }
  }
  return newChannels;
}

export function createCheckpoint<ValueType>(
  checkpoint: ReadonlyCheckpoint,
  channels: Record<string, BaseChannel<ValueType>> | undefined,
  step: number
): Checkpoint {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let values: Record<string, any>;
  if (channels === undefined) {
    values = checkpoint.channel_values;
  } else {
    values = {};
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
