import type { InferInteropZodInput } from "@langchain/core/utils/types";

import type { Client, ClientConfig } from "../client.js";
import type { ThreadState, Config, Checkpoint, Metadata } from "../schema.js";
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
import type { DefaultToolCall, AIMessage, Message } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";

/**
 * Represents a tool call that initiated a subagent.
 */
export interface SubagentToolCall {
  /** The tool call ID */
  id: string;
  /** The name of the tool (typically "task") */
  name: string;
  /** The arguments passed to the tool */
  args: {
    /** The task description for the subagent */
    description?: string;
    /** The type of subagent to use */
    subagent_type?: string;
    /** Additional custom arguments */
    [key: string]: unknown;
  };
}

/**
 * The execution status of a subagent.
 */
export type SubagentStatus = "pending" | "running" | "complete" | "error";

/**
 * Represents a single subagent execution.
 * Tracks the lifecycle of a subagent from invocation to completion.
 */
export interface SubagentExecution<ToolCall = DefaultToolCall> {
  /** Unique identifier (the tool call ID) */
  id: string;

  /** The tool call that invoked this subagent */
  toolCall: SubagentToolCall;

  /** Current execution status */
  status: SubagentStatus;

  /** Final result content (when complete) */
  result: string | null;

  /** Error message (if status === "error") */
  error: string | null;

  /** Namespace path for this subagent execution */
  namespace: string[];

  /** Messages accumulated during this subagent's execution */
  messages: Message<ToolCall>[];

  /** Tool call ID of parent subagent (for nested subagents) */
  parentId: string | null;

  /** Nesting depth (0 = called by main agent, 1 = called by subagent, etc.) */
  depth: number;

  /** Timing information */
  startedAt: Date | null;

  /** When the subagent completed */
  completedAt: Date | null;
}

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
 * Check if a type is agent-like (has `~agentTypes` phantom property).
 * This property is present on `ReactAgent` instances created with `createAgent`.
 */
export type IsAgentLike<T> = T extends { "~agentTypes": AgentTypeConfigLike }
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
export type ExtractAgentConfig<T> = T extends { "~agentTypes": infer Config }
  ? Config extends AgentTypeConfigLike
    ? Config
    : never
  : never;

// ============================================================================
// Middleware State Extraction Helpers
// ============================================================================
// These types enable extracting state types from middleware arrays without
// requiring the full langchain dependency.

/**
 * Minimal interface to structurally match AgentMiddleware from langchain.
 * We can't import AgentMiddleware due to circular dependencies, so we match
 * against its structure to extract type information.
 */
export interface AgentMiddlewareLike<
  TSchema = unknown,
  TContextSchema = unknown,
  TFullContext = unknown,
  TTools = unknown
> {
  name: string;
  stateSchema?: TSchema;
  "~middlewareTypes"?: {
    Schema: TSchema;
    ContextSchema: TContextSchema;
    FullContext: TFullContext;
    Tools: TTools;
  };
}

/**
 * Helper type to extract state from a single middleware instance.
 * Uses structural matching against AgentMiddleware to extract the state schema
 * type parameter, similar to how langchain's InferMiddlewareState works.
 */
type InferMiddlewareState<T> =
  // Pattern 1: Match against AgentMiddlewareLike structure to extract TSchema
  T extends AgentMiddlewareLike<infer TSchema, unknown, unknown, unknown>
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      TSchema extends Record<string, any>
      ? InferInteropZodInput<TSchema>
      : // eslint-disable-next-line @typescript-eslint/ban-types
        {}
    : // Pattern 2: Direct stateSchema property (for testing with MockMiddleware)
    T extends { stateSchema: infer S }
    ? InferInteropZodInput<S>
    : // eslint-disable-next-line @typescript-eslint/ban-types
      {};

/**
 * Helper type to detect if a type is `any`.
 * Uses the fact that `any` is both a subtype and supertype of all types.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * Helper type to extract and merge states from an array of middleware.
 * Recursively processes each middleware and intersects their state types.
 *
 * Handles both readonly and mutable arrays/tuples explicitly.
 *
 * @example
 * ```ts
 * type States = InferMiddlewareStatesFromArray<typeof middlewareArray>;
 * // Returns intersection of all middleware state types
 * ```
 */
export type InferMiddlewareStatesFromArray<T> =
  // Guard against `any` type - any extends everything so would match first branch incorrectly
  IsAny<T> extends true
    ? // eslint-disable-next-line @typescript-eslint/ban-types
      {}
    : // Handle undefined/null
    T extends undefined | null
    ? // eslint-disable-next-line @typescript-eslint/ban-types
      {}
    : // Handle empty readonly array
    T extends readonly []
    ? // eslint-disable-next-line @typescript-eslint/ban-types
      {}
    : // Handle empty mutable array
    T extends []
    ? // eslint-disable-next-line @typescript-eslint/ban-types
      {}
    : // Handle readonly tuple [First, ...Rest]
    T extends readonly [infer First, ...infer Rest extends readonly unknown[]]
    ? InferMiddlewareState<First> & InferMiddlewareStatesFromArray<Rest>
    : // Handle mutable tuple [First, ...Rest]
    T extends [infer First, ...infer Rest extends unknown[]]
    ? InferMiddlewareState<First> & InferMiddlewareStatesFromArray<Rest>
    : // Handle readonly array of union type
    T extends readonly (infer U)[]
    ? InferMiddlewareState<U>
    : // Handle mutable array of union type
    T extends (infer U)[]
    ? InferMiddlewareState<U>
    : // eslint-disable-next-line @typescript-eslint/ban-types
      {};

/**
 * Infer the complete merged state from an agent, including:
 * - The agent's own state schema (via State)
 * - All middleware states (via Middleware)
 *
 * This is the SDK equivalent of langchain's `InferAgentState` type.
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   middleware: [todoListMiddleware()],
 *   // ...
 * });
 *
 * type State = InferAgentState<typeof agent>;
 * // State includes { todos: Todo[], ... }
 * ```
 */
/**
 * Base agent state that all agents have by default.
 * This includes the messages array which is fundamental to agent operation.
 * The ToolCall type parameter allows proper typing of tool calls in messages.
 */
type BaseAgentState<ToolCall = DefaultToolCall> = {
  messages: Message<ToolCall>[];
};

export type InferAgentState<T> = T extends { "~agentTypes": unknown }
  ? ExtractAgentConfig<T> extends never
    ? // eslint-disable-next-line @typescript-eslint/ban-types
      {}
    : BaseAgentState<InferAgentToolCalls<T>> &
        (ExtractAgentConfig<T>["State"] extends undefined
          ? // eslint-disable-next-line @typescript-eslint/ban-types
            {}
          : InferInteropZodInput<ExtractAgentConfig<T>["State"]>) &
        InferMiddlewareStatesFromArray<ExtractAgentConfig<T>["Middleware"]>
  : T extends { "~RunOutput": infer RunOutput }
  ? RunOutput
  : T extends { messages: unknown }
  ? T
  : // eslint-disable-next-line @typescript-eslint/ban-types
    {};

/**
 * Helper type to extract the input type from a DynamicStructuredTool's _call method.
 * This is more reliable than trying to infer from the schema directly because
 * DynamicStructuredTool has the input type baked into its _call signature.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferToolInput<T> = T extends {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _call: (arg: infer Args, ...rest: any[]) => any;
}
  ? Args
  : T extends { schema: infer S }
  ? InferInteropZodInput<S>
  : never;

/**
 * Extract a tool call type from a single tool.
 * Works with tools created via `tool()` from `@langchain/core/tools`.
 *
 * This extracts the literal name type from DynamicStructuredTool's NameT parameter
 * and the args type from the _call method or schema's input property.
 */
type ToolCallFromAgentTool<T> = T extends { name: infer N }
  ? N extends string
    ? InferToolInput<T> extends infer Args
      ? Args extends never
        ? never
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Args extends Record<string, any>
        ? { name: N; args: Args; id?: string; type?: "tool_call" }
        : never
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

// ============================================================================
// StateType Tool Call Extraction Helpers
// ============================================================================
// These types enable extracting tool call types from the messages property
// of a StateType, providing a single canonical way to specify tool call types.

/**
 * Extract the tool call type parameter from an AIMessage in a message union.
 * Returns `never` if the message is not an AIMessage or uses DefaultToolCall.
 *
 * The key distinction: custom tool calls have literal `name` types (e.g., "get_weather"),
 * while DefaultToolCall has `name: string`. We check if `string extends TC["name"]` -
 * if true, it's DefaultToolCall; if false, it's a custom type with literal names.
 */
type ExtractToolCallFromMessageUnion<M> = M extends AIMessage<infer TC>
  ? TC extends { name: infer N }
    ? // If string extends N, then N is just `string` (DefaultToolCall)
      // If not, N is a literal type like "get_weather" (custom type)
      string extends N
      ? never
      : TC
    : never
  : never;

/**
 * Extract the tool call type from a StateType's messages property.
 * This is the primary way to specify tool call types when using useStream.
 *
 * @example
 * ```ts
 * // Define state with typed messages
 * type MyToolCalls =
 *   | { name: "get_weather"; args: { location: string }; id?: string }
 *   | { name: "search"; args: { query: string }; id?: string };
 *
 * interface MyState {
 *   messages: Message<MyToolCalls>[];
 * }
 *
 * // ExtractToolCallsFromState<MyState> = MyToolCalls
 * ```
 */
export type ExtractToolCallsFromState<
  StateType extends Record<string, unknown>
> = StateType extends { messages: infer Messages }
  ? Messages extends readonly (infer M)[]
    ? ExtractToolCallFromMessageUnion<M>
    : Messages extends (infer M)[]
    ? ExtractToolCallFromMessageUnion<M>
    : never
  : never;

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

/**
 * Extract the tool call type from a StateType's messages property.
 * This is the canonical way to get typed tool calls in useStream.
 *
 * Tool call types are now extracted from the messages property of StateType,
 * rather than being specified separately in the Bag.
 *
 * @example
 * ```ts
 * // Define state with typed messages
 * type MyToolCalls =
 *   | { name: "get_weather"; args: { location: string }; id?: string }
 *   | { name: "search"; args: { query: string }; id?: string };
 *
 * interface MyState {
 *   messages: Message<MyToolCalls>[];
 * }
 *
 * // GetToolCallsType<MyState> = MyToolCalls
 * ```
 */
export type GetToolCallsType<StateType extends Record<string, unknown>> =
  ExtractToolCallsFromState<StateType> extends never
    ? DefaultToolCall
    : ExtractToolCallsFromState<StateType>;

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

  /**
   * Tool names that indicate subagent invocation.
   *
   * When an AI message contains tool calls with these names, they are
   * automatically tracked as subagent executions. This enables the
   * `subagents`, `activeSubagents`, `getSubagent()`, and `getSubagentsByType()`
   * properties on the stream.
   *
   * @default ["task"]
   *
   * @example
   * ```typescript
   * const stream = useStream({
   *   assistantId: "my-agent",
   *   // Track both "task" and "delegate" as subagent tools
   *   subagentToolNames: ["task", "delegate", "spawn_agent"],
   * });
   *
   * // Now stream.subagents will include executions from any of these tools
   * ```
   */
  subagentToolNames?: string[];

  /**
   * Filter out messages from subagent streams in the main messages array.
   *
   * When enabled, messages from subgraph executions (those with a `tools:` namespace)
   * are excluded from `stream.messages`. Instead, these messages are tracked
   * per-subagent and accessible via `stream.subagents.get(id).messages`.
   *
   * This is useful for deep agent architectures where you want to display
   * the main conversation separately from subagent activity.
   *
   * @default false
   *
   * @example
   * ```typescript
   * const stream = useStream({
   *   assistantId: "my-agent",
   *   filterSubagentMessages: true,
   * });
   *
   * // Main thread messages only (no subagent messages)
   * stream.messages
   *
   * // Access subagent messages individually
   * stream.subagents.get("call_xyz").messages
   * ```
   */
  filterSubagentMessages?: boolean;
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
  | "subagentToolNames"
  | "filterSubagentMessages"
> & { transport: UseStreamTransport<StateType, Bag> };

export type CustomSubmitOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  ConfigurableType extends Record<string, unknown> = Record<string, unknown>
> = Pick<
  SubmitOptions<StateType, ConfigurableType>,
  "optimisticValues" | "context" | "command" | "config"
>;
