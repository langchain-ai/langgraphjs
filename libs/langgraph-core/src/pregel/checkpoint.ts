import type {
  CheckpointMetadata,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import {
  type BaseChannel,
  deltaChannelsToSnapshot,
  isDeltaChannel,
} from "../channels/base.js";

/**
 * `counters_since_delta_snapshot` after one more superstep: every delta
 * channel gains a superstep, and the ones in `updatedChannels` an update.
 */
export function advanceDeltaCounters(
  channels: Record<string, BaseChannel>,
  updatedChannels: Set<string>,
  counters: Record<string, [number, number]> | undefined
): Record<string, [number, number]> {
  const next: Record<string, [number, number]> = {};
  for (const name in channels) {
    if (
      !Object.prototype.hasOwnProperty.call(channels, name) ||
      !isDeltaChannel(channels[name])
    ) {
      continue;
    }
    const [updates, supersteps] = counters?.[name] ?? [0, 0];
    next[name] = [
      updatedChannels.has(name) ? updates + 1 : updates,
      supersteps + 1,
    ];
  }
  return next;
}

/** The metadata entry for `counters`, which an empty set leaves out. */
export function deltaCountersMetadata(
  counters: Record<string, [number, number]>
): Pick<CheckpointMetadata, "counters_since_delta_snapshot"> {
  return Object.keys(counters).length > 0
    ? { counters_since_delta_snapshot: counters }
    : {};
}

/**
 * The delta channels a checkpoint `updateState` saves after `saved` must
 * snapshot, and its `counters_since_delta_snapshot` metadata. The checkpoint
 * counts as a superstep, so a channel that reaches its bound snapshots. A new
 * thread has no checkpoint to hold the writes, so it snapshots every delta
 * channel it wrote instead.
 *
 * A channel in `forkChannels` snapshots too.
 */
export function updateStateDeltaPlan(
  channels: Record<string, BaseChannel>,
  updatedChannels: Set<string>,
  saved: CheckpointTuple | undefined,
  channelVersions: Record<string, number | string>,
  deltaWritesVersioned: boolean,
  forkChannels: Set<string> = new Set()
): {
  channelsToSnapshot: Set<string>;
  metadata: Pick<CheckpointMetadata, "counters_since_delta_snapshot">;
} {
  if (saved === undefined) {
    const channelsToSnapshot = new Set<string>();
    for (const name in channels) {
      if (
        Object.prototype.hasOwnProperty.call(channels, name) &&
        isDeltaChannel(channels[name]) &&
        channels[name].isAvailable() &&
        channelVersions[name] !== undefined
      ) {
        channelsToSnapshot.add(name);
      }
    }
    return { channelsToSnapshot, metadata: {} };
  }
  const counters = advanceDeltaCounters(
    channels,
    updatedChannels,
    saved.metadata?.counters_since_delta_snapshot
  );
  const channelsToSnapshot = deltaChannelsToSnapshot(
    channels,
    counters,
    deltaWritesVersioned ? channelVersions : undefined
  );
  for (const name of forkChannels) channelsToSnapshot.add(name);
  for (const name of channelsToSnapshot) delete counters[name];
  return { channelsToSnapshot, metadata: deltaCountersMetadata(counters) };
}
