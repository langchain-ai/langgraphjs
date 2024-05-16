import { Runnable, RunnableConfig } from "@langchain/core/runnables";
import { CheckpointMetadata } from "../checkpoint/base.js";

export interface PregelTaskDescription {
  readonly name: string;
  readonly input: unknown;
}

export interface PregelExecutableTask<
  N extends PropertyKey,
  C extends PropertyKey
> {
  readonly name: N;
  readonly input: unknown;
  readonly proc: Runnable;
  readonly writes: Array<[C, unknown]>;
  readonly config: RunnableConfig | undefined;
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
   * Config used to fetch the parent snapshot, if any
   * @default undefined
   */
  readonly parentConfig?: RunnableConfig | undefined;
}

export type All = "*";
