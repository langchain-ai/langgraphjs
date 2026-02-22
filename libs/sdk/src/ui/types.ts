import type { InferInteropZodInput } from "@langchain/core/utils/types";
import type { BaseMessage } from "@langchain/core/messages";

import type { Client, ClientConfig } from "../client.js";
import type {
  ThreadState,
  Config,
  Checkpoint,
  Metadata,
  Interrupt,
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
import type {
  DefaultToolCall,
  AIMessage,
  Message,
  ToolCallWithResult,
} from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";

/**
 * Represents a tool call that initiated a subagent.
 *
 * @template SubagentName - The subagent name type. When inferred from a
 *   DeepAgent, this is a union of all subagent names (e.g. `"researcher" | "writer"`),
 *   making `args.subagent_type` a typed discriminant.
 */
export interface SubagentToolCall<SubagentName extends string = string> {
  /** The tool call ID */
  id: string;
  /** The name of the tool (typically "task") */
  name: string;
  /** The arguments passed to the tool */
  args: {
    /** The task description for the subagent */
    description?: string;
    /** The type of subagent to use */
    subagent_type?: SubagentName;
    /** Additional custom arguments */
    [key: string]: unknown;
  };
}

/**
 * The execution status of a subagent.
 *
 * - `"pending"` - The subagent has been invoked but hasn't started processing yet.
 *   This is the initial state when a tool call is detected but before any
 *   streaming events are received from the subgraph.
 *
 * - `"running"` - The subagent is actively executing and streaming updates.
 *   The subagent transitions to this state when the first update event is
 *   received from its namespace.
 *
 * - `"complete"` - The subagent has finished execution successfully.
 *   A tool message with the result has been received, and the `result`
 *   property contains the final output.
 *
 * - `"error"` - The subagent encountered an error during execution.
 *   The `error` property on the SubagentStream contains error details.
 */
export type SubagentStatus = "pending" | "running" | "complete" | "error";

/**
 * Default subagent state map used when no specific subagent types are provided.
 * Maps any string key to Record<string, unknown>.
 */
export type DefaultSubagentStates = Record<string, Record<string, unknown>>;

/**
 * Base interface for stream-like objects.
 * Contains common properties shared between UseStream and SubagentStream.
 *
 * @template StateType - The type of the stream's state values.
 * @template ToolCall - The type of tool calls in messages.
 * @template InterruptType - The type of interrupt values.
 * @template SubagentStates - A map of subagent names to their state types.
 *   Use `SubagentStateMap<typeof agent>` to infer from a DeepAgent.
 */
export interface StreamBase<
  StateType = Record<string, unknown>,
  ToolCall = DefaultToolCall,
  InterruptType = unknown,
  SubagentStates extends Record<string, unknown> = DefaultSubagentStates
> {
  /**
   * The current state values of the stream.
   */
  values: StateType;

  /**
   * Last seen error from the stream.
   */
  error: unknown;

  /**
   * Whether the stream is currently running.
   */
  isLoading: boolean;

  /**
   * Messages accumulated during the stream.
   */
  messages: Message<ToolCall>[];

  /**
   * Tool calls paired with their results.
   * Useful for rendering tool invocations and their outputs together.
   */
  toolCalls: ToolCallWithResult<ToolCall>[];

  /**
   * Get tool calls for a specific AI message.
   *
   * @param message - The AI message to get tool calls for.
   * @returns Array of tool calls initiated by the message.
   */
  getToolCalls: (
    message: AIMessage<ToolCall>
  ) => ToolCallWithResult<ToolCall>[];

  /**
   * Get the interrupt value for the stream if interrupted.
   * Convenience alias for `interrupts[0]`.
   */
  interrupt: Interrupt<InterruptType> | undefined;

  /**
   * All current interrupts from the stream.
   * When using Send() fan-out with per-task interrupt() calls,
   * multiple interrupts may be pending simultaneously.
   */
  interrupts: Interrupt<InterruptType>[];

  /**
   * All currently active and completed subagent streams.
   * Keyed by tool call ID for easy lookup.
   */
  subagents: Map<
    string,
    SubagentStreamInterface<
      SubagentStates[keyof SubagentStates],
      ToolCall,
      keyof SubagentStates & string
    >
  >;

  /**
   * Currently active subagents (where status === "running").
   */
  activeSubagents: SubagentStreamInterface<
    SubagentStates[keyof SubagentStates],
    ToolCall,
    keyof SubagentStates & string
  >[];

  /**
   * Get subagent stream by tool call ID.
   *
   * @param toolCallId - The tool call ID that initiated the subagent.
   * @returns The subagent stream, or undefined if not found.
   */
  getSubagent: (
    toolCallId: string
  ) =>
    | SubagentStreamInterface<
        SubagentStates[keyof SubagentStates],
        ToolCall,
        keyof SubagentStates & string
      >
    | undefined;

  /**
   * Get all subagents of a specific type.
   * When called with a literal type name that matches a key in SubagentStates,
   * returns streams with properly inferred state types.
   *
   * @param type - The subagent_type to filter by.
   * @returns Array of matching subagent streams with inferred state types.
   *
   * @example
   * ```ts
   * // With DeepAgent type inference
   * const stream = useStream<typeof agent>(...);
   * const researchers = stream.getSubagentsByType("researcher");
   * // researchers[0].values is typed with ResearcherMiddleware state
   * ```
   */
  getSubagentsByType: {
    // Overload for known subagent names - returns typed streams
    <TName extends keyof SubagentStates & string>(
      type: TName
    ): SubagentStreamInterface<SubagentStates[TName], ToolCall, TName>[];
    // Overload for unknown names - returns untyped streams
    (type: string): SubagentStreamInterface<
      Record<string, unknown>,
      ToolCall
    >[];
  };

  /**
   * Get all subagents triggered by a specific AI message.
   *
   * Useful for rendering subagent activities grouped by the AI message
   * (and therefore conversation turn) that spawned them.
   *
   * @param messageId - The ID of the AI message that triggered the subagents.
   * @returns Array of subagent streams triggered by that message.
   *
   * @example
   * ```tsx
   * // Render subagents after each AI message that triggered them
   * {stream.messages.map((msg) => (
   *   <div key={msg.id}>
   *     <MessageBubble message={msg} />
   *     {msg.type === "ai" && "tool_calls" in msg && (
   *       <SubagentPipeline
   *         subagents={stream.getSubagentsByMessage(msg.id)}
   *       />
   *     )}
   *   </div>
   * ))}
   * ```
   */
  getSubagentsByMessage: (
    messageId: string
  ) => SubagentStreamInterface<
    SubagentStates[keyof SubagentStates],
    ToolCall,
    keyof SubagentStates & string
  >[];
}

/**
 * Base interface for a single subagent stream.
 * Tracks the lifecycle of a subagent from invocation to completion.
 *
 * Extends StreamBase to share common properties with UseStream,
 * allowing subagents to be treated similarly to the main stream.
 *
 * Prefer using {@link SubagentStream} which supports passing an agent type
 * directly for automatic type inference.
 *
 * @template StateType - The state type of the subagent. Defaults to Record<string, unknown>
 *   since different subagents may have different state types. Can be narrowed using
 *   DeepAgent type helpers like `InferSubagentByName` when the specific subagent is known.
 * @template ToolCall - The type of tool calls in messages.
 * @template SubagentName - The subagent name union type. When inferred from a DeepAgent,
 *   enables typed `toolCall.args.subagent_type`.
 */
export interface SubagentStreamInterface<
  StateType = Record<string, unknown>,
  ToolCall = DefaultToolCall,
  SubagentName extends string = string
> extends StreamBase<StateType, ToolCall> {
  /** Unique identifier (the tool call ID) */
  id: string;

  /** The tool call that invoked this subagent */
  toolCall: SubagentToolCall<SubagentName>;

  /** Current execution status */
  status: SubagentStatus;

  /** Final result content (when complete) */
  result: string | null;

  /** Namespace path for this subagent execution */
  namespace: string[];

  /** Tool call ID of parent subagent (for nested subagents) */
  parentId: string | null;

  /** Nesting depth (0 = called by main agent, 1 = called by subagent, etc.) */
  depth: number;

  /** When the subagent started */
  startedAt: Date | null;

  /** When the subagent completed */
  completedAt: Date | null;
}

/**
 * Represents a single subagent stream.
 *
 * Supports two usage patterns:
 *
 * 1. **Agent type inference** (recommended): Pass a DeepAgent type directly and
 *    let TypeScript infer the correct state and tool call types.
 *
 * ```typescript
 * import type { agent } from "./agent";
 *
 * // Automatically infers state and tool call types from the agent
 * const subagent: SubagentStream<typeof agent> = ...;
 * ```
 *
 * 2. **Explicit generics**: Pass state and tool call types manually.
 *
 * ```typescript
 * type ResearcherState = { research_notes: string };
 * const researcher: SubagentStream<ResearcherState, MyToolCall> = ...;
 * ```
 *
 * @template T - Either a DeepAgent/Agent type for automatic inference,
 *   or a state type (Record) for explicit typing. Defaults to Record<string, unknown>.
 * @template ToolCall - The type of tool calls in messages.
 *   Only used when T is a state type. Defaults to DefaultToolCall.
 */
export type SubagentStream<
  T = Record<string, unknown>,
  ToolCall = DefaultToolCall
> = IsDeepAgentLike<T> extends true
  ? SubagentStreamInterface<
      SubagentStateMap<T, InferAgentToolCalls<T>>[InferSubagentNames<T>],
      InferAgentToolCalls<T>,
      InferSubagentNames<T>
    >
  : IsAgentLike<T> extends true
  ? SubagentStreamInterface<InferAgentState<T>, InferAgentToolCalls<T>>
  : SubagentStreamInterface<T, ToolCall>;

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
type SafeInferInteropZodInput<T> =
  InferInteropZodInput<T> extends never
    ? // eslint-disable-next-line @typescript-eslint/ban-types
      {}
    : InferInteropZodInput<T>;

type InferMiddlewareState<T> =
  // Pattern 1: Match against AgentMiddlewareLike structure to extract TSchema
  T extends AgentMiddlewareLike<infer TSchema, unknown, unknown, unknown>
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      TSchema extends Record<string, any>
      ? SafeInferInteropZodInput<TSchema>
      : // eslint-disable-next-line @typescript-eslint/ban-types
        {}
    : // Pattern 2: Direct stateSchema property (for testing with MockMiddleware)
    T extends { stateSchema: infer S }
    ? SafeInferInteropZodInput<S>
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
          : SafeInferInteropZodInput<ExtractAgentConfig<T>["State"]>) &
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
 * Helper type to check if a type is a literal string (not generic `string`).
 * Returns true only for literal types like "get_weather", false for `string`.
 */
type IsLiteralString<T> = string extends T
  ? false
  : T extends string
  ? true
  : false;

/**
 * Extract a tool call type from a single tool.
 * Works with tools created via `tool()` from `@langchain/core/tools`.
 *
 * This extracts the literal name type from DynamicStructuredTool's NameT parameter
 * and the args type from the _call method or schema's input property.
 *
 * Note: Only tools with literal string names (e.g., "get_weather") are included.
 * Tools with generic `name: string` are filtered out to ensure discriminated
 * union narrowing works correctly in TypeScript.
 */
type ToolCallFromAgentTool<T> = T extends { name: infer N }
  ? N extends string
    ? IsLiteralString<N> extends true
      ? InferToolInput<T> extends infer Args
        ? Args extends never
          ? never
          : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          Args extends Record<string, any>
          ? { name: N; args: Args; id?: string; type?: "tool_call" }
          : never
        : never
      : never // Filter out generic `string` names
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
// DeepAgent Type Extraction Helpers
// ============================================================================
// These types enable extracting subagent type information from a DeepAgent instance
// created with `createDeepAgent` from the deepagents package.
// They are copied here to avoid circular dependencies (deepagents depends on this SDK).

/**
 * Minimal interface matching the structure of a SubAgent from deepagents.
 * Used for structural type matching without importing deepagents.
 */
export interface SubAgentLike {
  name: string;
  description: string;
  middleware?: readonly AgentMiddlewareLike[];
}

/**
 * Minimal interface matching the structure of a CompiledSubAgent from deepagents.
 * Used for structural type matching without importing deepagents.
 */
export interface CompiledSubAgentLike {
  name: string;
  description: string;
  runnable: unknown;
}

/**
 * Minimal interface matching the structure of DeepAgentTypeConfig from deepagents.
 * Extends AgentTypeConfigLike to include subagent type information.
 */
export interface DeepAgentTypeConfigLike extends AgentTypeConfigLike {
  Subagents: unknown;
}

/**
 * Check if a type is a DeepAgent (has `~deepAgentTypes` phantom property).
 * This property is present on DeepAgent instances created with `createDeepAgent`.
 */
export type IsDeepAgentLike<T> = T extends {
  "~deepAgentTypes": DeepAgentTypeConfigLike;
}
  ? true
  : false;

/**
 * Extract the DeepAgentTypeConfig from a DeepAgent-like type.
 *
 * @example
 * ```ts
 * const agent = createDeepAgent({ subagents: [...] });
 * type Config = ExtractDeepAgentConfig<typeof agent>;
 * // Config includes { Subagents: [...] }
 * ```
 */
export type ExtractDeepAgentConfig<T> = T extends {
  "~deepAgentTypes": infer Config;
}
  ? Config extends DeepAgentTypeConfigLike
    ? Config
    : never
  : never;

/**
 * Helper type to extract middleware from a SubAgent definition.
 * Handles both mutable and readonly middleware arrays.
 */
export type ExtractSubAgentMiddleware<T> = T extends {
  middleware?: infer M;
}
  ? M extends readonly AgentMiddlewareLike[]
    ? M
    : M extends AgentMiddlewareLike[]
    ? M
    : readonly []
  : readonly [];

/**
 * Extract the Subagents array type from a DeepAgent.
 *
 * @example
 * ```ts
 * const agent = createDeepAgent({ subagents: [researcher, writer] as const });
 * type Subagents = InferDeepAgentSubagents<typeof agent>;
 * // Subagents is the readonly tuple of subagent definitions
 * ```
 */
export type InferDeepAgentSubagents<T> = ExtractDeepAgentConfig<T> extends never
  ? never
  : ExtractDeepAgentConfig<T>["Subagents"];

/**
 * Helper type to extract a subagent by name from a DeepAgent.
 *
 * @typeParam T - The DeepAgent to extract from
 * @typeParam TName - The name of the subagent to extract
 *
 * @example
 * ```ts
 * const agent = createDeepAgent({
 *   subagents: [
 *     { name: "researcher", description: "...", middleware: [ResearchMiddleware] }
 *   ] as const,
 * });
 *
 * type Researcher = InferSubagentByName<typeof agent, "researcher">;
 * ```
 */
export type InferSubagentByName<
  T,
  TName extends string
> = InferDeepAgentSubagents<T> extends readonly (infer SA)[]
  ? SA extends { name: TName }
    ? SA
    : never
  : never;

/**
 * Base state type for subagents.
 * All subagents have at least a messages array, similar to the main agent.
 *
 * @template ToolCall - The tool call type for messages. Defaults to DefaultToolCall.
 */
export type BaseSubagentState<ToolCall = DefaultToolCall> = {
  messages: Message<ToolCall>[];
};

/**
 * Infer the state type for a specific subagent by extracting and merging
 * its middleware state schemas, plus the base agent state (messages).
 *
 * @typeParam T - The DeepAgent to extract from
 * @typeParam TName - The name of the subagent
 * @typeParam ToolCall - The tool call type for messages. Defaults to DefaultToolCall.
 *
 * @example
 * ```ts
 * const agent = createDeepAgent({
 *   subagents: [
 *     { name: "researcher", middleware: [ResearchMiddleware] }
 *   ] as const,
 * });
 *
 * type ResearcherState = InferSubagentState<typeof agent, "researcher">;
 * // ResearcherState includes { messages: Message<ToolCall>[], ...ResearchMiddleware state }
 * ```
 */
export type InferSubagentState<
  T,
  TName extends string,
  ToolCall = DefaultToolCall
> = InferSubagentByName<T, TName> extends never
  ? Record<string, unknown>
  : InferSubagentByName<T, TName> extends infer SA
  ? BaseSubagentState<ToolCall> &
      InferMiddlewareStatesFromArray<ExtractSubAgentMiddleware<SA>>
  : Record<string, unknown>;

/**
 * Extract all subagent names as a string union from a DeepAgent.
 *
 * @example
 * ```ts
 * const agent = createDeepAgent({
 *   subagents: [
 *     { name: "researcher", ... },
 *     { name: "writer", ... }
 *   ] as const,
 * });
 *
 * type SubagentNames = InferSubagentNames<typeof agent>;
 * // SubagentNames = "researcher" | "writer"
 * ```
 */
export type InferSubagentNames<T> =
  InferDeepAgentSubagents<T> extends readonly (infer SA)[]
    ? SA extends { name: infer N }
      ? N extends string
        ? N
        : never
      : never
    : never;

/**
 * Create a map of subagent names to their state types.
 * This is useful for type-safe `getSubagentsByType` calls.
 *
 * @typeParam T - The DeepAgent to extract from
 * @typeParam ToolCall - The tool call type for messages. Defaults to DefaultToolCall.
 *
 * @example
 * ```ts
 * const agent = createDeepAgent({
 *   subagents: [
 *     { name: "researcher", middleware: [ResearchMiddleware] },
 *     { name: "writer", middleware: [WriterMiddleware] }
 *   ] as const,
 * });
 *
 * type StateMap = SubagentStateMap<typeof agent>;
 * // StateMap = { researcher: ResearchState; writer: WriterState }
 * ```
 */
export type SubagentStateMap<T, ToolCall = DefaultToolCall> = {
  [K in InferSubagentNames<T>]: InferSubagentState<T, K, ToolCall>;
};

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

  // Note: Agent-specific options are defined in their respective option interfaces:
  // - UseAgentStreamOptions: subagentToolNames
  // - UseDeepAgentStreamOptions: filterSubagentMessages
  // See libs/sdk/src/ui/stream/agent.ts and libs/sdk/src/ui/stream/deep-agent.ts
}

/**
 * Union of all stream options types.
 *
 * Used internally by the implementation to accept any options type.
 * This allows the implementation functions to handle options from
 * any agent type while maintaining type safety at the public API level.
 *
 * @internal
 */
export type AnyStreamOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> = UseStreamOptions<StateType, Bag> & {
  // Agent-specific options (optional, only present for agent types)
  subagentToolNames?: string[];
  filterSubagentMessages?: boolean;
  toMessage?: (chunk: BaseMessage) => Message | BaseMessage;
};

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

/**
 * Union of all custom stream options types.
 *
 * Used internally by the implementation to accept any custom options type.
 * This allows the implementation functions to handle options from
 * any agent type while maintaining type safety at the public API level.
 *
 * @internal
 */
export type AnyStreamCustomOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> = UseStreamCustomOptions<StateType, Bag> & {
  // Agent-specific options (optional, only present for agent types)
  subagentToolNames?: string[];
  filterSubagentMessages?: boolean;
  toMessage?: (chunk: BaseMessage) => Message | BaseMessage;
};

export type CustomSubmitOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  ConfigurableType extends Record<string, unknown> = Record<string, unknown>
> = Pick<
  SubmitOptions<StateType, ConfigurableType>,
  "optimisticValues" | "context" | "command" | "config"
>;
