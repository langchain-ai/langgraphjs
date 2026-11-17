import type { ExtractAgentConfig } from "./types.js";
import type { InferToolCalls } from "./stream/index.js";
import type { InferToolOutput, ToolCallFromTool } from "../types.messages.js";
import type { AssembledToolCall } from "./tool-payload.js";

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
 * @internal Bridge a message-level tool-call shape from {@link InferToolCalls}
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
 * Infer the discriminated union of {@link AssembledToolCall} handles
 * from an agent brand, an array of LangChain tools, or fall back to the
 * untyped default handle.
 *
 * Pass `typeof agent` or `typeof tools` and narrow on `name` / `args`
 * (aliases for `input`) in tool-call UI components.
 */
export type InferAssembledToolCalls<T> = T extends readonly unknown[]
  ? AssembledToolCallFromTool<T[number]>
  : ExtractAgentConfig<T>["Tools"] extends infer Tools extends
        readonly unknown[]
    ? InferToolCalls<T> extends infer TC
      ? TC extends { name: string; args: Record<string, unknown> }
        ? AssembledFromMessageToolCall<TC, Tools>
        : AssembledToolCall
      : AssembledToolCall
    : AssembledToolCall;
