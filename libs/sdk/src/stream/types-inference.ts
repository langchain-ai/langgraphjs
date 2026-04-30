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
import type { DefaultToolCall, ToolCallFromTool } from "../types.messages.js";

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
 * Infer the discriminated union of tool call shapes from an input that
 * may be an agent brand, an array of LangGraph tools, or a direct
 * `DefaultToolCall` shape.
 *
 * See {@link InferToolCallsFromUi} for the full resolution table.
 */
export type InferToolCalls<T> =
  // Arrays of tools → discriminated union via ToolCallFromTool.
  T extends readonly unknown[]
    ? ToolCallFromTool<T[number]>
    : InferToolCallsFromUi<T>;

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
  ToolCallFromTool,
};
