import type { RunnableConfig } from "@langchain/core/runnables";
import { SerializerProtocol } from "./serde/base.js";
import { uuid6 } from "./id.js";
import type {
  PendingWrite,
  CheckpointPendingWrite,
  CheckpointMetadata,
} from "./types.js";
import { ERROR, INTERRUPT, RESUME, SCHEDULED } from "./serde/types.js";
import { JsonPlusSerializer } from "./serde/jsonplus.js";

/** @inline */
type ChannelVersion = number | string;

export type ChannelVersions = Record<string, ChannelVersion>;

export interface Checkpoint<
  N extends string = string,
  C extends string = string
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
    id: uuid6(-2),
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
    channel_values: { ...checkpoint.channel_values },
    channel_versions: { ...checkpoint.channel_versions },
    versions_seen: deepCopy(checkpoint.versions_seen),
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

export function getCheckpointId(config: RunnableConfig): string {
  return (
    config.configurable?.checkpoint_id || config.configurable?.thread_ts || ""
  );
}
