import { Checkpoint } from "../checkpoint/index.js";

export abstract class BaseChannel<
  Value = unknown,
  Update = unknown,
  C = unknown
> {
  /**
   * The name of the channel.
   */
  abstract lc_graph_name: string;

  /**
   * The type of the value stored in the channel.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract get ValueType(): any;

  /**
   * The type of the update received by the channel.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract get UpdateType(): any;

  /**
   * Return a new identical channel, optionally initialized from a checkpoint.
   *
   * @param {C | undefined} checkpoint
   * @param {C | undefined} initialValue
   * @returns {Generator<BaseChannel<Value>>}
   */
  abstract empty(
    checkpoint?: C,
    initialValue?: C
  ): Generator<BaseChannel<Value>>;

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
   * @throws {EmptyChannelError} if the channel is empty (never updated yet), or doesn't supportcheckpoints.
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

/**
 * Manage channels for the lifetime of a Pregel invocation (multiple steps).
 */
export class ChannelsManager<RunOutput> {
  private channels: Record<string, BaseChannel<RunOutput, unknown, unknown>>;

  private checkpoint: Checkpoint;

  constructor(
    channels: Record<string, BaseChannel<RunOutput, unknown, unknown>>,
    checkpoint: Checkpoint
  ) {
    this.channels = channels;
    this.checkpoint = checkpoint;
  }

  public *manage(): Generator<
    Record<string, BaseChannel<RunOutput, unknown, unknown>>
  > {
    const emptyChannels: Record<
      string,
      Generator<BaseChannel<RunOutput, unknown, unknown>>
    > = {};
    for (const k in this.channels) {
      if (k in this.channels) {
        const channelValue = Object.values(this.checkpoint.channelValues).length
          ? this.checkpoint.channelValues.get(k)
          : undefined;
        emptyChannels[k] = this.channels[k].empty(channelValue);
      }
    }

    const managedChannels: Record<
      string,
      BaseChannel<RunOutput, unknown, unknown>
    > = {};
    try {
      for (const k in emptyChannels) {
        if (k in emptyChannels) {
          const result = emptyChannels[k].next();
          if (!result.done) {
            managedChannels[k] = result.value;
          }
        }
      }
      yield managedChannels;
    } finally {
      for (const k in emptyChannels) {
        if (k in emptyChannels) {
          emptyChannels[k].return(managedChannels); // Clean up the generator
        }
      }
    }
  }
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
    versionsSeen: { ...checkpoint.versionsSeen }
  };
  for (const k in channels) {
    if (newCheckpoint.channelValues[k] === undefined) {
      try {
        newCheckpoint.channelValues[k] = await channels[k].checkpoint();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        if ("name" in error && error.name === EmptyChannelError.name) {
          // no-op
        } else {
          throw error; // Rethrow unexpected errors
        }
      }
    }
  }
  return newCheckpoint;
}
