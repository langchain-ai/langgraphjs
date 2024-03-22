import { RunnableConfig } from "@langchain/core/runnables";

/** A field that can be configured by the user. It is a specification of a field. */
export interface ConfigurableFieldSpec {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  annotation: any;
  name: string | null;
  description: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: any;
  /**
   * @default false
   */
  isShared?: boolean;
  dependencies: Array<string> | null;
}

export interface Checkpoint<C extends object, N extends string> {
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
  channelValues: C;
  /**
   * @default {}
   */
  channelVersions: Record<keyof C, number>;
  /**
   * @default {}
   */
  versionsSeen: Record<N, Record<keyof C, number>>;
}

const checkpoint: Checkpoint<
  {
    total: string;
    input: string;
    output: string;
  },
  'addOne' | 'addTwo'
  > = {
  v: 1,
  ts: new Date().toISOString(),
  channelValues: {
    total: 'a',
    input: 'b',
    output: 'c'
  },
  channelVersions: {
    total: 1,
    input: 1,
    output: 1
  },
  versionsSeen: {
    addOne: {
      total: 1,
      input: 1,
      output: 1
    },
    addTwo: {
      total: 1,
      input: 1,
      output: 1
    }
  }
  }

  console.log(checkpoint)


export function emptyCheckpoint<C extends object, N extends string>(): Checkpoint<C, N> {
  return {
    v: 1,
    ts: new Date().toISOString(),
    channelValues: {} as C,
    channelVersions: {} as Record<keyof C, number>,
    versionsSeen: {} as Record<N, Record<keyof C, number>>,
  };
}

export const enum CheckpointAt {
  END_OF_STEP = "end_of_step",
  END_OF_RUN = "end_of_run",
}

export abstract class BaseCheckpointSaver<C extends object, N extends string> {
  at: CheckpointAt = CheckpointAt.END_OF_RUN;

  get configSpecs(): Array<ConfigurableFieldSpec> {
    return [];
  }

  abstract get(config: RunnableConfig): Checkpoint<C, N> | undefined;

  abstract put(config: RunnableConfig, checkpoint: Checkpoint<C, N>): void;
}
