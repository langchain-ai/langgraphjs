import { writable, derived, fromStore } from "svelte/store";
import { onDestroy, onMount, setContext, getContext } from "svelte";

import type {
  BaseMessage,
  ToolMessage as CoreToolMessage,
  AIMessage as CoreAIMessage,
} from "@langchain/core/messages";
import {
  StreamOrchestrator,
  FetchStreamTransport,
  ensureMessageInstances,
  type MessageMetadata,
  type AnyStreamOptions,
  type ResolveStreamInterface,
  type ResolveStreamOptions,
  type InferBag,
  type InferStateType,
  type AcceptBaseMessages,
  type UseStreamCustomOptions,
  type SubagentStreamInterface,
  type HistoryWithBaseMessages,
} from "@langchain/langgraph-sdk/ui";
import {
  Client,
  type BagTemplate,
  type Message,
  type ToolCallWithResult as _ToolCallWithResult,
  type DefaultToolCall,
} from "@langchain/langgraph-sdk";
import { useStreamCustom } from "./stream.custom.js";

export { FetchStreamTransport };

const STREAM_CONTEXT_KEY = Symbol.for("langchain:stream-context");

/**
 * Provides a `useStream` return value to all descendant components via
 * Svelte's context API. Must be called during component initialisation
 * (i.e. at the top level of a `<script>` block).
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
 */
export function getStreamContext<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(): WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>> {
  const ctx = getContext(STREAM_CONTEXT_KEY);
  if (!ctx) {
    throw new Error(
      "getStreamContext must be used within a component that has called setStreamContext",
    );
  }
  return ctx as WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;
}

/**
 * Creates a shared `useStream` instance and makes it available to all
 * descendant components via Svelte's `setContext`/`getContext`.
 *
 * Uses the same context key as {@link setStreamContext}/{@link getStreamContext},
 * so both retrieval functions work interchangeably.
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
 * Retrieves the shared stream instance from the nearest ancestor that
 * called {@link provideStream} or {@link setStreamContext}.
 *
 * Throws if no ancestor has provided a stream.
 */
export function getStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(): ReturnType<typeof useStream<T, Bag>> {
  const context = getContext(STREAM_CONTEXT_KEY);
  if (context == null) {
    throw new Error(
      "getStream() requires a parent component to call provideStream(). " +
        "Add provideStream({ assistantId: '...' }) in an ancestor component.",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return context as any;
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

function useStreamLGP<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate,
>(options: AnyStreamOptions<StateType, Bag>) {
  const client = options.client ?? new Client({ apiUrl: options.apiUrl });

  const orchestrator = new StreamOrchestrator<StateType, Bag>(options, {
    getClient: () => client,
    getAssistantId: () => options.assistantId,
    getMessagesKey: () => options.messagesKey ?? "messages",
  });

  orchestrator.initThreadId(options.threadId ?? undefined);

  const version = writable(0);
  const unsubscribe = orchestrator.subscribe(() => {
    version.update((v) => v + 1);
  });

  let fetchController: AbortController | null = null;

  // Subagent reconstruction
  const shouldReconstructSubagents = derived(version, () => {
    const hvMessages = orchestrator.messages;
    if (!options.filterSubagentMessages) return false;
    if (orchestrator.isLoading || orchestrator.historyData.isLoading)
      return false;
    return hvMessages.length > 0;
  });

  const unsubReconstruct = shouldReconstructSubagents.subscribe(($should) => {
    if ($should) {
      fetchController?.abort();
      const controller = orchestrator.reconstructSubagentsIfNeeded();
      fetchController = controller;
    }
  });

  // Queue draining - must track isLoading specifically (not just version)
  // so the drain fires exactly when stream transitions from loading → idle
  const isLoadingForDrain = derived(version, () => orchestrator.isLoading);
  const unsubDrain = isLoadingForDrain.subscribe(() => {
    orchestrator.drainQueue();
  });

  // Auto-reconnect
  let { shouldReconnect } = orchestrator;

  onMount(() => {
    if (shouldReconnect) {
      const reconnected = orchestrator.tryReconnect();
      if (reconnected) shouldReconnect = false;
    }
  });

  onDestroy(() => {
    fetchController?.abort();
    unsubscribe();
    unsubReconstruct();
    unsubDrain();
    orchestrator.dispose();
  });

  // Derived stores
  const valuesStore = derived(version, () => {
    orchestrator.trackStreamMode("values");
    return orchestrator.values;
  });
  const errorStore = derived(version, () => orchestrator.error);
  const isLoadingStore = derived(version, () => orchestrator.isLoading);
  const branchStore = derived(version, () => orchestrator.branch);
  const messagesStore = derived(version, () => {
    orchestrator.trackStreamMode("messages-tuple", "values");
    return ensureMessageInstances(orchestrator.messages);
  });
  const toolCallsStore = derived(version, () => {
    orchestrator.trackStreamMode("messages-tuple", "values");
    return orchestrator.toolCalls;
  });
  const interruptStore = derived(version, () => orchestrator.interrupt);
  const interruptsStore = derived(version, () => orchestrator.interrupts);
  const historyListStore = derived(version, () => orchestrator.flatHistory);
  const isThreadLoadingStore = derived(
    version,
    () => orchestrator.isThreadLoading,
  );
  const experimentalBranchTreeStore = derived(
    version,
    () => orchestrator.experimental_branchTree,
  );
  const subagentsStore = derived(version, () => {
    orchestrator.trackStreamMode("updates", "messages-tuple");
    return orchestrator.subagents;
  });
  const activeSubagentsStore = derived(version, () => {
    orchestrator.trackStreamMode("updates", "messages-tuple");
    return orchestrator.activeSubagents;
  });
  const queueEntriesStore = derived(version, () => orchestrator.queueEntries);
  const queueSizeStore = derived(version, () => orchestrator.queueSize);

  // fromStore adapters for Svelte 5
  const valuesRef = fromStore(valuesStore);
  const errorRef = fromStore(errorStore);
  const isLoadingRef = fromStore(isLoadingStore);
  const branchRef = fromStore(branchStore);
  const messagesRef = fromStore(messagesStore);
  const toolCallsRef = fromStore(toolCallsStore);
  const interruptRef = fromStore(interruptStore);
  const interruptsRef = fromStore(interruptsStore);
  const historyListRef = fromStore(historyListStore);
  const isThreadLoadingRef = fromStore(isThreadLoadingStore);
  const experimentalBranchTreeRef = fromStore(experimentalBranchTreeStore);
  const subagentsRef = fromStore(subagentsStore);
  const activeSubagentsRef = fromStore(activeSubagentsStore);
  const queueEntriesRef = fromStore(queueEntriesStore);
  const queueSizeRef = fromStore(queueSizeStore);

  return {
    assistantId: options.assistantId,
    client,

    get values() {
      return valuesRef.current;
    },
    get error() {
      return errorRef.current;
    },
    get isLoading() {
      return isLoadingRef.current;
    },
    get isThreadLoading() {
      return isThreadLoadingRef.current;
    },

    get branch() {
      return branchRef.current;
    },
    setBranch: orchestrator.setBranch,

    get messages() {
      return messagesRef.current;
    },
    get toolCalls() {
      return toolCallsRef.current;
    },
    getToolCalls(message: Message) {
      return orchestrator.getToolCalls(message);
    },

    get interrupt() {
      return interruptRef.current;
    },
    get interrupts() {
      return interruptsRef.current;
    },

    get history() {
      return historyListRef.current;
    },
    get experimental_branchTree() {
      return experimentalBranchTreeRef.current;
    },

    getMessagesMetadata(
      message: Message,
      index?: number,
    ): MessageMetadata<StateType> | undefined {
      return orchestrator.getMessagesMetadata(message, index);
    },

    submit: orchestrator.submit,
    stop: orchestrator.stop,
    joinStream: orchestrator.joinStream,

    queue: {
      get entries() {
        return queueEntriesRef.current;
      },
      get size() {
        return queueSizeRef.current;
      },
      cancel: orchestrator.cancelQueueItem,
      clear: orchestrator.clearQueue,
    },

    switchThread: orchestrator.switchThread,

    get subagents() {
      return subagentsRef.current;
    },
    get activeSubagents() {
      return activeSubagentsRef.current;
    },
    getSubagent: orchestrator.getSubagent,
    getSubagentsByType: orchestrator.getSubagentsByType,
    getSubagentsByMessage: orchestrator.getSubagentsByMessage,
  };
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
