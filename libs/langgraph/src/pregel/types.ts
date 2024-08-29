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

export type StreamMode = "values" | "updates" | "debug";

/**
 * Construct a type with a set of properties K of type T
 */
type StrRecord<K extends string, T> = {
  [P in K]: T;
};

export interface PregelInterface<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
> {
  nodes: Nn;

  channels: Cc;

  /**
   * @default true
   */
  autoValidate?: boolean;

  /**
   * @default "values"
   */
  streamMode?: StreamMode | StreamMode[];

  inputChannels: keyof Cc | Array<keyof Cc>;

  outputChannels: keyof Cc | Array<keyof Cc>;

  /**
   * @default []
   */
  interruptAfter?: Array<keyof Nn> | All;

  /**
   * @default []
   */
  interruptBefore?: Array<keyof Nn> | All;

  streamChannels?: keyof Cc | Array<keyof Cc>;

  get streamChannelsAsIs(): keyof Cc | Array<keyof Cc>;

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
}

export type PregelParams<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
> = Omit<PregelInterface<Nn, Cc>, "streamChannelsAsIs">;

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
