import { useState } from "react";
import { useStreamLGP } from "./stream.lgp.js";
import { useStreamCustom } from "./stream.custom.js";
import type { UseStreamOptions } from "../ui/types.js";
import type { BagTemplate } from "../types.template.js";
import type { UseStreamCustomOptions } from "./types.js";
import type {
  ResolveStreamInterface,
  ResolveStreamOptions,
  InferBag,
  InferStateType,
} from "../ui/stream/index.js";

function isCustomOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(
  options:
    | UseStreamOptions<StateType, Bag>
    | UseStreamCustomOptions<StateType, Bag>
): options is UseStreamCustomOptions<StateType, Bag> {
  return "transport" in options;
}

/**
 * A React hook that provides seamless integration with LangGraph streaming capabilities.
 *
 * The `useStream` hook handles all the complexities of streaming, state management, and branching logic,
 * letting you focus on building great chat experiences. It provides automatic state management for
 * messages, interrupts, loading states, and errors.
 *
 * ## Usage with ReactAgent (recommended for createAgent users)
 *
 * When using `createAgent` from `@langchain/langgraph`, you can pass `typeof agent` as the
 * type parameter to automatically infer tool call types:
 *
 * @example
 * ```typescript
 * // In your agent file (e.g., agent.ts)
 * import { createAgent, tool } from "@langchain/langgraph";
 * import { z } from "zod";
 *
 * const getWeather = tool(
 *   async ({ location }) => `Weather in ${location}`,
 *   { name: "get_weather", schema: z.object({ location: z.string() }) }
 * );
 *
 * export const agent = createAgent({
 *   model: "openai:gpt-4o",
 *   tools: [getWeather],
 * });
 *
 * // In your React component
 * import { agent } from "./agent";
 *
 * function Chat() {
 *   // Tool calls are automatically typed from the agent's tools!
 *   const stream = useStream<typeof agent>({
 *     assistantId: "agent",
 *     apiUrl: "http://localhost:2024",
 *   });
 *
 *   // stream.toolCalls[0].call.name is typed as "get_weather"
 *   // stream.toolCalls[0].call.args is typed as { location: string }
 * }
 * ```
 *
 * ## Usage with StateGraph (for custom LangGraph applications)
 *
 * When building custom graphs with `StateGraph`, embed your tool call types directly
 * in your state's messages property using `Message<MyToolCalls>`:
 *
 * @example
 * ```typescript
 * import { Message } from "@langchain/langgraph-sdk";
 *
 * // Define your tool call types as a discriminated union
 * type MyToolCalls =
 *   | { name: "search"; args: { query: string }; id?: string }
 *   | { name: "calculate"; args: { expression: string }; id?: string };
 *
 * // Embed tool call types in your state's messages
 * interface MyGraphState {
 *   messages: Message<MyToolCalls>[];
 *   context?: string;
 * }
 *
 * function Chat() {
 *   const stream = useStream<MyGraphState>({
 *     assistantId: "my-graph",
 *     apiUrl: "http://localhost:2024",
 *   });
 *
 *   // stream.values is typed as MyGraphState
 *   // stream.toolCalls[0].call.name is typed as "search" | "calculate"
 * }
 * ```
 *
 * @example
 * ```typescript
 * // With additional type configuration (interrupts, configurable)
 * interface MyGraphState {
 *   messages: Message<MyToolCalls>[];
 * }
 *
 * function Chat() {
 *   const stream = useStream<MyGraphState, {
 *     InterruptType: { question: string };
 *     ConfigurableType: { userId: string };
 *   }>({
 *     assistantId: "my-graph",
 *     apiUrl: "http://localhost:2024",
 *   });
 *
 *   // stream.interrupt is typed as { question: string } | undefined
 * }
 * ```
 *
 * @template T Either a ReactAgent type (with `~agentTypes`) or a state type (`Record<string, unknown>`)
 * @template Bag Type configuration bag containing:
 *   - `ConfigurableType`: Type for the `config.configurable` property
 *   - `InterruptType`: Type for interrupt values
 *   - `CustomEventType`: Type for custom events
 *   - `UpdateType`: Type for the submit function updates
 *
 * @see {@link https://docs.langchain.com/langgraph-platform/use-stream-react | LangGraph React Integration Guide}
 */
export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(
  options: ResolveStreamOptions<T, InferBag<T, Bag>>
): ResolveStreamInterface<T, InferBag<T, Bag>>;

/**
 * A React hook that provides seamless integration with LangGraph streaming capabilities.
 *
 * The `useStream` hook handles all the complexities of streaming, state management, and branching logic,
 * letting you focus on building great chat experiences. It provides automatic state management for
 * messages, interrupts, loading states, and errors.
 *
 * @template T Either a ReactAgent type (with `~agentTypes`) or a state type (`Record<string, unknown>`)
 * @template Bag Type configuration bag containing:
 *   - `ConfigurableType`: Type for the `config.configurable` property
 *   - `InterruptType`: Type for interrupt values
 *   - `CustomEventType`: Type for custom events
 *   - `UpdateType`: Type for the submit function updates
 *
 * @see {@link https://docs.langchain.com/langgraph-platform/use-stream-react | LangGraph React Integration Guide}
 */
export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(
  options: UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>
): ResolveStreamInterface<T, InferBag<T, Bag>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStream(options: any): any {
  // Store this in useState to make sure we're not changing the implementation in re-renders
  const [isCustom] = useState(isCustomOptions(options));

  if (isCustom) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useStreamCustom(options);
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useStreamLGP(options);
}
