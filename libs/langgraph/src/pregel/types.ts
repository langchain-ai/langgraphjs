import type { Runnable, RunnableConfig } from "@langchain/core/runnables";
import type {
  All,
  PendingWrite,
  CheckpointMetadata,
  BaseCheckpointSaver,
  BaseStore,
  CheckpointListOptions,
} from "@langchain/langgraph-checkpoint";
import { Graph as DrawableGraph } from "@langchain/core/runnables/graph";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import type { BaseChannel } from "../channels/base.js";
import type { PregelNode } from "./read.js";
import { RetryPolicy } from "./utils/index.js";
import { Interrupt } from "../constants.js";
import { type ManagedValueSpec } from "../managed/base.js";
import { LangGraphRunnableConfig } from "./runnable_types.js";

/**
 * Selects the type of output you'll receive when streaming from the graph. See [Streaming](/langgraphjs/how-tos/#streaming) for more details.
 */
export type StreamMode = "values" | "updates" | "debug" | "messages" | "custom";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PregelInputType = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PregelOutputType = any;

/**
 * Config for executing the graph.
 */
export interface PregelOptions<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel | ManagedValueSpec>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ConfigurableFieldType extends Record<string, any> = Record<string, any>
> extends RunnableConfig<ConfigurableFieldType> {
  /**
   * The stream mode for the graph run. See [Streaming](/langgraphjs/how-tos/#streaming) for more details.
   * @default ["values"]
   */
  streamMode?: StreamMode | StreamMode[];
  /** The input keys to retrieve from the checkpoint on resume. You generally don't need to set this. */
  inputKeys?: keyof Cc | Array<keyof Cc>;
  /** The output keys to retrieve from the graph run. */
  outputKeys?: keyof Cc | Array<keyof Cc>;
  /** The nodes to interrupt the graph run before. */
  interruptBefore?: All | Array<keyof Nn>;
  /** The nodes to interrupt the graph run after. */
  interruptAfter?: All | Array<keyof Nn>;
  /** Enable debug mode for the graph run. */
  debug?: boolean;
  /** Whether to stream subgraphs. */
  subgraphs?: boolean;
  /** The shared value store */
  store?: BaseStore;
}

/**
 * Construct a type with a set of properties K of type T
 */
type StrRecord<K extends string, T> = {
  [P in K]: T;
};

export interface PregelInterface<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel | ManagedValueSpec>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ConfigurableFieldType extends Record<string, any> = StrRecord<string, any>
> {
  lg_is_pregel: boolean;

  withConfig(config: RunnableConfig): PregelInterface<Nn, Cc>;

  getGraphAsync(
    config: RunnableConfig & { xray?: boolean | number }
  ): Promise<DrawableGraph>;

  /** @deprecated Use getSubgraphsAsync instead. The async method will become the default in the next minor release. */
  getSubgraphs(
    namespace?: string,
    recurse?: boolean
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Generator<[string, PregelInterface<any, any>]>;

  getSubgraphsAsync(
    namespace?: string,
    recurse?: boolean
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): AsyncGenerator<[string, PregelInterface<any, any>]>;

  getState(
    config: RunnableConfig,
    options?: { subgraphs?: boolean }
  ): Promise<StateSnapshot>;

  getStateHistory(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncIterableIterator<StateSnapshot>;

  updateState(
    inputConfig: LangGraphRunnableConfig,
    values: Record<string, unknown> | unknown,
    asNode?: keyof Nn | string
  ): Promise<RunnableConfig>;

  stream(
    input: PregelInputType,
    options?: Partial<PregelOptions<Nn, Cc, ConfigurableFieldType>>
  ): Promise<IterableReadableStream<PregelOutputType>>;

  invoke(
    input: PregelInputType,
    options?: Partial<PregelOptions<Nn, Cc, ConfigurableFieldType>>
  ): Promise<PregelOutputType>;
}

/**
 * Parameters for creating a Pregel graph.
 * @internal
 */
export type PregelParams<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel | ManagedValueSpec>
> = {
  /**
   * The name of the graph. @see {@link Runnable.name}
   */
  name?: string;

  /**
   * The nodes in the graph.
   */
  nodes: Nn;

  /**
   * The channels in the graph.
   */
  channels: Cc;

  /**
   * Whether to validate the graph.
   *
   * @default true
   */
  autoValidate?: boolean;

  /**
   * The stream mode for the graph run. See [Streaming](/langgraphjs/how-tos/#streaming) for more details.
   *
   * @default ["values"]
   */
  streamMode?: StreamMode | StreamMode[];

  /**
   * The input channels for the graph run.
   */
  inputChannels: keyof Cc | Array<keyof Cc>;

  /**
   * The output channels for the graph run.
   */
  outputChannels: keyof Cc | Array<keyof Cc>;

  /**
   * After processing one of the nodes named in this list, the graph will be interrupted and a resume {@link Command} must be provided to proceed with the execution of this thread.
   * @default []
   */
  interruptAfter?: Array<keyof Nn> | All;

  /**
   * Before processing one of the nodes named in this list, the graph will be interrupted and a resume {@link Command} must be provided to proceed with the execution of this thread.
   * @default []
   */
  interruptBefore?: Array<keyof Nn> | All;

  /**
   * The channels to stream from the graph run.
   * @default []
   */
  streamChannels?: keyof Cc | Array<keyof Cc>;

  /**
   * @default undefined
   */
  stepTimeout?: number;

  /**
   * @default false
   */
  debug?: boolean;

  /**
   * The {@link BaseCheckpointSaver | checkpointer} to use for the graph run.
   */
  checkpointer?: BaseCheckpointSaver | false;

  /**
   * The default retry policy for this graph. For defaults, see {@link RetryPolicy}.
   */
  retryPolicy?: RetryPolicy;

  /**
   * The configuration for the graph run.
   */
  config?: LangGraphRunnableConfig;

  /**
   * Memory store to use for SharedValues.
   */
  store?: BaseStore;
};

export interface PregelTaskDescription {
  readonly id: string;
  readonly name: string;
  readonly error?: unknown;
  readonly interrupts: Interrupt[];
  readonly state?: LangGraphRunnableConfig | StateSnapshot;
  readonly path?: TaskPath;
}

export interface PregelExecutableTask<
  N extends PropertyKey,
  C extends PropertyKey
> {
  readonly name: N;
  readonly input: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly proc: Runnable<any, any, LangGraphRunnableConfig>;
  readonly writes: PendingWrite<C>[];
  readonly config?: LangGraphRunnableConfig;
  readonly triggers: Array<string>;
  readonly retry_policy?: RetryPolicy;
  readonly id: string;
  readonly path?: TaskPath;
  readonly subgraphs?: Runnable[];
  readonly writers: Runnable[];
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

export type PregelScratchpad<Resume = unknown> = {
  /** Counter for tracking call invocations */
  callCounter: number;
  /** Counter for tracking interrupts */
  interruptCounter: number;
  /** List of resume values */
  resume: Resume[];
  /** Single resume value for null task ID */
  nullResume: Resume;
};

export type CallOptions = {
  func: (...args: unknown[]) => unknown | Promise<unknown>;
  name: string;
  input: unknown;
  retry?: RetryPolicy;
  callbacks?: unknown;
};

export class Call {
  func: (...args: unknown[]) => unknown | Promise<unknown>;

  name: string;

  input: unknown;

  retry?: RetryPolicy;

  callbacks?: unknown;

  readonly __lg_type = "call";

  constructor({ func, name, input, retry, callbacks }: CallOptions) {
    this.func = func;
    this.name = name;
    this.input = input;
    this.retry = retry;

    this.callbacks = callbacks;
  }
}

export function isCall(value: unknown): value is Call {
  return (
    typeof value === "object" &&
    value !== null &&
    "__lg_type" in value &&
    value.__lg_type === "call"
  );
}

export type SimpleTaskPath = [string, string | number];
export type VariadicTaskPath = [string, ...(string | number)[]];
export type CallTaskPath =
  | [string, ...(string | number)[], Call]
  | [string, TaskPath, ...(string | number)[], Call];
export type TaskPath = SimpleTaskPath | CallTaskPath | VariadicTaskPath;
