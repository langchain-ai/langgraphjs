import { Checkpoint } from "../checkpoint/index.js";

/**
 * @TODO Do I need async for all these abstract methods?
 */
export abstract class BaseChannel<Value, Update, C> {
  /**
   * The type of the value stored in the channel.
   * @TODO Check this typing
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract get getValueType(): any;

  /**
   * The type of the update received by the channel.
   * @TODO Check this typing
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract get getUpdateType(): any;

  /**
   * Return a new identical channel, optionally initialized from a checkpoint.
   *
   * @param {C | undefined} checkpoint
   * @returns {Promise<BaseChannel<Value, Update, C>>}
   */
  abstract empty(checkpoint?: C): AsyncGenerator<BaseChannel<Value, Update, C>>;

  /**
   * Update the channel's value with the given sequence of updates.
   * The order of the updates in the sequence is arbitrary.
   *
   * @throws {InvalidUpdateError} if the sequence of updates is invalid.
   * @param {Array<Update>} values
   * @returns {Promise<void>}
   */
  abstract update(values: Update[]): Promise<void>;

  /**
   * Return the current value of the channel.
   *
   * @throws {EmptyChannelError} if the channel is empty (never updated yet).
   * @returns {Promise<Value>}
   */
  abstract get(): Promise<Value>;

  /**
   * Return a string representation of the channel's current state.
   *
   * @throws {EmptyChannelError} if the channel is empty (never updated yet), or doesn't supportcheckpoints.
   * @returns {Promise<C | undefined>}
   */
  abstract checkpoint(): Promise<C | undefined>;
}

export class EmptyChannelError extends Error {
  name = "EmptyChannelError";

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
 *
 * @param {{ [key: string]: BaseChannel<Value, Update, C> }} channels
 * @param {Checkpoint} checkpoint
 * @returns {Promise<{ [key: string]: BaseChannel<Value, Update, C> }>}
 */
export async function* ChannelsManager<Value, Update, C>(
  channels: { [key: string]: BaseChannel<Value, Update, C> },
  checkpoint: Checkpoint
): AsyncGenerator<{ [key: string]: BaseChannel<Value, Update, C> }> {
  const emptyChannels: { [key: string]: BaseChannel<Value, Update, C> } = {};
  for (const k in channels) {
    if (checkpoint.channelValues?.[k] !== undefined) {
      const result = await channels[k]
        .empty(checkpoint.channelValues[k])
        .next();
      if (!result.done) {
        emptyChannels[k] = result.value;
      }
      continue;
    }
  }
  /** @TODO check w/ nuno on this... */
  yield emptyChannels;

  return emptyChannels;
}

export async function createCheckpoint<Value, Update, C>(
  checkpoint: Checkpoint,
  channels: { [key: string]: BaseChannel<Value, Update, C> }
): Promise<Checkpoint> {
  const newCheckpoint: Checkpoint = {
    v: 1,
    ts: new Date().toISOString(),
    channelValues: { ...checkpoint.channelValues },
    channelVersions: { ...checkpoint.channelVersions },
    versionsSeen: { ...checkpoint.versionsSeen },
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
