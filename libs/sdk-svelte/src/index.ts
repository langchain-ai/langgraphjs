import { setContext, getContext } from "svelte";

import type {
  ToolMessage as CoreToolMessage,
  AIMessage as CoreAIMessage,
} from "@langchain/core/messages";
import {
  FetchStreamTransport,
  type MessageMetadata,
  type ResolveStreamInterface,
  type ResolveStreamOptions,
  type InferBag,
  type InferStateType,
  type UseStreamCustomOptions,
  type WithClassMessages,
} from "@langchain/langgraph-sdk/ui";
import type {
  BagTemplate,
  ToolCallWithResult as _ToolCallWithResult,
  DefaultToolCall,
} from "@langchain/langgraph-sdk";
import { useStreamCustom } from "./stream.custom.svelte.js";
import { useStreamLGP } from "./stream.svelte.js";

export { FetchStreamTransport };

const STREAM_CONTEXT_KEY = Symbol.for("langchain:stream-context");

/**
 * Provides a `useStream` return value to all descendant components via
 * Svelte's context API. Must be called during component initialisation
 * (i.e. at the top level of a `<script>` block).
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useStream, setStreamContext } from "@langchain/svelte";
 *
 *   const stream = useStream({ assistantId: "agent", apiUrl: "..." });
 *   setStreamContext(stream);
 * </script>
 *
 * <ChildComponent />
 * ```
 */
export function setStreamContext<T extends ReturnType<typeof useStream>>(
  stream: T,
): T {
  setContext(STREAM_CONTEXT_KEY, stream);
  return stream;
}

/**
 * Retrieves the `useStream` instance previously provided by a parent
 * component via {@link setStreamContext} or {@link provideStream}.
 * Must be called during component initialisation.
 *
 * @throws If no stream context has been set by an ancestor component.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { getStreamContext } from "@langchain/svelte";
 *
 *   const stream = getStreamContext();
 * </script>
 * ```
 */
export function getStreamContext<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(): WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>> {
  const ctx = getContext(STREAM_CONTEXT_KEY);
  if (!ctx) {
    throw new Error(
      "getStreamContext must be used within a component that has called setStreamContext or provideStream",
    );
  }
  return ctx as WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;
}

/**
 * Creates a shared `useStream` instance and makes it available to all
 * descendant components via Svelte's `setContext`/`getContext`.
 *
 * Call this in a parent component's `<script>` block. Children access
 * the shared stream via {@link getStreamContext}.
 *
 * @example
 * ```svelte
 * <!-- ChatContainer.svelte -->
 * <script lang="ts">
 *   import { provideStream } from "@langchain/svelte";
 *
 *   const stream = provideStream({
 *     assistantId: "agent",
 *     apiUrl: "http://localhost:2024",
 *   });
 * </script>
 *
 * <ChatHeader />
 * <MessageList />
 * <MessageInput />
 * ```
 *
 * @returns The stream instance (same as calling `useStream` directly).
 */
export function provideStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options:
    | ResolveStreamOptions<T, InferBag<T, Bag>>
    | UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>,
): ReturnType<typeof useStream<T, Bag>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = useStream<T, Bag>(options as any);
  setContext(STREAM_CONTEXT_KEY, stream);
  return stream;
}

/**
 * @deprecated Use {@link getStreamContext} instead. `getStream` is an
 * alias kept for backward compatibility. Both functions share the same
 * context key and are fully interchangeable.
 */
export function getStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(): ReturnType<typeof useStream<T, Bag>> {
  return getStreamContext<T, Bag>() as ReturnType<typeof useStream<T, Bag>>;
}

export type { ClassSubagentStreamInterface } from "@langchain/langgraph-sdk/ui";

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: ResolveStreamOptions<T, InferBag<T, Bag>>,
): WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>,
): WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStream(options: any): any {
  if ("transport" in options) {
    return useStreamCustom(options);
  }
  return useStreamLGP(options);
}

export type {
  BaseStream,
  UseAgentStream,
  UseAgentStreamOptions,
  UseDeepAgentStream,
  UseDeepAgentStreamOptions,
  ResolveStreamInterface,
  ResolveStreamOptions,
  InferStateType,
  InferToolCalls,
  InferSubagentStates,
  InferNodeNames,
  InferBag,
  MessageMetadata,
  UseStreamOptions,
  UseStreamCustomOptions,
  UseStreamTransport,
  UseStreamThread,
  GetToolCallsType,
  AgentTypeConfigLike,
  IsAgentLike,
  ExtractAgentConfig,
  InferAgentToolCalls,
  SubagentToolCall,
  SubagentStatus,
  SubagentApi,
  SubagentStream,
  SubagentStreamInterface,
  SubAgentLike,
  CompiledSubAgentLike,
  DeepAgentTypeConfigLike,
  IsDeepAgentLike,
  ExtractDeepAgentConfig,
  ExtractSubAgentMiddleware,
  InferDeepAgentSubagents,
  InferSubagentByName,
  InferSubagentState,
  InferSubagentNames,
  SubagentStateMap,
  DefaultSubagentStates,
  BaseSubagentState,
  QueueEntry,
  QueueInterface,
} from "@langchain/langgraph-sdk/ui";

export type ToolCallWithResult<ToolCall = DefaultToolCall> =
  _ToolCallWithResult<ToolCall, CoreToolMessage, CoreAIMessage>;
export type {
  ToolCallState,
  DefaultToolCall,
  ToolCallFromTool,
  ToolCallsFromTools,
} from "@langchain/langgraph-sdk";

export {
  SubagentManager,
  extractToolCallIdFromNamespace,
  calculateDepthFromNamespace,
  extractParentIdFromNamespace,
  isSubagentNamespace,
} from "@langchain/langgraph-sdk/ui";
