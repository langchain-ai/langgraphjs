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
import {
  ConfiguredManagedValue,
  ManagedValue,
  type ManagedValueSpec,
} from "../managed/base.js";
export type ChannelsType = Record<string, BaseChannel | ManagedValueSpec>;

export type NodesType = Record<string, PregelNode>;

type ExtractChannelValueType<Channel> = Channel extends BaseChannel
  ? Channel["ValueType"]
  : Channel extends ManagedValueSpec
  ? Channel extends ConfiguredManagedValue<infer V>
  ? V
  : Channel extends ManagedValue<infer V>
  ? V
  : never
  : never;

export type ChannelsStateType<Channels extends ChannelsType> = {
  [Key in keyof Channels]: ExtractChannelValueType<Channels[Key]>;
};

type ExtractChannelUpdateType<Channel> = Channel extends BaseChannel
  ? Channel["UpdateType"]
  : Channel extends ManagedValueSpec
  ? Channel extends ConfiguredManagedValue<infer V>
  ? V
  : Channel extends ManagedValue<infer V>
  ? V
  : never
  : never;

export type ChannelsUpdateType<Channels extends ChannelsType> = {
  [Key in keyof Channels]?: ExtractChannelUpdateType<Channels[Key]>;
};

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
  Channels extends ChannelsType
> = Mode extends "values"
  ? ChannelsUpdateType<Channels>
  : Mode extends "updates"
  ? { [K in keyof Nodes]: ChannelsUpdateType<Channels> }
  : Mode extends "debug"
  ? DebugOutput<Channels>
  : never;

export type StreamOutput<
  Mode extends StreamMode,
  Nodes extends NodesType,
  Channels extends ChannelsType
> = Mode extends SingleStreamMode
  ? SingleStreamModeOutput<Mode, Nodes, Channels>
  : Mode extends [SingleStreamMode]
  ? SingleStreamModeOutput<Mode[0], Nodes, Channels>
  : Mode extends [SingleStreamMode, SingleStreamMode]
  ? [
    SingleStreamModeOutput<Mode[0], Nodes, Channels>,
    SingleStreamModeOutput<Mode[1], Nodes, Channels>
  ]
  : Mode extends [SingleStreamMode, SingleStreamMode, SingleStreamMode]
  ? [
    SingleStreamModeOutput<Mode[0], Nodes, Channels>,
    SingleStreamModeOutput<Mode[1], Nodes, Channels>,
    SingleStreamModeOutput<Mode[2], Nodes, Channels>
  ]
  : never;

// Gross hack to avoid recursion limits & define the narrowest type that covers all possible stream output types
// This is what gets passed to the lower abstraction layers (such as `Runnable`) and the precise output type is
// narrowed at higher levels such as `StateGraph.stream()` to a specific one once the `StreamMode` is known
export type AllStreamOutputTypes<
  Nodes extends NodesType,
  Channels extends ChannelsType
> =
  | StreamOutput<["values"], Nodes, Channels>
  | StreamOutput<["updates"], Nodes, Channels>
  | StreamOutput<["debug"], Nodes, Channels>
  | StreamOutput<["values", "updates"], Nodes, Channels>
  | StreamOutput<["values", "values"], Nodes, Channels>
  | StreamOutput<["values", "debug"], Nodes, Channels>
  | StreamOutput<["updates", "updates"], Nodes, Channels>
  | StreamOutput<["updates", "values"], Nodes, Channels>
  | StreamOutput<["updates", "debug"], Nodes, Channels>
  | StreamOutput<["debug", "updates"], Nodes, Channels>
  | StreamOutput<["debug", "values"], Nodes, Channels>
  | StreamOutput<["debug", "debug"], Nodes, Channels>
  | StreamOutput<["updates", "updates", "updates"], Nodes, Channels>
  | StreamOutput<["updates", "updates", "values"], Nodes, Channels>
  | StreamOutput<["updates", "updates", "debug"], Nodes, Channels>
  | StreamOutput<["updates", "values", "updates"], Nodes, Channels>
  | StreamOutput<["updates", "values", "values"], Nodes, Channels>
  | StreamOutput<["updates", "values", "debug"], Nodes, Channels>
  | StreamOutput<["updates", "debug", "updates"], Nodes, Channels>
  | StreamOutput<["updates", "debug", "values"], Nodes, Channels>
  | StreamOutput<["updates", "debug", "debug"], Nodes, Channels>
  | StreamOutput<["values", "updates", "updates"], Nodes, Channels>
  | StreamOutput<["values", "updates", "values"], Nodes, Channels>
  | StreamOutput<["values", "updates", "debug"], Nodes, Channels>
  | StreamOutput<["values", "values", "updates"], Nodes, Channels>
  | StreamOutput<["values", "values", "values"], Nodes, Channels>
  | StreamOutput<["values", "values", "debug"], Nodes, Channels>
  | StreamOutput<["values", "debug", "updates"], Nodes, Channels>
  | StreamOutput<["values", "debug", "values"], Nodes, Channels>
  | StreamOutput<["values", "debug", "debug"], Nodes, Channels>
  | StreamOutput<["debug", "updates", "updates"], Nodes, Channels>
  | StreamOutput<["debug", "updates", "values"], Nodes, Channels>
  | StreamOutput<["debug", "updates", "debug"], Nodes, Channels>
  | StreamOutput<["debug", "values", "updates"], Nodes, Channels>
  | StreamOutput<["debug", "values", "values"], Nodes, Channels>
  | StreamOutput<["debug", "values", "debug"], Nodes, Channels>
  | StreamOutput<["debug", "debug", "updates"], Nodes, Channels>
  | StreamOutput<["debug", "debug", "values"], Nodes, Channels>
  | StreamOutput<["debug", "debug", "debug"], Nodes, Channels>;

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
