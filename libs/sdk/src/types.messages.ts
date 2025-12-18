import type { ReasoningMessage } from "./types.reasoning.js";

export type { ReasoningMessage } from "./types.reasoning.js";

type ImageDetail = "auto" | "low" | "high";
type MessageContentImageUrl = {
  type: "image_url";
  image_url: string | { url: string; detail?: ImageDetail | undefined };
};

type MessageContentText = { type: "text"; text: string };
type MessageContentComplex = MessageContentText | MessageContentImageUrl;
type MessageContent = string | MessageContentComplex[];

/**
 * Model-specific additional kwargs, which is passed back to the underlying LLM.
 */
type MessageAdditionalKwargs = Record<string, unknown>;

type BaseMessage = {
  additional_kwargs?: MessageAdditionalKwargs | undefined;
  content: MessageContent;
  id?: string | undefined;
  name?: string | undefined;
  response_metadata?: Record<string, unknown> | undefined;
};

export type HumanMessage = BaseMessage & {
  type: "human";
  example?: boolean | undefined;
};

/**
 * Default tool call type when no specific tool definitions are provided.
 */
export type DefaultToolCall = {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: { [x: string]: any };
  id?: string | undefined;
  type?: "tool_call" | undefined;
};

/**
 * Invalid tool call type.
 */
export type InvalidToolCall = {
  name?: string | undefined;
  args?: string | undefined;
  id?: string | undefined;
  error?: string | undefined;
  type?: "invalid_tool_call" | undefined;
};

/**
 * Usage metadata for AI messages.
 */
export type UsageMetadata = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_token_details?:
    | {
        audio?: number | undefined;
        cache_read?: number | undefined;
        cache_creation?: number | undefined;
      }
    | undefined;
  output_token_details?:
    | { audio?: number | undefined; reasoning?: number | undefined }
    | undefined;
};

/**
 * AI message type that can be parameterized with custom tool call types.
 *
 * @template ToolCall The type of tool calls, defaults to DefaultToolCall.
 *                    Provide a discriminated union for type-safe tool call handling.
 *
 * @example
 * ```ts
 * // Define typed tool calls as a discriminated union
 * type MyToolCalls =
 *   | { name: "get_weather"; args: { location: string }; id?: string }
 *   | { name: "search"; args: { query: string; limit?: number }; id?: string };
 *
 * // Use with AIMessage
 * const message: AIMessage<MyToolCalls> = ...;
 *
 * // Now tool.name === "get_weather" narrows tool.args type
 * if (message.tool_calls) {
 *   for (const tool of message.tool_calls) {
 *     if (tool.name === "get_weather") {
 *       // tool.args is now { location: string }
 *       console.log(tool.args.location);
 *     }
 *   }
 * }
 * ```
 */
export type AIMessage<ToolCall = DefaultToolCall> = BaseMessage & {
  type: "ai";
  example?: boolean | undefined;
  tool_calls?: ToolCall[] | undefined;
  invalid_tool_calls?: InvalidToolCall[] | undefined;
  usage_metadata?: UsageMetadata | undefined;
};

export type ToolMessage = BaseMessage & {
  type: "tool";
  status?: "error" | "success" | undefined;
  tool_call_id: string;
  /**
   * Artifact of the Tool execution which is not meant to be sent to the model.
   *
   * Should only be specified if it is different from the message content, e.g. if only
   * a subset of the full tool output is being passed as message content but the full
   * output is needed in other parts of the code.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artifact?: any;
};

export type SystemMessage = BaseMessage & {
  type: "system";
};

export type FunctionMessage = BaseMessage & {
  type: "function";
};

export type RemoveMessage = BaseMessage & {
  type: "remove";
};

/**
 * Union of all message types.
 *
 * @template ToolCall The type of tool calls for AIMessage, defaults to DefaultToolCall.
 */
export type Message<ToolCall = DefaultToolCall> =
  | HumanMessage
  | AIMessage<ToolCall>
  | ToolMessage
  | SystemMessage
  | FunctionMessage
  | RemoveMessage;

/**
 * Messages suitable for UI rendering (excludes ToolMessage).
 * ToolMessages are typically rendered via {@link ToolCallWithResult} instead of directly.
 * Includes ReasoningMessage for rendering thinking/reasoning content.
 *
 * @template ToolCall The type of tool calls for AIMessage, defaults to DefaultToolCall.
 */
export type UIMessage<ToolCall = DefaultToolCall> =
  | Exclude<Message<ToolCall>, ToolMessage>
  | ReasoningMessage;

/**
 * Infer a tool call type from a single tool.
 * Works with tools created via `tool()` from `@langchain/core/tools`.
 *
 * @template T The tool type (e.g., DynamicStructuredTool)
 *
 * @example
 * ```ts
 * import { tool } from "@langchain/core/tools";
 * import { z } from "zod";
 *
 * const getWeather = tool(
 *   async ({ location }) => `Weather in ${location}`,
 *   { name: "get_weather", schema: z.object({ location: z.string() }) }
 * );
 *
 * // Infer: { name: "get_weather"; args: { location: string }; id?: string; type?: "tool_call" }
 * type WeatherToolCall = ToolCallFromTool<typeof getWeather>;
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolCallFromTool<T> = T extends { name: infer N; schema: any }
  ? T["schema"] extends { _input: infer Args }
    ? { name: N; args: Args; id?: string; type?: "tool_call" }
    : never
  : never;

/**
 * Infer a union of tool call types from an array of tools.
 * Works with tools created via `tool()` from `@langchain/core/tools`.
 *
 * @template T A tuple/array of tools
 *
 * @example
 * ```ts
 * import { tool } from "@langchain/core/tools";
 * import { z } from "zod";
 *
 * const getWeather = tool(
 *   async ({ location }) => `Weather in ${location}`,
 *   { name: "get_weather", schema: z.object({ location: z.string() }) }
 * );
 *
 * const search = tool(
 *   async ({ query }) => `Results for ${query}`,
 *   { name: "search", schema: z.object({ query: z.string() }) }
 * );
 *
 * const tools = [getWeather, search] as const;
 *
 * // Infer union:
 * // | { name: "get_weather"; args: { location: string }; id?: string; type?: "tool_call" }
 * // | { name: "search"; args: { query: string }; id?: string; type?: "tool_call" }
 * type MyToolCalls = ToolCallsFromTools<typeof tools>;
 * ```
 */
export type ToolCallsFromTools<T extends readonly unknown[]> =
  T extends readonly [infer First, ...infer Rest]
    ? ToolCallFromTool<First> | ToolCallsFromTools<Rest>
    : never;

/**
 * The lifecycle state of a tool call.
 *
 * - `pending`: Tool call received, awaiting result
 * - `completed`: Tool execution finished successfully
 * - `error`: Tool execution failed (result.status === "error")
 */
export type ToolCallState = "pending" | "completed" | "error";

/**
 * Represents a tool call paired with its result.
 * Useful for rendering tool invocations and their outputs together.
 *
 * @template ToolCall The type of the tool call.
 */
export type ToolCallWithResult<ToolCall = DefaultToolCall> = {
  /**
   * Unique identifier for this tool call.
   * Uses the tool call's id if available, otherwise generates one from aiMessage.id and index.
   */
  id: string;

  /**
   * The tool call from the AI message.
   */
  call: ToolCall;

  /**
   * The result message from tool execution.
   * `undefined` if the tool is still being executed or no result was received.
   */
  result: ToolMessage | undefined;

  /**
   * The AI message that initiated this tool call.
   */
  aiMessage: AIMessage<ToolCall>;

  /**
   * Index of this tool call within the AI message's tool_calls array.
   */
  index: number;

  /**
   * The current lifecycle state of the tool call.
   *
   * - `pending`: No result yet
   * - `completed`: Has result with success status
   * - `error`: Has result with error status
   */
  state: ToolCallState;
};
