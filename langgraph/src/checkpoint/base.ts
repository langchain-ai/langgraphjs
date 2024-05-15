import { RunnableConfig } from "@langchain/core/runnables";
import { SerializerProtocol } from "../serde/base.js";

export interface CheckpointMetadata {
  source: "input" | "loop" | "update";
  /**
   * The source of the checkpoint.
   * - "input": The checkpoint was created from an input to invoke/stream/batch.
   * - "loop": The checkpoint was created from inside the pregel loop.
   * - "update": The checkpoint was created from a manual state update. */
  step: number;
  /**
   * The step number of the checkpoint.
   * -1 for the first "input" checkpoint.
   * 0 for the first "loop" checkpoint.
   * ... for the nth checkpoint afterwards. */
  writes?: Record<string, unknown>;
  /**
   * The writes that were made between the previous checkpoint and this one.
   * Mapping from node name to writes emitted by that node.
   */
}

export interface Checkpoint {
  /**
   * Version number
   */
  v: number;
  /**
   * Timestamp {new Date().toISOString()}
   */
  ts: string;
  /**
   * @default {}
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  channel_values: Record<string, any>;
  /**
   * @default {}
   */
  channel_versions: Record<string, number>;
  /**
   * @default {}
   */
  versions_seen: Record<string, Record<string, number>>;
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
    ts: new Date().toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  };
}

export function copyCheckpoint(checkpoint: Checkpoint): Checkpoint {
  return {
    v: checkpoint.v,
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
}

export abstract class BaseCheckpointSaver {
  serde: SerializerProtocol<unknown> = JSON;

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

  abstract list(config: RunnableConfig): AsyncGenerator<CheckpointTuple>;

  abstract put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig>;
}
