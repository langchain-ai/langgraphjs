import type { Client, ClientConfig } from "../client.js";

import type {
  ThreadState,
  Config,
  Checkpoint,
  Metadata,
} from "../schema.js";
import type {
  Command,
  MultitaskStrategy,
  OnCompletionBehavior,
  DisconnectMode,
  Durability,
} from "../types.js";
import type {
  UpdatesStreamEvent,
  CustomStreamEvent,
  MetadataStreamEvent,
  EventsStreamEvent,
  DebugStreamEvent,
  CheckpointsStreamEvent,
  TasksStreamEvent,
  StreamMode,
} from "../types.stream.js";
import type { DefaultToolCall } from "../types.messages.js";

// ============================================================================
// Agent Type Extraction Helpers
// ============================================================================
// These types enable extracting type information from a ReactAgent instance
// created with `createAgent` from @langchain/langgraph, without requiring
// langchain as a dependency.

/**
 * Minimal interface matching the structure of AgentTypeConfig from @langchain/langgraph.
 * This allows type inference from ReactAgent without requiring the langchain dependency.
 */
export interface AgentTypeConfigLike {
  Response: unknown;
  State: unknown;
  Context: unknown;
  Middleware: unknown;
  Tools: unknown;
}

/**
 * Check if a type is agent-like (has `__agentTypes` phantom property).
 * This property is present on `ReactAgent` instances created with `createAgent`.
 */
export type IsAgentLike<T> = T extends { __agentTypes: AgentTypeConfigLike }
  ? true
  : false;

/**
 * Extract the AgentTypeConfig from an agent-like type.
 *
 * @example
 * ```ts
 * const agent = createAgent({ ... });
 * type Config = ExtractAgentConfig<typeof agent>;
 * // Config is the AgentTypeConfig with Response, State, Context, Middleware, Tools
 * ```
 */
export type ExtractAgentConfig<T> = T extends { __agentTypes: infer Config }
  ? Config extends AgentTypeConfigLike
    ? Config
    : never
  : never;

/**
 * Extract a tool call type from a single tool.
 * Works with tools created via `tool()` from `@langchain/core/tools`.
 *
 * This extracts the literal name type from DynamicStructuredTool's NameT parameter
 * and the args type from the schema's _input property.
 */
type ToolCallFromAgentTool<T> = T extends { name: infer N; schema: infer S }
  ? N extends string
    ? S extends { _input: infer Args }
      ? { name: N; args: Args; id?: string; type?: "tool_call" }
      : never
    : never
  : never;

/**
 * Extract tool calls type from an agent's tools.
 * Converts the tools array to a discriminated union of tool calls.
 *
 * This handles both tuple types (e.g., `readonly [Tool1, Tool2]`) and
 * array-of-union types (e.g., `readonly (Tool1 | Tool2)[]`) which is how
 * `createAgent` captures tool types.
 *
 * @example
 * ```ts
 * const agent = createAgent({ tools: [getWeather, search], ... });
 * type ToolCalls = InferAgentToolCalls<typeof agent>;
 * // ToolCalls is:
 * // | { name: "get_weather"; args: { location: string }; id?: string }
 * // | { name: "search"; args: { query: string }; id?: string }
 * ```
 */
export type InferAgentToolCalls<T> =
  ExtractAgentConfig<T>["Tools"] extends readonly (infer Tool)[]
    ? ToolCallFromAgentTool<Tool> extends never
      ? DefaultToolCall
      : ToolCallFromAgentTool<Tool>
    : DefaultToolCall;

/**
 * Convert an agent type to the Bag template expected by `useStream`.
 * Maps the agent's type configuration to the useStream Bag parameters.
 *
 * @example
 * ```ts
 * const agent = createAgent({ tools: [getWeather, search], ... });
 * type Bag = AgentToBag<typeof agent>;
 * // Use with useStream: useStream<AgentState, Bag>({ ... })
 * ```
 */
export type AgentToBag<T> = {
  ToolCallsType: InferAgentToolCalls<T>;
  ConfigurableType?: Record<string, unknown>;
  InterruptType?: unknown;
  CustomEventType?: unknown;
  UpdateType?: unknown;
};

export type MessageMetadata<StateType extends Record<string, unknown>> = {
  /**
   * The ID of the message used.
   */
  messageId: string;

  /**
   * The first thread state the message was seen in.
   */
  firstSeenState: ThreadState<StateType> | undefined;

  /**
   * The branch of the message.
   */
  branch: string | undefined;

  /**
   * The list of branches this message is part of.
   * This is useful for displaying branching controls.
   */
  branchOptions: string[] | undefined;

  /**
   * Metadata sent alongside the message during run streaming.
   * @remarks This metadata only exists temporarily in browser memory during streaming and is not persisted after completion.
   */
  streamMetadata: Record<string, unknown> | undefined;
};

export type BagTemplate = {
  ConfigurableType?: Record<string, unknown>;
  InterruptType?: unknown;
  CustomEventType?: unknown;
  UpdateType?: unknown;
  /**
   * Type for tool calls. Provide a discriminated union for type-safe tool handling.
   *
   * @example
   * ```ts
   * type MyToolCalls =
   *   | { name: "get_weather"; args: { location: string }; id?: string }
   *   | { name: "search"; args: { query: string }; id?: string };
   *
   * useStream<MyState, { ToolCallsType: MyToolCalls }>({ ... });
   * ```
   */
  ToolCallsType?: unknown;
};

export type GetUpdateType<
  Bag extends BagTemplate,
  StateType extends Record<string, unknown>
> = Bag extends { UpdateType: unknown }
  ? Bag["UpdateType"]
  : Partial<StateType>;

export type GetConfigurableType<Bag extends BagTemplate> = Bag extends {
  ConfigurableType: Record<string, unknown>;
}
  ? Bag["ConfigurableType"]
  : Record<string, unknown>;

export type GetInterruptType<Bag extends BagTemplate> = Bag extends {
  InterruptType: unknown;
}
  ? Bag["InterruptType"]
  : unknown;

export type GetCustomEventType<Bag extends BagTemplate> = Bag extends {
  CustomEventType: unknown;
}
  ? Bag["CustomEventType"]
  : unknown;

export type GetToolCallsType<Bag extends BagTemplate> = Bag extends {
  ToolCallsType: unknown;
}
  ? Bag["ToolCallsType"]
  : DefaultToolCall;

export interface RunCallbackMeta {
  run_id: string;
  thread_id: string;
}

export interface UseStreamThread<StateType extends Record<string, unknown>> {
  data: ThreadState<StateType>[] | null | undefined;
  error: unknown;
  isLoading: boolean;
  mutate: (
    mutateId?: string
  ) => Promise<ThreadState<StateType>[] | null | undefined>;
}

export interface UseStreamOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  /**
   * The ID of the assistant to use.
   */
  assistantId: string;

  /**
   * Client used to send requests.
   */
  client?: Client;

  /**
   * The URL of the API to use.
   */
  apiUrl?: ClientConfig["apiUrl"];

  /**
   * The API key to use.
   */
  apiKey?: ClientConfig["apiKey"];

  /**
   * Custom call options, such as custom fetch implementation.
   */
  callerOptions?: ClientConfig["callerOptions"];

  /**
   * Default headers to send with requests.
   */
  defaultHeaders?: ClientConfig["defaultHeaders"];

  /**
   * Specify the key within the state that contains messages.
   * Defaults to "messages".
   *
   * @default "messages"
   */
  messagesKey?: string;

  /**
   * Callback that is called when an error occurs.
   */
  onError?: (error: unknown, run: RunCallbackMeta | undefined) => void;

  /**
   * Callback that is called when the stream is finished.
   */
  onFinish?: (
    state: ThreadState<StateType>,
    run: RunCallbackMeta | undefined
  ) => void;

  /**
   * Callback that is called when a new stream is created.
   */
  onCreated?: (run: RunCallbackMeta) => void;

  /**
   * Callback that is called when an update event is received.
   */
  onUpdateEvent?: (
    data: UpdatesStreamEvent<GetUpdateType<Bag, StateType>>["data"],
    options: {
      namespace: string[] | undefined;
      mutate: (
        update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
      ) => void;
    }
  ) => void;

  /**
   * Callback that is called when a custom event is received.
   */
  onCustomEvent?: (
    data: CustomStreamEvent<GetCustomEventType<Bag>>["data"],
    options: {
      namespace: string[] | undefined;
      mutate: (
        update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
      ) => void;
    }
  ) => void;

  /**
   * Callback that is called when a metadata event is received.
   */
  onMetadataEvent?: (data: MetadataStreamEvent["data"]) => void;

  /**
   * Callback that is called when a LangChain event is received.
   * @see https://langchain-ai.github.io/langgraph/cloud/how-tos/stream_events/#stream-graph-in-events-mode for more details.
   */
  onLangChainEvent?: (data: EventsStreamEvent["data"]) => void;

  /**
   * Callback that is called when a debug event is received.
   * @internal This API is experimental and subject to change.
   */
  onDebugEvent?: (
    data: DebugStreamEvent["data"],
    options: { namespace: string[] | undefined }
  ) => void;

  /**
   * Callback that is called when a checkpoints event is received.
   */
  onCheckpointEvent?: (
    data: CheckpointsStreamEvent<StateType>["data"],
    options: { namespace: string[] | undefined }
  ) => void;

  /**
   * Callback that is called when a tasks event is received.
   */
  onTaskEvent?: (
    data: TasksStreamEvent<StateType, GetUpdateType<Bag, StateType>>["data"],
    options: { namespace: string[] | undefined }
  ) => void;

  /**
   * Callback that is called when the stream is stopped by the user.
   * Provides a mutate function to update the stream state immediately
   * without requiring a server roundtrip.
   *
   * @example
   * ```typescript
   * onStop: ({ mutate }) => {
   *   mutate((prev) => ({
   *     ...prev,
   *     ui: prev.ui?.map(component =>
   *       component.props.isLoading
   *         ? { ...component, props: { ...component.props, stopped: true, isLoading: false }}
   *         : component
   *     )
   *   }));
   * }
   * ```
   */
  onStop?: (options: {
    mutate: (
      update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
    ) => void;
  }) => void;

  /**
   * The ID of the thread to fetch history and current values from.
   */
  threadId?: string | null;

  /**
   * Callback that is called when the thread ID is updated (ie when a new thread is created).
   */
  onThreadId?: (threadId: string) => void;

  /** Will reconnect the stream on mount */
  reconnectOnMount?: boolean | (() => RunMetadataStorage);

  /**
   * Initial values to display immediately when loading a thread.
   * Useful for displaying cached thread data while official history loads.
   * These values will be replaced when official thread data is fetched.
   *
   * Note: UI components from initialValues will render immediately if they're
   * predefined in LoadExternalComponent's components prop, providing instant
   * cached UI display without server fetches.
   */
  initialValues?: StateType | null;

  /**
   * Whether to fetch the history of the thread.
   * If true, the history will be fetched from the server. Defaults to 10 entries.
   * If false, only the last state will be fetched from the server.
   * @default true
   */
  fetchStateHistory?: boolean | { limit: number };

  /**
   * Manage the thread state externally.
   */
  thread?: UseStreamThread<StateType>;

  /**
   * Throttle the stream.
   * If a number is provided, the stream will be throttled to the given number of milliseconds.
   * If `true`, updates are batched in a single macrotask.
   * If `false`, updates are not throttled or batched.
   * @default true
   */
  throttle?: number | boolean;
}

interface RunMetadataStorage {
  getItem(key: `lg:stream:${string}`): string | null;
  setItem(key: `lg:stream:${string}`, value: string): void;
  removeItem(key: `lg:stream:${string}`): void;
}

type ConfigWithConfigurable<ConfigurableType extends Record<string, unknown>> =
  Config & { configurable?: ConfigurableType };

export interface SubmitOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  ContextType extends Record<string, unknown> = Record<string, unknown>
> {
  config?: ConfigWithConfigurable<ContextType>;
  context?: ContextType;
  checkpoint?: Omit<Checkpoint, "thread_id"> | null;
  command?: Command;
  interruptBefore?: "*" | string[];
  interruptAfter?: "*" | string[];
  metadata?: Metadata;
  multitaskStrategy?: MultitaskStrategy;
  onCompletion?: OnCompletionBehavior;
  onDisconnect?: DisconnectMode;
  feedbackKeys?: string[];
  streamMode?: Array<StreamMode>;
  runId?: string;
  optimisticValues?:
    | Partial<StateType>
    | ((prev: StateType) => Partial<StateType>);

  /**
   * Whether or not to stream the nodes of any subgraphs called
   * by the assistant.
   * @default false
   */
  streamSubgraphs?: boolean;

  /**
   * Mark the stream as resumable. All events emitted during the run will be temporarily persisted
   * in order to be re-emitted if the stream is re-joined.
   * @default false
   */
  streamResumable?: boolean;

  /**
   * Whether to checkpoint during the run (or only at the end/interruption).
   * - `"async"`: Save checkpoint asynchronously while the next step executes (default).
   * - `"sync"`: Save checkpoint synchronously before the next step starts.
   * - `"exit"`: Save checkpoint only when the graph exits.
   * @default "async"
   */
  durability?: Durability;

  /**
   * The ID to use when creating a new thread. When provided, this ID will be used
   * for thread creation when threadId is `null` or `undefined`.
   * This enables optimistic UI updates where you know the thread ID
   * before the thread is actually created.
   */
  threadId?: string;
}

/**
 * Transport used to stream the thread.
 * Only applicable for custom endpoints using `toLangGraphEventStream` or `toLangGraphEventStreamResponse`.
 */
export interface UseStreamTransport<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  stream: (payload: {
    input: GetUpdateType<Bag, StateType> | null | undefined;
    context: GetConfigurableType<Bag> | undefined;
    command: Command | undefined;
    config: ConfigWithConfigurable<GetConfigurableType<Bag>> | undefined;
    signal: AbortSignal;
  }) => Promise<AsyncGenerator<{ id?: string; event: string; data: unknown }>>;
}

export type UseStreamCustomOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> = Pick<
  UseStreamOptions<StateType, Bag>,
  | "messagesKey"
  | "threadId"
  | "onThreadId"
  | "onError"
  | "onCreated"
  | "onUpdateEvent"
  | "onCustomEvent"
  | "onMetadataEvent"
  | "onLangChainEvent"
  | "onDebugEvent"
  | "onCheckpointEvent"
  | "onTaskEvent"
  | "onStop"
  | "initialValues"
  | "throttle"
> & { transport: UseStreamTransport<StateType, Bag> };

export type CustomSubmitOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  ConfigurableType extends Record<string, unknown> = Record<string, unknown>
> = Pick<
  SubmitOptions<StateType, ConfigurableType>,
  "optimisticValues" | "context" | "command" | "config"
>;

