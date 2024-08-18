import { RunnableConfig } from "@langchain/core/runnables";
import { DefaultSerializer, SerializerProtocol } from "../serde/base.js";
import { uuid6 } from "./id.js";
import { SendInterface } from "../constants.js";
import type {
  PendingWrite,
  CheckpointPendingWrite,
  CheckpointMetadata,
} from "./types.js";

export type ChannelVersions = Record<string, string | number>;

export interface Checkpoint<
  N extends string = string,
  C extends string = string
> {
  /**
   * Version number
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
  channel_versions: Record<C, number>;
  /**
   * @default {}
   */
  versions_seen: Record<N, Record<C, number>>;
  /**
   * List of packets sent to nodes but not yet processed.
   * Cleared by the next checkpoint.
   */
  pending_sends: SendInterface[];
}

export interface ReadonlyCheckpoint extends Readonly<Checkpoint> {
  readonly channel_values: Readonly<Record<string, unknown>>;
  readonly channel_versions: Readonly<Record<string, number>>;
  readonly versions_seen: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
}

export function getChannelVersion(
  checkpoint: ReadonlyCheckpoint,
  channel: string
): number {
  return checkpoint.channel_versions[channel] ?? 0;
}

export function getVersionSeen(
  checkpoint: ReadonlyCheckpoint,
  node: string,
  channel: string
): number {
  return checkpoint.versions_seen[node]?.[channel] ?? 0;
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

export function emptyCheckpoint(): Checkpoint {
  return {
    v: 1,
    id: uuid6(-2),
    ts: new Date().toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
    pending_sends: [],
  };
}

export function copyCheckpoint(checkpoint: ReadonlyCheckpoint): Checkpoint {
  return {
    v: checkpoint.v,
    id: checkpoint.id,
    ts: checkpoint.ts,
    channel_values: { ...checkpoint.channel_values },
    channel_versions: { ...checkpoint.channel_versions },
    versions_seen: deepCopy(checkpoint.versions_seen),
    pending_sends: [...checkpoint.pending_sends],
  };
}

export interface CheckpointTuple {
  config: RunnableConfig;
  checkpoint: Checkpoint;
  metadata?: CheckpointMetadata;
  parentConfig?: RunnableConfig;
  pendingWrites?: CheckpointPendingWrite[];
}

export abstract class BaseCheckpointSaver {
  serde: SerializerProtocol<unknown> = DefaultSerializer;

  constructor(serde?: SerializerProtocol<unknown>) {
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
    limit?: number,
    before?: RunnableConfig
  ): AsyncGenerator<CheckpointTuple>;

  abstract put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
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
   * Generate the next version ID for a channel.
   *
   * Default is to use integer versions, incrementing by 1. If you override, you can use str/int/float versions,
   * as long as they are monotonically increasing.
   *
   * TODO: Fix type
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNextVersion(current: number | undefined, _channel: any) {
    return current !== undefined ? current + 1 : 1;
  }
}
