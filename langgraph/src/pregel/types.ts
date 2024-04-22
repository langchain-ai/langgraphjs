import { Runnable, RunnableConfig } from "@langchain/core/runnables";

export interface PregelTaskDescription {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
}

export interface PregelExecutableTask {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  proc: Runnable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writes: Array<[string, any]>; // TODO: Array type may need to be changed
  config: RunnableConfig | undefined;
}

export interface StateSnapshot {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /**
   * Current values of channels
   */
  values: Record<string, any> | any;
  /**
   * Nodes to execute in the next step, if any
   */
  next: [string];
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
