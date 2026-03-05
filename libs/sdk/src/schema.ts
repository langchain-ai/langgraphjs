import type { JSONSchema7 } from "json-schema";

type Optional<T> = T | null | undefined;

export type RunStatus =
  | "pending"
  | "running"
  | "error"
  | "success"
  | "timeout"
  | "interrupted";

export type ThreadStatus = "idle" | "busy" | "interrupted" | "error";

type MultitaskStrategy = "reject" | "interrupt" | "rollback" | "enqueue";

export type CancelAction = "interrupt" | "rollback";

export type Config = {
  /**
   * Tags for this call and any sub-calls (eg. a Chain calling an LLM).
   * You can use these to filter calls.
   */
  tags?: string[];

  /**
   * Maximum number of times a call can recurse.
   * If not provided, defaults to 25.
   */
  recursion_limit?: number;

  /**
   * Runtime values for attributes previously made configurable on this Runnable.
   */
  configurable?: {
    /**
     * ID of the thread
     */
    thread_id?: Optional<string>;

    /**
     * Timestamp of the state checkpoint
     */
    checkpoint_id?: Optional<string>;

    [key: string]: unknown;
  };
};

export interface GraphSchema {
  /**
   * The ID of the graph.
   */
  graph_id: string;

  /**
   * The schema for the input state.
   * Missing if unable to generate JSON schema from graph.
   */
  input_schema?: JSONSchema7 | null | undefined;

  /**
   * The schema for the output state.
   * Missing if unable to generate JSON schema from graph.
   */
  output_schema?: JSONSchema7 | null | undefined;

  /**
   * The schema for the graph state.
   * Missing if unable to generate JSON schema from graph.
   */
  state_schema?: JSONSchema7 | null | undefined;

  /**
   * The schema for the graph config.
   * Missing if unable to generate JSON schema from graph.
   */
  config_schema?: JSONSchema7 | null | undefined;

  /**
   * The schema for the graph context.
   * Missing if unable to generate JSON schema from graph.
   */
  context_schema?: JSONSchema7 | null | undefined;
}

export type Subgraphs = Record<string, GraphSchema>;

export type Metadata = Optional<{
  source?: "input" | "loop" | "update" | (string & {}); // eslint-disable-line @typescript-eslint/ban-types

  step?: number;

  writes?: Record<string, unknown> | null;

  parents?: Record<string, string>;

  [key: string]: unknown;
}>;

export interface AssistantBase {
  /** The ID of the assistant. */
  assistant_id: string;

  /** The ID of the graph. */
  graph_id: string;

  /** The assistant config. */
  config: Config;

  /** The assistant context. */
  context: unknown;

  /** The time the assistant was created. */
  created_at: string;

  /** The assistant metadata. */
  metadata: Metadata;

  /** The version of the assistant. */
  version: number;

  /** The name of the assistant */
  name: string;

  /** The description of the assistant */
  description?: string;
}

export interface AssistantVersion extends AssistantBase {}

export interface Assistant extends AssistantBase {
  /** The last time the assistant was updated. */
  updated_at: string;
}

export interface AssistantsSearchResponse {
  /** The assistants returned for the current search page. */
  assistants: Assistant[];
  /** Pagination cursor from the X-Pagination-Next response header. */
  next: string | null;
}

export interface AssistantGraph {
  nodes: Array<{
    id: string | number;
    name?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data?: Record<string, any> | string;
    metadata?: unknown;
  }>;
  edges: Array<{
    source: string;
    target: string;
    data?: string;
    conditional?: boolean;
  }>;
}

/**
 * An interrupt thrown inside a thread.
 */
export interface Interrupt<TValue = unknown> {
  /**
   * The ID of the interrupt.
   */
  id?: string;

  /**
   * The value of the interrupt.
   */
  value?: TValue;

  /**
   * Will be deprecated in the future.
   * @deprecated Will be removed in the future.
   */
  when?: "during" | (string & {}); // eslint-disable-line @typescript-eslint/ban-types

  /**
   * Whether the interrupt can be resumed.
   * @deprecated Will be removed in the future.
   */
  resumable?: boolean;

  /**
   * The namespace of the interrupt.
   * @deprecated Replaced by `interrupt_id`
   */
  ns?: string[];
}

export interface Thread<ValuesType = DefaultValues, TInterruptValue = unknown> {
  /** The ID of the thread. */
  thread_id: string;

  /** The time the thread was created. */
  created_at: string;

  /** The last time the thread was updated. */
  updated_at: string;

  /** The last time the thread state was updated. */
  state_updated_at: string;

  /** The thread metadata. */
  metadata: Metadata;

  /** The status of the thread */
  status: ThreadStatus;

  /** The current state of the thread. */
  values: ValuesType;

  /** Interrupts which were thrown in this thread */
  interrupts: Record<string, Array<Interrupt<TInterruptValue>>>;

  /** The config for the thread */
  config?: Config;

  /** The error for the thread (if status == "error") */
  error?: Optional<string | Record<string, unknown>>;

  /** Extracted values from thread data. Only present when `extract` is used in search. */
  extracted?: Record<string, unknown>;
}

export interface Cron {
  /** The ID of the cron */
  cron_id: string;

  /** The ID of the assistant */
  assistant_id: string;

  /** The ID of the thread */
  thread_id: Optional<string>;

  /** What to do with the thread after the run completes. Only applicable for stateless crons. */
  on_run_completed?: "delete" | "keep";

  /** The end date to stop running the cron. */
  end_time: Optional<string>;

  /** The schedule to run, cron format. Schedules are interpreted in UTC. */
  schedule: string;

  /** The time the cron was created. */
  created_at: string;

  /** The last time the cron was updated. */
  updated_at: string;

  /** The run payload to use for creating new run. */
  payload: Record<string, unknown>;

  /** The user ID of the cron */
  user_id: Optional<string>;

  /** The next run date of the cron */
  next_run_date: Optional<string>;

  /** The metadata of the cron */
  metadata: Record<string, unknown>;

  /** Whether the cron is enabled */
  enabled: boolean;
}

export type DefaultValues = Record<string, unknown>[] | Record<string, unknown>;

export type ThreadValuesFilter = Record<string, unknown>;

export interface ThreadState<ValuesType = DefaultValues> {
  /** The state values */
  values: ValuesType;

  /** The next nodes to execute. If empty, the thread is done until new input is received */
  next: string[];

  /** Checkpoint of the thread state */
  checkpoint: Checkpoint;

  /** Metadata for this state */
  metadata: Metadata;

  /** Time of state creation  */
  created_at: Optional<string>;

  /** The parent checkpoint. If missing, this is the root checkpoint */
  parent_checkpoint: Optional<Checkpoint>;

  /** Tasks to execute in this step. If already attempted, may contain an error */
  tasks: Array<ThreadTask>;
}

export interface ThreadTask<
  ValuesType = DefaultValues,
  TInterruptValue = unknown
> {
  id: string;
  name: string;
  result?: unknown;
  error: Optional<string>;
  interrupts: Array<Interrupt<TInterruptValue>>;
  checkpoint: Optional<Checkpoint>;
  state: Optional<ThreadState<ValuesType>>;
}

export interface Run {
  /** The ID of the run */
  run_id: string;

  /** The ID of the thread */
  thread_id: string;

  /** The assistant that wwas used for this run */
  assistant_id: string;

  /** The time the run was created */
  created_at: string;

  /** The last time the run was updated */
  updated_at: string;

  /** The status of the run. */
  status: RunStatus;

  /** Run metadata */
  metadata: Metadata;

  /** Strategy to handle concurrent runs on the same thread */
  multitask_strategy: Optional<MultitaskStrategy>;
}

export type Checkpoint = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: Optional<string>;
  checkpoint_map: Optional<Record<string, unknown>>;
};

export interface ListNamespaceResponse {
  namespaces: string[][];
}
export interface Item {
  namespace: string[];
  key: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface SearchItem extends Item {
  score?: number;
}
export interface SearchItemsResponse {
  items: SearchItem[];
}

export interface CronCreateResponse {
  cron_id: string;
  assistant_id: string;
  thread_id: string | undefined;
  user_id: string;
  payload: Record<string, unknown>;
  schedule: string;
  next_run_date: string;
  end_time: string | undefined;
  created_at: string;
  updated_at: string;
  metadata: Metadata;
}

export interface CronCreateForThreadResponse
  extends Omit<CronCreateResponse, "thread_id"> {
  thread_id: string;
}

export type AssistantSortBy =
  | "assistant_id"
  | "graph_id"
  | "name"
  | "created_at"
  | "updated_at";

export type ThreadSortBy =
  | "thread_id"
  | "status"
  | "created_at"
  | "updated_at"
  | "state_updated_at";

export type CronSortBy =
  | "cron_id"
  | "assistant_id"
  | "thread_id"
  | "created_at"
  | "updated_at"
  | "next_run_date";

export type SortOrder = "asc" | "desc";

// Select field aliases for client-side typing of `select` parameters.
// These mirror the server's allowed field sets.

export type AssistantSelectField =
  | "assistant_id"
  | "graph_id"
  | "name"
  | "description"
  | "config"
  | "context"
  | "created_at"
  | "updated_at"
  | "metadata"
  | "version";

export type ThreadSelectField =
  | "thread_id"
  | "created_at"
  | "updated_at"
  | "state_updated_at"
  | "metadata"
  | "config"
  | "context"
  | "status"
  | "values"
  | "interrupts";

export type RunSelectField =
  | "run_id"
  | "thread_id"
  | "assistant_id"
  | "created_at"
  | "updated_at"
  | "status"
  | "metadata"
  | "kwargs"
  | "multitask_strategy";

export type CronSelectField =
  | "cron_id"
  | "assistant_id"
  | "thread_id"
  | "end_time"
  | "schedule"
  | "created_at"
  | "updated_at"
  | "user_id"
  | "payload"
  | "next_run_date"
  | "metadata"
  | "now";
