import type { Message } from "./types.messages.js";
import type { Interrupt, Metadata, Config, ThreadTask } from "./schema.js";
/**
import type { SubgraphCheckpointsStreamEvent } from "./types.stream.subgraph.js";
 * Stream modes
 * - "values": Stream only the state values.
 * - "messages": Stream complete messages.
 * - "messages-tuple": Stream (message chunk, metadata) tuples.
 * - "updates": Stream updates to the state.
 * - "events": Stream events occurring during execution.
 * - "debug": Stream detailed debug information.
 * - "custom": Stream custom events.
 */
export type StreamMode =
  | "values"
  | "messages"
  | "updates"
  | "events"
  | "debug"
  | "tasks"
  | "checkpoints"
  | "custom"
  | "messages-tuple"
  | "tools";

export type ThreadStreamMode = "run_modes" | "lifecycle" | "state_update";

type MessageTupleMetadata = {
  tags: string[];
  [key: string]: unknown;
};

type AsSubgraph<TEvent extends { id?: string; event: string; data: unknown }> =
  {
    id?: TEvent["id"];
    event: TEvent["event"] | `${TEvent["event"]}|${string}`;
    data: TEvent["data"];
  };

/**
 * Stream event with values after completion of each step.
 */
export type ValuesStreamEvent<StateType> = {
  id?: string;
  event: "values";
  data: StateType;
};

/** @internal */
export type SubgraphValuesStreamEvent<StateType> = AsSubgraph<
  ValuesStreamEvent<StateType>
>;

/**
 * Stream event with message chunks coming from LLM invocations inside nodes.
 */
export type MessagesTupleStreamEvent = {
  event: "messages";
  // TODO: add types for message and config, which do not depend on LangChain
  // while making sure it's easy to keep them in sync.
  data: [message: Message, config: MessageTupleMetadata];
};

/** @internal */
export type SubgraphMessagesTupleStreamEvent =
  AsSubgraph<MessagesTupleStreamEvent>;

/**
 * Metadata stream event with information about the run and thread
 */
export type MetadataStreamEvent = {
  id?: string;
  event: "metadata";
  data: { run_id: string; thread_id: string };
};

/**
 * Stream event with error information.
 */
export type ErrorStreamEvent = {
  id?: string;
  event: "error";
  data: { error: string; message: string };
};

/** @internal */
export type SubgraphErrorStreamEvent = AsSubgraph<ErrorStreamEvent>;

/**
 * Stream event with updates to the state after each step.
 * The streamed outputs include the name of the node that
 * produced the update as well as the update.
 */
export type UpdatesStreamEvent<UpdateType> = {
  id?: string;
  event: "updates";
  data: { [node: string]: UpdateType };
};

/** @internal */
export type SubgraphUpdatesStreamEvent<UpdateType> = AsSubgraph<
  UpdatesStreamEvent<UpdateType>
>;

/**
 * Streaming custom data from inside the nodes.
 */
export type CustomStreamEvent<T> = { event: "custom"; data: T };

/** @internal */
export type SubgraphCustomStreamEvent<T> = AsSubgraph<CustomStreamEvent<T>>;

type MessagesMetadataStreamEvent = {
  id?: string;
  event: "messages/metadata";
  data: { [messageId: string]: { metadata: unknown } };
};
type MessagesCompleteStreamEvent = {
  id?: string;
  event: "messages/complete";
  data: Message[];
};
type MessagesPartialStreamEvent = {
  id?: string;
  event: "messages/partial";
  data: Message[];
};

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

export type TasksStreamEvent<StateType, UpdateType> =
  | TasksStreamCreateEvent<StateType>
  | TasksStreamResultEvent<UpdateType>
  | TasksStreamErrorEvent;

type SubgraphTasksStreamEvent<StateType, UpdateType> =
  | AsSubgraph<TasksStreamCreateEvent<StateType>>
  | AsSubgraph<TasksStreamResultEvent<UpdateType>>
  | AsSubgraph<TasksStreamErrorEvent>;

export type CheckpointsStreamEvent<StateType> = {
  id?: string;
  event: "checkpoints";
  data: {
    values: StateType;
    next: string[];
    config: Config;
    metadata: Metadata;
    tasks: ThreadTask[];
  };
};

type SubgraphCheckpointsStreamEvent<StateType> = AsSubgraph<
  CheckpointsStreamEvent<StateType>
>;

/**
 * Message stream event specific to LangGraph Server.
 * @deprecated Use `streamMode: "messages-tuple"` instead.
 */
export type MessagesStreamEvent =
  | MessagesMetadataStreamEvent
  | MessagesCompleteStreamEvent
  | MessagesPartialStreamEvent;

/** @internal */
export type SubgraphMessagesStreamEvent =
  | AsSubgraph<MessagesMetadataStreamEvent>
  | AsSubgraph<MessagesCompleteStreamEvent>
  | AsSubgraph<MessagesPartialStreamEvent>;

/**
 * Stream event with detailed debug information.
 */
export type DebugStreamEvent = { id?: string; event: "debug"; data: unknown };

/** @internal */
export type SubgraphDebugStreamEvent = AsSubgraph<DebugStreamEvent>;

/**
 * Stream event with events occurring during execution.
 */
export type EventsStreamEvent = {
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

/** @internal */
export type SubgraphEventsStreamEvent = AsSubgraph<EventsStreamEvent>;

/**
 * Stream event with a feedback key to signed URL map. Set `feedbackKeys` in
 * the `RunsStreamPayload` to receive this event.
 */
export type FeedbackStreamEvent = {
  id?: string;
  event: "feedback";
  data: { [feedbackKey: string]: string };
};

export type ToolsStreamEvent = {
  event: "tools";
  data: {
    event:
      | "on_tool_start"
      | "on_tool_partial"
      | "on_tool_end"
      | "on_tool_error";
    toolCallId?: string;
    name: string;
    input?: unknown;
    data?: unknown;
    output?: unknown;
    error?: unknown;
  };
};

export type ToolProgress = {
  toolCallId?: string;
  name: string;
  state: "starting" | "running" | "completed" | "error";
  input?: unknown;
  data?: unknown;
  result?: unknown;
  error?: unknown;
};

/** @internal */
export type SubgraphToolsStreamEvent = AsSubgraph<ToolsStreamEvent>;

type GetStreamModeMap<
  TStreamMode extends StreamMode | StreamMode[],
  TStateType = unknown,
  TUpdateType = TStateType,
  TCustomType = unknown
> =
  | {
      values: ValuesStreamEvent<TStateType>;
      updates: UpdatesStreamEvent<TUpdateType>;
      custom: CustomStreamEvent<TCustomType>;
      debug: DebugStreamEvent;
      messages: MessagesStreamEvent;
      "messages-tuple": MessagesTupleStreamEvent;
      tasks: TasksStreamEvent<TStateType, TUpdateType>;
      checkpoints: CheckpointsStreamEvent<TStateType>;
      events: EventsStreamEvent;
      tools: ToolsStreamEvent;
    }[TStreamMode extends StreamMode[] ? TStreamMode[number] : TStreamMode]
  | ErrorStreamEvent
  | MetadataStreamEvent
  | FeedbackStreamEvent;

type GetSubgraphsStreamModeMap<
  TStreamMode extends StreamMode | StreamMode[],
  TStateType = unknown,
  TUpdateType = TStateType,
  TCustomType = unknown
> =
  | {
      values: SubgraphValuesStreamEvent<TStateType>;
      updates: SubgraphUpdatesStreamEvent<TUpdateType>;
      custom: SubgraphCustomStreamEvent<TCustomType>;
      debug: SubgraphDebugStreamEvent;
      messages: SubgraphMessagesStreamEvent;
      "messages-tuple": SubgraphMessagesTupleStreamEvent;
      events: SubgraphEventsStreamEvent;
      tasks: SubgraphTasksStreamEvent<TStateType, TUpdateType>;
      checkpoints: SubgraphCheckpointsStreamEvent<TStateType>;
      tools: SubgraphToolsStreamEvent;
    }[TStreamMode extends StreamMode[] ? TStreamMode[number] : TStreamMode]
  | SubgraphErrorStreamEvent
  | MetadataStreamEvent
  | FeedbackStreamEvent;

export type TypedAsyncGenerator<
  TStreamMode extends StreamMode | StreamMode[] = [],
  TSubgraphs extends boolean = false,
  TStateType = unknown,
  TUpdateType = TStateType,
  TCustomType = unknown
> = AsyncGenerator<
  TSubgraphs extends true
    ? GetSubgraphsStreamModeMap<
        TStreamMode,
        TStateType,
        TUpdateType,
        TCustomType
      >
    : GetStreamModeMap<TStreamMode, TStateType, TUpdateType, TCustomType>
>;
