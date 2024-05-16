import { Runnable, RunnableConfig } from "@langchain/core/runnables";

export interface PregelTaskDescription {
  name: string;
  input: unknown;
}

export interface PregelExecutableTask<
  N extends PropertyKey,
  C extends PropertyKey
> {
  name: N;
  input: unknown;
  proc: Runnable;
  writes: Array<[C, unknown]>;
  config: RunnableConfig | undefined;
}

export interface StateSnapshot {
  /**
   * Current values of channels
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: Record<string, any> | any;
  /**
   * Nodes to execute in the next step, if any
   */
  next: Array<string>;
  /**
   * Config used to fetch this snapshot
   */
  config: RunnableConfig;
  /**
   * Config used to fetch the parent snapshot, if any
   * @default undefined
   */
  parentConfig?: RunnableConfig | undefined;
}

export type All = "*";
