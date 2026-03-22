import { setContext, getContext } from "svelte";

import type {
  BaseMessage,
  ToolMessage as CoreToolMessage,
  AIMessage as CoreAIMessage,
} from "@langchain/core/messages";
import { FetchStreamTransport } from "@langchain/langgraph-sdk/ui";
import type {
  MessageMetadata,
  ResolveStreamInterface,
  ResolveStreamOptions,
  InferBag,
  InferStateType,
  AcceptBaseMessages,
  UseStreamCustomOptions,
  SubagentStreamInterface,
  HistoryWithBaseMessages,
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

type ClassToolCallWithResult<T> =
  T extends _ToolCallWithResult<infer TC, unknown, unknown>
    ? _ToolCallWithResult<TC, CoreToolMessage, CoreAIMessage>
    : T;

export type ClassSubagentStreamInterface<
  StateType = Record<string, unknown>,
  ToolCall = DefaultToolCall,
  SubagentName extends string = string,
> = Omit<
  SubagentStreamInterface<StateType, ToolCall, SubagentName>,
  "messages"
> & {
  messages: BaseMessage[];
};

/**
 * Maps a stream interface to Svelte 5-reactive types:
 * - `messages` becomes `BaseMessage[]`
 * - `getMessagesMetadata` accepts `BaseMessage`
 * - `toolCalls` uses `@langchain/core` message classes
 * - `getToolCalls` accepts `CoreAIMessage`, returns class-based tool call results
 * - `queue` properties are plain values and functions
 * - `client`, `assistantId`, `subagents`, `activeSubagents` remain unwrapped
 * - Functions remain unchanged
 * - All other reactive properties are exposed as plain values via getters
 */
type WithClassMessages<T> = {
  [K in keyof T as K extends
    | "getSubagent"
    | "getSubagentsByType"
    | "getSubagentsByMessage"
    ? never
    : K]: K extends "messages"
    ? BaseMessage[]
    : K extends "getMessagesMetadata"
      ? (
          message: BaseMessage,
          index?: number,
        ) => MessageMetadata<Record<string, unknown>> | undefined
      : K extends "toolCalls"
        ? T[K] extends (infer TC)[]
          ? ClassToolCallWithResult<TC>[]
          : T[K]
        : K extends "getToolCalls"
          ? T[K] extends (message: infer _M) => (infer TC)[]
            ? (message: CoreAIMessage) => ClassToolCallWithResult<TC>[]
            : T[K]
          : K extends "queue"
            ? {
                [QK in keyof T[K]]: T[K][QK] extends (
                  ...args: infer A
                ) => infer R
                  ? (...args: A) => R
                  : T[K][QK];
              }
            : K extends "client" | "assistantId"
              ? T[K]
              : K extends "subagents"
                ? T[K] extends Map<
                    string,
                    SubagentStreamInterface<infer S, infer TC, infer N>
                  >
                  ? Map<string, ClassSubagentStreamInterface<S, TC, N>>
                  : T[K]
                : K extends "activeSubagents"
                  ? T[K] extends SubagentStreamInterface<
                      infer S,
                      infer TC,
                      infer N
                    >[]
                    ? ClassSubagentStreamInterface<S, TC, N>[]
                    : T[K]
                  : K extends "submit"
                    ? T[K] extends (
                        values: infer V,
                        options?: infer O,
                      ) => infer Ret
                      ? (
                          values:
                            | AcceptBaseMessages<Exclude<V, null | undefined>>
                            | null
                            | undefined,
                          options?: O,
                        ) => Ret
                      : T[K]
                    : K extends "history"
                      ? HistoryWithBaseMessages<T[K]>
                      : T[K] extends (...args: infer A) => infer R
                        ? (...args: A) => R
                        : T[K];
} & ("subagents" extends keyof T
  ? {
      getSubagent: T extends {
        getSubagent: (
          id: string,
        ) => SubagentStreamInterface<infer S, infer TC, infer N> | undefined;
      }
        ? (
            toolCallId: string,
          ) => ClassSubagentStreamInterface<S, TC, N> | undefined
        : never;
      getSubagentsByType: T extends {
        getSubagentsByType: (
          type: string,
        ) => SubagentStreamInterface<infer S, infer TC, infer N>[];
      }
        ? (type: string) => ClassSubagentStreamInterface<S, TC, N>[]
        : never;
      getSubagentsByMessage: T extends {
        getSubagentsByMessage: (
          id: string,
        ) => SubagentStreamInterface<infer S, infer TC, infer N>[];
      }
        ? (messageId: string) => ClassSubagentStreamInterface<S, TC, N>[]
        : never;
    }
  : unknown);

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
