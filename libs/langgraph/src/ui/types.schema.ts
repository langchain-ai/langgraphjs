import type { SerializedMessage } from "./types.message.js";

type Optional<T> = T | null | undefined;

type MessageTupleMetadata = {
  tags: string[];
  [key: string]: unknown;
};

type DefaultValues = Record<string, unknown>[] | Record<string, unknown>;

interface ThreadState<ValuesType = DefaultValues> {
  /** The state values */
  values: ValuesType;

  /** The next nodes to execute. If empty, the thread is done until new input is received */
  next: string[];

  /** Checkpoint of the thread state */
  checkpoint: Checkpoint;

  /** Metadata for this state */
  metadata: CheckpointMetadata;

  /** Time of state creation  */
  created_at: Optional<string>;

  /** The parent checkpoint. If missing, this is the root checkpoint */
  parent_checkpoint: Optional<Checkpoint>;

  /** Tasks to execute in this step. If already attempted, may contain an error */
  tasks: Array<ThreadTask>;
}

interface ThreadTask {
  id: string;
  name: string;
  result?: unknown;
  error: Optional<string>;
  interrupts: Array<Interrupt>;
  checkpoint: Optional<Checkpoint>;
  state: Optional<ThreadState>;
}

type Config = {
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

type CheckpointMetadata = Optional<{
  source?: "input" | "loop" | "update" | (string & {}); // eslint-disable-line @typescript-eslint/ban-types
  step?: number;
  writes?: Record<string, unknown> | null;
  parents?: Record<string, string>;
  [key: string]: unknown;
}>;

interface Checkpoint {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: Optional<string>;
  checkpoint_map: Optional<Record<string, unknown>>;
}

/**
 * An interrupt thrown inside a thread.
 */
interface Interrupt<TValue = unknown> {
  /**
   * The ID of the interrupt.
   */
  id?: string;

  /**
   * The value of the interrupt.
   */
  value?: TValue;
}

type AsSubgraph<TEvent extends { id?: string; event: string; data: unknown }> =
  {
    id?: TEvent["id"];
    event: TEvent["event"] | `${TEvent["event"]}|${string}`;
    data: TEvent["data"];
  };

/**
 * Stream event with values after completion of each step.
 */
type ValuesStreamEvent<StateType> = AsSubgraph<{
  id?: string;
  event: "values";
  data: StateType;
}>;

/**
 * Stream event with message chunks coming from LLM invocations inside nodes.
 */
type MessagesTupleStreamEvent = AsSubgraph<{
  id?: string;
  event: "messages";
  // TODO: add types for message and config, which do not depend on LangChain
  // while making sure it's easy to keep them in sync.
  data: [message: SerializedMessage.AnyMessage, config: MessageTupleMetadata];
}>;

/**
 * Metadata stream event with information about the run and thread
 */
type MetadataStreamEvent = {
  id?: string;
  event: "metadata";
  data: { run_id: string; thread_id: string };
};

/**
 * Stream event with error information.
 */
type SubgraphErrorStreamEvent = AsSubgraph<{
  id?: string;
  event: "error";
  data: { error: string; message: string };
}>;

/**
 * Stream event with updates to the state after each step.
 * The streamed outputs include the name of the node that
 * produced the update as well as the update.
 */
type UpdatesStreamEvent<UpdateType, NodeReturnType> = AsSubgraph<{
  id?: string;
  event: "updates";
  data: NodeReturnType extends Record<string, unknown>
    ? { [K in keyof NodeReturnType]?: NodeReturnType[K] } & {
        [node: string]: UpdateType;
      }
    : Record<string, UpdateType>;
}>;

/**
 * Streaming custom data from inside the nodes.
 */
type CustomStreamEvent<T> = AsSubgraph<{
  id?: string;
  event: "custom";
  data: T;
}>;

type TasksStreamCreateEvent<StateType> = {
  id?: string;
  event: "tasks";
  data: {
    id: string;
    name: string;
    interrupts: Interrupt[];
    input: StateType;
    triggers: string[];
  };
};

type TasksStreamResultEvent<UpdateType> = {
  id?: string;
  event: "tasks";
  data: {
    id: string;
    name: string;
    interrupts: Interrupt[];
    result: [string, UpdateType][];
  };
};

type TasksStreamErrorEvent = {
  id?: string;
  event: "tasks";
  data: {
    id: string;
    name: string;
    interrupts: Interrupt[];
    error: string;
  };
};

type TasksStreamEvent<StateType, UpdateType> =
  | AsSubgraph<TasksStreamCreateEvent<StateType>>
  | AsSubgraph<TasksStreamResultEvent<UpdateType>>
  | AsSubgraph<TasksStreamErrorEvent>;

type CheckpointsStreamEvent<StateType> = AsSubgraph<{
  id?: string;
  event: "checkpoints";
  data: {
    values: StateType;
    next: string[];
    config: Config;
    metadata: CheckpointMetadata;
    tasks: ThreadTask[];
  };
}>;

/**
 * Stream event with detailed debug information.
 */
type DebugStreamEvent = AsSubgraph<{
  id?: string;
  event: "debug";
  data: unknown;
}>;

/**
 * Stream event with events occurring during execution.
 */
type EventsStreamEvent = {
  id?: string;
  event: "events";
  data: {
    event:
      | `on_${
          | "chat_model"
          | "llm"
          | "chain"
          | "tool"
          | "retriever"
          | "prompt"}_${"start" | "stream" | "end"}`
      | (string & {}); // eslint-disable-line @typescript-eslint/ban-types
    name: string;
    tags: string[];
    run_id: string;
    metadata: Record<string, unknown>;
    parent_ids: string[];
    data: unknown;
  };
};

export type LangGraphEventStream<
  TStateType = unknown,
  TUpdateType = TStateType,
  TCustomType = unknown,
  TNodeReturnType = unknown
> =
  | ValuesStreamEvent<TStateType>
  | UpdatesStreamEvent<TUpdateType, TNodeReturnType>
  | CustomStreamEvent<TCustomType>
  | DebugStreamEvent
  | MessagesTupleStreamEvent
  | EventsStreamEvent
  | TasksStreamEvent<TStateType, TUpdateType>
  | CheckpointsStreamEvent<TStateType>
  | SubgraphErrorStreamEvent
  | MetadataStreamEvent;
