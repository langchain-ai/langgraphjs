/**
 * Framework-agnostic type inference helpers used by `useStream`-style
 * bindings (React, Vue, Svelte, Angular).
 *
 * These helpers all already exist inside the legacy UI module; this
 * file is the v1 consolidation point so framework packages can reach
 * them via `@langchain/langgraph-sdk/stream` without depending on
 * `@langchain/langgraph-sdk/ui`. See
 * `libs/sdk-react/plan-types.md` for the rationale behind the shape
 * of the public surface.
 */
import type { BaseMessage } from "@langchain/core/messages";
import type {
  AgentTypeConfigLike,
  CompiledSubAgentLike,
  DeepAgentTypeConfigLike,
  ExtractAgentConfig,
  ExtractDeepAgentConfig,
  ExtractSubAgentMiddleware,
  InferAgentToolCalls,
  InferDeepAgentSubagents,
  InferSubagentByName,
  InferSubagentState,
  InferSubagentNames,
  IsAgentLike,
  IsDeepAgentLike,
  SubAgentLike,
  SubagentStateMap,
  SubagentToolCall,
  DefaultSubagentStates,
} from "../ui/types.js";
import type {
  InferBag,
  InferNodeNames,
  InferStateType as InferStateTypeFromUi,
  InferToolCalls as InferToolCallsFromUi,
  InferSubagentStates as InferSubagentStatesFromUi,
} from "../ui/stream/index.js";
import type {
  DefaultToolCall,
  InferToolOutput,
  ToolCallFromTool,
} from "../types.messages.js";
import type { AssembledToolCall } from "../client/stream/handles/tools.js";

/** @internal Map a {@link ToolCallFromTool} message shape to {@link AssembledToolCall}. */
type AssembledToolCallFromToolCall<
  TCall extends { name: string; args: Record<string, unknown> },
  TOutput = unknown,
> = TCall extends { name: infer N; args: infer A }
  ? N extends string
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      A extends Record<string, any>
      ? AssembledToolCall<N, A, TOutput>
      : never
    : never
  : never;

/**
 * Infer the streaming {@link AssembledToolCall} handle for a single
 * LangChain tool.
 *
 * Parallel to {@link ToolCallFromTool} for message-level tool calls —
 * use this when a component receives one entry from `stream.toolCalls`
 * and you know which tool definition it came from.
 *
 * @example
 * ```ts
 * const searchWeb = tool(/* ... *\/);
 *
 * function SearchWebCall({ toolCall }: {
 *   toolCall: AssembledToolCallFromTool<typeof searchWeb>;
 * }) {
 *   // toolCall.name is "search_web", args/input are schema-inferred
 * }
 *
 * v1 framework packages (`@langchain/react`, `@langchain/vue`, etc.) re-export
 * this type as {@link ToolCallFromTool}. {@link AssembledToolCall.output} is
 * `null` until the call succeeds; use {@link status} / {@link error} for UI.
 * ```
 */
export type AssembledToolCallFromTool<T> = AssembledToolCallFromToolCall<
  ToolCallFromTool<T>,
  InferToolOutput<T>
>;

/** @internal Resolve a tool definition's registered name. */
type ToolNameOf<T> = T extends { name: infer N extends string }
  ? N
  : T extends { tool: { name: infer N extends string } }
    ? N
    : never;

/** @internal Look up the return type of a tool in a tuple by its `name`. */
type MatchedToolOutput<
  Tools extends readonly unknown[],
  N extends string,
> = Tools extends readonly [infer First, ...infer Rest]
  ? ToolNameOf<First> extends N
    ? InferToolOutput<First>
    : MatchedToolOutput<Rest, N>
  : unknown;

/**
 * @internal Bridge a message-level tool-call shape from {@link InferToolCallsFromUi}
 * to a streaming {@link AssembledToolCall}, resolving `output` from the agent's
 * declared tool list.
 */
type AssembledFromMessageToolCall<
  TC extends { name: string; args: Record<string, unknown> },
  Tools extends readonly unknown[],
> = TC extends { name: infer N }
  ? N extends string
    ? AssembledToolCallFromToolCall<TC, MatchedToolOutput<Tools, N>>
    : AssembledToolCall
  : AssembledToolCall;

/**
 * Unwrap the state shape from a compiled graph, a create-agent brand,
 * or a plain type. Used by `useStream<T>()` to resolve `T = typeof
 * agent` into the state the `values`/`messages` projections observe.
 *
 * Structurally identical to the legacy
 * `@langchain/langgraph-sdk/ui` helper of the same name; kept here as
 * a framework-facing re-export so bindings can import from the
 * stream subpath without needing the UI module.
 */
export type InferStateType<T> = InferStateTypeFromUi<T>;

/**
 * Infer the discriminated union of {@link AssembledToolCall} handles
 * from an agent brand, an array of LangChain tools, or fall back to the
 * untyped default handle.
 *
 * Pass `typeof agent` or `typeof tools` and narrow on `name` / `args`
 * (aliases for `input`) in tool-call UI components.
 */
export type InferToolCalls<T> = T extends readonly unknown[]
  ? AssembledToolCallFromTool<T[number]>
  : ExtractAgentConfig<T>["Tools"] extends infer Tools extends
        readonly unknown[]
    ? InferToolCallsFromUi<T> extends infer TC
      ? TC extends { name: string; args: Record<string, unknown> }
        ? AssembledFromMessageToolCall<TC, Tools>
        : AssembledToolCall
      : AssembledToolCall
    : AssembledToolCall;

/**
 * Infer the subagent → state map from a DeepAgent brand. Non-brands
 * collapse to {@link DefaultSubagentStates}.
 */
export type InferSubagentStates<T> = InferSubagentStatesFromUi<T>;

/**
 * Widen an update type so its `messages` field also accepts
 * `@langchain/core` {@link BaseMessage} class instances (single or
 * array). Framework bindings apply this to `submit()` so callers can
 * write `stream.submit({ messages: [new HumanMessage("hi")] })`.
 *
 * Port of the legacy `AcceptBaseMessages<T>` helper; the public name
 * matches the v1 spec in `plan-types.md` §8.
 */
export type WidenUpdateMessages<T> =
  T extends Record<string, unknown>
    ? {
        [K in keyof T]: K extends "messages"
          ? T[K] | BaseMessage | BaseMessage[]
          : T[K];
      }
    : T;

export type {
  AgentTypeConfigLike,
  CompiledSubAgentLike,
  DefaultSubagentStates,
  DefaultToolCall,
  DeepAgentTypeConfigLike,
  ExtractAgentConfig,
  ExtractDeepAgentConfig,
  ExtractSubAgentMiddleware,
  InferAgentToolCalls,
  InferBag,
  InferDeepAgentSubagents,
  InferNodeNames,
  InferSubagentByName,
  InferSubagentNames,
  InferSubagentState,
  IsAgentLike,
  IsDeepAgentLike,
  SubAgentLike,
  SubagentStateMap,
  SubagentToolCall,
  InferToolOutput,
  ToolCallFromTool,
};
