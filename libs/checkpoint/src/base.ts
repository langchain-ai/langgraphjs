import type { RunnableConfig } from "@langchain/core/runnables";
import { SerializerProtocol } from "./serde/base.js";
import { uuid6 } from "./id.js";
import type {
  PendingWrite,
  CheckpointPendingWrite,
  CheckpointMetadata,
  DeltaChannelHistory,
} from "./types.js";
import { ERROR, INTERRUPT, RESUME, SCHEDULED } from "./serde/types.js";
import { JsonPlusSerializer } from "./serde/jsonplus.js";

/** @inline */
type ChannelVersion = number | string;

export type ChannelVersions = Record<string, ChannelVersion>;

export interface Checkpoint<
  N extends string = string,
  C extends string = string,
> {
  /**
   * The version of the checkpoint format. Currently 4
   */
  v: number;
  /**
   * Checkpoint ID {uuid6}
   */
  id: string;
  /**
   * Timestamp {new Date().toISOString()}
   */
  ts: string;
  /**
   * @default {}
   */
  channel_values: Record<C, unknown>;
  /**
   * @default {}
   */
  channel_versions: Record<C, ChannelVersion>;
  /**
   * @default {}
   */
  versions_seen: Record<N, Record<C, ChannelVersion>>;
}

export interface ReadonlyCheckpoint extends Readonly<Checkpoint> {
  readonly channel_values: Readonly<Record<string, unknown>>;
  readonly channel_versions: Readonly<Record<string, ChannelVersion>>;
  readonly versions_seen: Readonly<
    Record<string, Readonly<Record<string, ChannelVersion>>>
  >;
}

export function deepCopy<T>(obj: T): T {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  const newObj = Array.isArray(obj) ? [] : {};

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      (newObj as Record<PropertyKey, unknown>)[key] = deepCopy(
        (obj as Record<string, unknown>)[key]
      );
    }
  }

  return newObj as T;
}

/** @hidden */
export function emptyCheckpoint(): Checkpoint {
  return {
    v: 4,
    id: uuid6(0),
    ts: new Date().toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  };
}

/** @hidden */
export function copyCheckpoint(checkpoint: ReadonlyCheckpoint): Checkpoint {
  return {
    v: checkpoint.v,
    id: checkpoint.id,
    ts: checkpoint.ts,
    channel_values: { ...(checkpoint.channel_values ?? {}) },
    channel_versions: { ...(checkpoint.channel_versions ?? {}) },
    versions_seen: deepCopy(checkpoint.versions_seen ?? {}),
  };
}

export interface CheckpointTuple {
  config: RunnableConfig;
  checkpoint: Checkpoint;
  metadata?: CheckpointMetadata;
  parentConfig?: RunnableConfig;
  pendingWrites?: CheckpointPendingWrite[];
}

export type CheckpointListOptions = {
  limit?: number;
  before?: RunnableConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter?: Record<string, any>;
};

export abstract class BaseCheckpointSaver<V extends string | number = number> {
  serde: SerializerProtocol = new JsonPlusSerializer();

  constructor(serde?: SerializerProtocol) {
    this.serde = serde || this.serde;
  }

  /**
   * Prevent `JSON.stringify` from traversing backend clients (e.g. pg Pool
   * timers) when a checkpointer is present in runnable `configurable`.
   */
  toJSON(): string {
    return `[${this.constructor.name}]`;
  }

  async get(config: RunnableConfig): Promise<Checkpoint | undefined> {
    const value = await this.getTuple(config);
    return value ? value.checkpoint : undefined;
  }

  abstract getTuple(
    config: RunnableConfig
  ): Promise<CheckpointTuple | undefined>;

  abstract list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple>;

  abstract put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig>;

  /**
   * Store intermediate writes linked to a checkpoint.
   */
  abstract putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void>;

  /**
   * Delete all checkpoints and writes associated with a specific thread ID.
   * @param threadId The thread ID whose checkpoints should be deleted.
   */
  abstract deleteThread(threadId: string): Promise<void>;

  /**
   * Walk the parent chain returning per-channel writes + seed, used to
   * reconstruct `DeltaChannel` state from `checkpoint_writes`.
   *
   * For each requested channel, walks ancestors of the checkpoint identified
   * by `config` (following `parentConfig`) and accumulates the pending writes
   * for that channel. The walk terminates per-channel at the nearest ancestor
   * whose `channel_values[ch]` is populated; that value is returned as `seed`.
   * If the walk reaches the root without finding a stored value, `seed` is
   * omitted from that channel's entry — the consumer treats the absence as
   * "start empty".
   *
   * Walks the parent chain (not `list({ before })`): for forked threads, only
   * on-path ancestors contribute.
   *
   * The default implementation walks `getTuple` + `parentConfig` once for all
   * channels — each ancestor visited once, not once per channel. Savers with
   * direct storage access (e.g. `MemorySaver`) override for performance; the
   * return contract is fixed here.
   *
   * @remarks Beta. The signature, return shape, and interaction with
   * `DeltaSnapshot` blobs may change. Override at your own risk; the default
   * implementation will continue to work against the public
   * `BaseCheckpointSaver` contract.
   *
   * @param options.config Configuration identifying the target checkpoint.
   * @param options.channels Channel names to walk for. Empty → empty mapping.
   * @returns Per-channel {@link DeltaChannelHistory} for every requested name.
   */
  async getDeltaChannelHistory(options: {
    config: RunnableConfig;
    channels: string[];
  }): Promise<Record<string, DeltaChannelHistory>> {
    const { config, channels } = options;
    if (channels.length === 0) return {};

    const collectedByCh: Record<string, CheckpointPendingWrite[]> = {};
    const seedByCh: Record<string, unknown> = {};
    const remaining = new Set(channels);
    for (const ch of channels) collectedByCh[ch] = [];

    const targetTuple = await this.getTuple(config);
    let cursorConfig: RunnableConfig | undefined = targetTuple?.parentConfig;

    while (cursorConfig != null && remaining.size > 0) {
      const tup: CheckpointTuple | undefined =
        await this.getTuple(cursorConfig);
      if (tup === undefined) break;
      if (tup.pendingWrites && tup.pendingWrites.length > 0) {
        // DeltaChannel reconstruction must replay concurrent same-superstep
        // writes in the canonical (task_id, idx) order that live execution uses
        // (see `_applyWrites`), or the reconstructed value can diverge from the
        // live one. Group per channel and stable-sort by task id: a stable sort
        // keeps each task's writes in their stored `idx` order, making the
        // result independent of how a saver returns `pendingWrites`.
        const perChannel: Record<string, CheckpointPendingWrite[]> = {};
        for (const write of tup.pendingWrites) {
          const ch = write[1];
          if (remaining.has(ch)) (perChannel[ch] ??= []).push(write);
        }
        for (const ch of Object.keys(perChannel)) {
          const block = perChannel[ch];
          block.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
          // Pushed reversed so the final `.reverse()` below yields oldest→newest
          // checkpoints with each checkpoint's writes ascending by (task_id, idx).
          for (let i = block.length - 1; i >= 0; i -= 1) {
            collectedByCh[ch].push(block[i]);
          }
        }
      }
      for (const ch of Array.from(remaining)) {
        if (
          Object.prototype.hasOwnProperty.call(
            tup.checkpoint.channel_values,
            ch
          )
        ) {
          seedByCh[ch] = tup.checkpoint.channel_values[ch];
          remaining.delete(ch);
        }
      }
      cursorConfig = tup.parentConfig;
    }

    const result: Record<string, DeltaChannelHistory> = {};
    for (const ch of channels) {
      const entry: DeltaChannelHistory = {
        writes: collectedByCh[ch].slice().reverse(),
      };
      if (Object.prototype.hasOwnProperty.call(seedByCh, ch)) {
        entry.seed = seedByCh[ch];
      }
      result[ch] = entry;
    }
    return result;
  }

  /**
   * Generate the next version ID for a channel.
   *
   * Default is to use integer versions, incrementing by 1. If you override, you can use str/int/float versions,
   * as long as they are monotonically increasing.
   */
  getNextVersion(current: V | undefined): V {
    if (typeof current === "string") {
      throw new Error("Please override this method to use string versions.");
    }
    return (
      current !== undefined && typeof current === "number" ? current + 1 : 1
    ) as V;
  }
}

export function compareChannelVersions(
  a: ChannelVersion,
  b: ChannelVersion
): number {
  if (typeof a === "number" && typeof b === "number") {
    return Math.sign(a - b);
  }

  return String(a).localeCompare(String(b));
}

export function maxChannelVersion(
  ...versions: ChannelVersion[]
): ChannelVersion {
  return versions.reduce((max, version, idx) => {
    if (idx === 0) return version;
    return compareChannelVersions(max, version) >= 0 ? max : version;
  });
}

/**
 * Mapping from error type to error index.
 * Regular writes just map to their index in the list of writes being saved.
 * Special writes (e.g. errors) map to negative indices, to avoid those writes from
 * conflicting with regular writes.
 * Each Checkpointer implementation should use this mapping in put_writes.
 */
export const WRITES_IDX_MAP: Record<string, number> = {
  [ERROR]: -1,
  [SCHEDULED]: -2,
  [INTERRUPT]: -3,
  [RESUME]: -4,
};

/**
 * Metadata keys that are LangGraph's internal framework bookkeeping and
 * should not be surfaced as user-meaningful metadata.
 *
 * Consumed by stream handlers (e.g. the `tasks` debug stream) to drop
 * framework keys — which are redundant with a task's own fields and
 * namespace — while keeping keys like `lc_agent_name`, `ls_integration`,
 * and user-supplied metadata.
 */
export const EXCLUDED_METADATA_KEYS: ReadonlySet<string> = new Set([
  "thread_id",
  "checkpoint_id",
  "checkpoint_ns",
  "checkpoint_map",
  "langgraph_step",
  "langgraph_node",
  "langgraph_triggers",
  "langgraph_path",
  "langgraph_checkpoint_ns",
]);

export function getCheckpointId(config: RunnableConfig): string {
  return (
    config.configurable?.checkpoint_id || config.configurable?.thread_ts || ""
  );
}
