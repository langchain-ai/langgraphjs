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
  channelValues: Record<string, any>;
  /**
   * @default {}
   */
  channelVersions: Record<string, number>;
  /**
   * @default {}
   */
  versionsSeen: Record<string, Record<string, number>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function deepCopy(obj: any): any {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newObj: any = Array.isArray(obj) ? [] : {};

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      newObj[key] = deepCopy(obj[key]);
    }
  }

  return newObj;
}

export function emptyCheckpoint(): Checkpoint {
  return {
    v: 1,
    ts: new Date().toISOString(),
    channelValues: {},
    channelVersions: {},
    versionsSeen: {},
  };
}

export function copyCheckpoint(checkpoint: Checkpoint): Checkpoint {
  return {
    v: checkpoint.v,
    ts: checkpoint.ts,
    channelValues: { ...checkpoint.channelValues },
    channelVersions: { ...checkpoint.channelVersions },
    versionsSeen: deepCopy(checkpoint.versionsSeen),
  };
}

export const enum CheckpointAt {
  END_OF_STEP = "end_of_step",
  END_OF_RUN = "end_of_run",
}

export interface CheckpointTuple {
  config: RunnableConfig;
  checkpoint: Checkpoint;
  parentConfig?: RunnableConfig;
}

const CheckpointThreadId: ConfigurableFieldSpec = {
  id: "threadId",
  annotation: typeof "",
  name: "Thread ID",
  description: null,
  default: "",
  isShared: true,
  dependencies: null,
};

const CheckpointThreadTs: ConfigurableFieldSpec = {
  id: "threadTs",
  annotation: typeof "",
  name: "Thread Timestamp",
  description:
    "Pass to fetch a past checkpoint. If None, fetches the latest checkpoint.",
  default: null,
  isShared: true,
  dependencies: null,
};

export interface SerializerProtocol<D, L> {
  dumps(obj: D): L;
  loads(data: L): D;
}

export abstract class BaseCheckpointSaver<L> {
  at: CheckpointAt = CheckpointAt.END_OF_STEP;

  serde: SerializerProtocol<Checkpoint, L>;

  constructor(serde?: SerializerProtocol<Checkpoint, L>, at?: CheckpointAt) {
    this.serde = serde || this.serde;
    this.at = at || this.at;
  }

  get configSpecs(): Array<ConfigurableFieldSpec> {
    return [CheckpointThreadId, CheckpointThreadTs];
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
    checkpoint: Checkpoint
  ): Promise<RunnableConfig>;
}
