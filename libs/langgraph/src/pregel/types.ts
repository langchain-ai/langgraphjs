import type { Runnable, RunnableConfig } from "@langchain/core/runnables";
import type {
  All,
  PendingWrite,
  CheckpointMetadata,
  BaseCheckpointSaver,
} from "@langchain/langgraph-checkpoint";
import type { BaseChannel } from "../channels/base.js";
import type { PregelNode } from "./read.js";
import { RetryPolicy } from "./utils.js";
import { Interrupt } from "../constants.js";
import { BaseStore } from "../store/base.js";
import { type ManagedValueSpec } from "../managed/base.js";

export type ChannelsType = Record<string, BaseChannel | ManagedValueSpec>;

export type NodesType = Record<string, PregelNode>;

export type DebugOutput<Channels extends ChannelsType> = {
  type: string;
  timestamp: string;
  step: number;
  payload: {
    id: string;
    name: string;
    result: PendingWrite<keyof Channels>[];
    config: RunnableConfig;
    metadata?: CheckpointMetadata;
  };
};

export type SingleStreamMode = "values" | "updates" | "debug";

export type StreamMode =
  | SingleStreamMode
  | [SingleStreamMode]
  | [SingleStreamMode, SingleStreamMode]
  | [SingleStreamMode, SingleStreamMode, SingleStreamMode];

type SingleStreamModeOutput<
  Mode extends SingleStreamMode,
  Nodes extends NodesType,
  Channels extends ChannelsType,
  Schema
> = Mode extends "values"
  ? Schema
  : Mode extends "updates"
  ? { [K in keyof Nodes]: Partial<Schema> }
  : Mode extends "debug"
  ? DebugOutput<Channels>
  : never;

export type StreamOutput<
  Mode extends StreamMode,
  Nodes extends NodesType,
  Channels extends ChannelsType,
  Schema
> = Mode extends SingleStreamMode
  ? SingleStreamModeOutput<Mode, Nodes, Channels, Schema>
  : Mode extends [SingleStreamMode]
  ? SingleStreamModeOutput<Mode[0], Nodes, Channels, Schema>
  : Mode extends [SingleStreamMode, SingleStreamMode]
  ? [
      SingleStreamModeOutput<Mode[0], Nodes, Channels, Schema>,
      SingleStreamModeOutput<Mode[1], Nodes, Channels, Schema>
    ]
  : Mode extends [SingleStreamMode, SingleStreamMode, SingleStreamMode]
  ? [
      SingleStreamModeOutput<Mode[0], Nodes, Channels, Schema>,
      SingleStreamModeOutput<Mode[1], Nodes, Channels, Schema>,
      SingleStreamModeOutput<Mode[2], Nodes, Channels, Schema>
    ]
  : never;

export interface PregelInterface<
  Nodes extends NodesType,
  Channels extends ChannelsType
> {
  nodes: Nodes;

  channels: Channels;

  /**
   * @default true
   */
  autoValidate?: boolean;

  /**
   * @default "values"
   */
  streamMode?: SingleStreamMode;

  inputChannels: keyof Channels | Array<keyof Channels>;

  outputChannels: keyof Channels | Array<keyof Channels>;

  /**
   * @default []
   */
  interruptAfter?: Array<keyof Nodes> | All;

  /**
   * @default []
   */
  interruptBefore?: Array<keyof Nodes> | All;

  streamChannels?: keyof Channels | Array<keyof Channels>;

  get streamChannelsAsIs(): keyof Channels | Array<keyof Channels>;

  /**
   * @default undefined
   */
  stepTimeout?: number;

  /**
   * @default false
   */
  debug?: boolean;

  checkpointer?: BaseCheckpointSaver;

  retryPolicy?: RetryPolicy;

  /**
   * Memory store to use for SharedValues.
   */
  store?: BaseStore;
}

export type PregelParams<
  Nodes extends NodesType,
  Channels extends ChannelsType
> = Omit<PregelInterface<Nodes, Channels>, "streamChannelsAsIs">;

export interface PregelTaskDescription {
  readonly id: string;
  readonly name: string;
  readonly error?: unknown;
  readonly interrupts: Interrupt[];
}

export interface PregelExecutableTask<
  N extends PropertyKey,
  C extends PropertyKey
> {
  readonly name: N;
  readonly input: unknown;
  readonly proc: Runnable;
  readonly writes: PendingWrite<C>[];
  readonly config?: RunnableConfig;
  readonly triggers: Array<string>;
  readonly retry_policy?: RetryPolicy;
  readonly id: string;
}

export interface StateSnapshot {
  /**
   * Current values of channels
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly values: Record<string, any> | any;
  /**
   * Nodes to execute in the next step, if any
   */
  readonly next: Array<string>;
  /**
   * Config used to fetch this snapshot
   */
  readonly config: RunnableConfig;
  /**
   * Metadata about the checkpoint
   */
  readonly metadata?: CheckpointMetadata;
  /**
   * Time when the snapshot was created
   */
  readonly createdAt?: string;
  /**
   * Config used to fetch the parent snapshot, if any
   * @default undefined
   */
  readonly parentConfig?: RunnableConfig | undefined;
  /**
   * Tasks to execute in this step. If already attempted, may contain an error.
   */
  readonly tasks: PregelTaskDescription[];
}
