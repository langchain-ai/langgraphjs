import {
  ReadonlyCheckpoint,
  uuid6,
  Checkpoint,
  DeltaSnapshot,
  type BaseCheckpointSaver,
  type DeltaChannelHistory,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { EmptyChannelError } from "../errors.js";
import { getDeltaMaxSuperstepsSinceSnapshot } from "../constants.js";

/** Matches Postgres `uuid` / Python `uuid.UUID` (128-bit, 8-4-4-4-12 hex). */
const STRUCTURED_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Structural check for a {@link DeltaChannel} without importing it (avoids an
 * import cycle: `delta.ts` imports `base.ts`).
 */
export function isDeltaChannel(channel: BaseChannel): boolean {
  return channel != null && channel.lc_graph_name === "DeltaChannel";
}

export function isBaseChannel(obj: unknown): obj is BaseChannel {
  return obj != null && (obj as BaseChannel).lg_is_channel === true;
}

/** @internal */
export abstract class BaseChannel<
  ValueType = unknown,
  UpdateType = unknown,
  CheckpointType = unknown,
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

  /**
   * Compare this channel with another channel for equality.
   * Used to determine if two channels with the same key are semantically equivalent.
   * Subclasses should override this method to provide a meaningful comparison.
   *
   * @param {BaseChannel} other - The other channel to compare with.
   * @returns {boolean} True if the channels are equal, false otherwise.
   */
  equals(other: BaseChannel): boolean {
    return this === other;
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

/**
 * Minimal structural view of a {@link DeltaChannel}, used by helpers in this
 * module that must not import the concrete class (import-cycle avoidance).
 */
interface DeltaChannelLike extends BaseChannel {
  snapshotFrequency: number;
  replayWrites(writes: DeltaChannelHistory["writes"]): void;
}

/**
 * Synthetic task id for exit-mode DeltaChannel writes.
 *
 * Embeds the superstep in the first UUID group so `ORDER BY task_id, idx`
 * preserves chronological order while remaining a valid RFC UUID (required by
 * Postgres `checkpoint_writes.task_id uuid` columns).
 */
export function exitDeltaTaskId(step: number, taskId: string): string {
  if (!STRUCTURED_UUID.test(taskId)) {
    throw new TypeError(`Invalid task id for exit delta: ${taskId}`);
  }
  const parts = taskId.toLowerCase().split("-");
  const stepPart = String(step).padStart(8, "0");
  return `${stepPart}-${parts[1]}-${parts[2]}-${parts[3]}-${parts[4]}`;
}

/**
 * Return the set of {@link DeltaChannel} names that should snapshot now.
 *
 * A channel snapshots when EITHER its accumulated update count reaches
 * `snapshotFrequency` OR the total supersteps since its last snapshot reaches
 * `DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT`. Pure predicate — no mutation.
 */
export function deltaChannelsToSnapshot(
  channels: Record<string, BaseChannel>,
  countersSinceDeltaSnapshot: Record<string, [number, number]>
): Set<string> {
  const result = new Set<string>();
  const maxSupersteps = getDeltaMaxSuperstepsSinceSnapshot();
  for (const name in channels) {
    if (!Object.prototype.hasOwnProperty.call(channels, name)) continue;
    const ch = channels[name];
    if (!isDeltaChannel(ch) || !ch.isAvailable()) continue;
    const [updates, supersteps] = countersSinceDeltaSnapshot[name] ?? [0, 0];
    if (
      updates >= (ch as DeltaChannelLike).snapshotFrequency ||
      supersteps >= maxSupersteps
    ) {
      result.add(name);
    }
  }
  return result;
}

export function createCheckpoint<ValueType>(
  checkpoint: ReadonlyCheckpoint,
  channels: Record<string, BaseChannel<ValueType>> | undefined,
  step: number,
  options?: {
    id?: string;
    channelsToSnapshot?: Set<string>;
    updatedChannels?: Set<string>;
    getNextVersion?: (current: number | string | undefined) => number | string;
  }
): Checkpoint {
  const channelsToSnapshot = options?.channelsToSnapshot ?? new Set<string>();
  const { updatedChannels, getNextVersion } = options ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let values: Record<string, any>;
  let channelVersions: Record<string, number | string> =
    checkpoint.channel_versions;
  if (channels === undefined) {
    values = checkpoint.channel_values;
  } else {
    values = {};
    channelVersions = { ...checkpoint.channel_versions };
    for (const k in channels) {
      if (!Object.prototype.hasOwnProperty.call(channels, k)) continue;
      const channel = channels[k];
      if (channelsToSnapshot.has(k)) {
        // Snapshot a DeltaChannel: store the materialized value directly. In
        // exit/deferred modes the channel may have reached its snapshot
        // threshold over several supersteps without the LAST superstep
        // writing to it, so its version wouldn't be bumped by applyWrites —
        // bump it here so the saver includes the snapshot blob.
        if (
          getNextVersion !== undefined &&
          (updatedChannels === undefined || !updatedChannels.has(k))
        ) {
          channelVersions[k] = getNextVersion(channelVersions[k]);
        }
        values[k] = new DeltaSnapshot(channel.get());
        continue;
      }
      if (isDeltaChannel(channel)) {
        // Omitted from channel_values; reconstructed from ancestor writes.
        continue;
      }
      try {
        values[k] = channel.checkpoint();
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
    channel_versions: channelVersions,
    versions_seen: checkpoint.versions_seen,
  };
}

/**
 * Hydrate channels from a checkpoint, reconstructing any {@link DeltaChannel}
 * whose value is absent from `channel_values` by replaying ancestor writes.
 *
 * For most channels (and for delta channels with a {@link DeltaSnapshot} or a
 * migrated plain value in `channel_values`), {@link emptyChannels} is
 * sufficient and no saver access is required. When a delta channel is absent
 * from `channel_values`, an ancestor walk via `saver.getDeltaChannelHistory`
 * finds the nearest seed and accumulates the writes between it and the
 * target. All delta channels needing replay are batched into a single saver
 * call.
 */
export async function channelsFromCheckpoint<
  Cc extends Record<string, BaseChannel>,
>(
  specs: Cc,
  checkpoint: ReadonlyCheckpoint,
  options?: { saver?: BaseCheckpointSaver; config?: RunnableConfig }
): Promise<Cc> {
  const channels = emptyChannels(specs, checkpoint);
  const { saver, config } = options ?? {};

  const filteredSpecs = getOnlyChannels(specs);
  const deltaKeys: string[] = [];
  for (const k in filteredSpecs) {
    if (!Object.prototype.hasOwnProperty.call(filteredSpecs, k)) continue;
    if (
      isDeltaChannel(filteredSpecs[k]) &&
      !Object.prototype.hasOwnProperty.call(checkpoint.channel_values, k)
    ) {
      deltaKeys.push(k);
    }
  }

  if (deltaKeys.length === 0 || saver === undefined || config === undefined) {
    return channels;
  }

  const histories = await saver.getDeltaChannelHistory({
    config,
    channels: deltaKeys,
  });
  for (const k of deltaKeys) {
    const history = histories[k];
    if (history === undefined) continue;
    const replayCh = filteredSpecs[k].fromCheckpoint(
      history.seed
    ) as unknown as DeltaChannelLike;
    replayCh.replayWrites(history.writes);
    (channels as Record<string, BaseChannel>)[k] = replayCh;
  }
  return channels;
}
