/**
 * Stream types for ReactAgent instances created with `createAgent`.
 *
 * This module provides the stream interface that adds tool calling capabilities
 * on top of the base graph streaming functionality.
 *
 * @module
 */

import type { DefaultToolCall } from "../../types.messages.js";
import type { BagTemplate } from "../../types.template.js";
import type { BaseStream } from "./base.js";
import type { UseStreamOptions } from "../types.js";

/**
 * Stream interface for ReactAgent instances created with `createAgent`.
 *
 * Extends {@link UseGraphStream} with tool calling capabilities. Tool calls are
 * automatically typed based on the agent's tools configuration.
 *
 * Use this interface when streaming from an agent created with `createAgent`.
 * For subagent streaming capabilities, use {@link UseDeepAgentStream} with `createDeepAgent`.
 *
 * @experimental This interface is subject to change.
 *
 * @template StateType - The agent's state type (base + middleware states)
 * @template ToolCall - Tool call type inferred from agent's tools
 * @template Bag - Type configuration bag
 *
 * @example
 * ```typescript
 * import { createAgent, tool } from "@langchain/langgraph";
 * import { useStream } from "@langchain/langgraph-sdk/react";
 * import { z } from "zod";
 *
 * // Define tools with typed schemas
 * const searchTool = tool(
 *   async ({ query }) => `Results for: ${query}`,
 *   { name: "search", schema: z.object({ query: z.string() }) }
 * );
 *
 * const calculatorTool = tool(
 *   async ({ expression }) => eval(expression).toString(),
 *   { name: "calculator", schema: z.object({ expression: z.string() }) }
 * );
 *
 * // Create the agent
 * const agent = createAgent({
 *   model: "gpt-4",
 *   tools: [searchTool, calculatorTool],
 * });
 *
 * // In React component:
 * function Chat() {
 *   const stream = useStream<typeof agent>({
 *     assistantId: "my-agent",
 *     apiUrl: "http://localhost:2024",
 *   });
 *
 *   // Tool calls are typed!
 *   stream.toolCalls.forEach(tc => {
 *     if (tc.call.name === "search") {
 *       // tc.call.args is typed as { query: string }
 *       console.log("Searching for:", tc.call.args.query);
 *     } else if (tc.call.name === "calculator") {
 *       // tc.call.args is typed as { expression: string }
 *       console.log("Calculating:", tc.call.args.expression);
 *     }
 *   });
 * }
 * ```
 *
 * @remarks
 * This interface extends {@link BaseStream} with typed tool calls (inherited from BaseStream).
 * It does NOT include subagent streaming features. For those, use
 * {@link UseDeepAgentStream} with `createDeepAgent`.
 */
export interface UseAgentStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  ToolCall = DefaultToolCall,
  Bag extends BagTemplate = BagTemplate,
> extends BaseStream<StateType, ToolCall, Bag> {}

/**
 * Options for configuring an agent stream.
 *
 * Use this options interface when calling `useStream` with a ReactAgent
 * created via `createAgent`.
 *
 * @experimental This interface is subject to change.
 *
 * @template StateType - The agent's state type
 * @template Bag - Type configuration bag
 *
 * @example
 * ```typescript
 * const stream = useStream<typeof agent>({
 *   assistantId: "my-agent",
 *   apiUrl: "http://localhost:2024",
 *   onError: (error) => console.error(error),
 * });
 * ```
 */
export interface UseAgentStreamOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> extends UseStreamOptions<StateType, Bag> {}
