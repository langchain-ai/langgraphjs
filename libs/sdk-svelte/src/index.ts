import { writable, derived, fromStore } from "svelte/store";
import { onDestroy, onMount, setContext, getContext } from "svelte";

import type {
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
  type UseStreamCustomOptions,
  type WithClassMessages,
} from "@langchain/langgraph-sdk/ui";
import {
  Client,
  type BagTemplate,
  type Message,
  type ToolCallWithResult as _ToolCallWithResult,
  type DefaultToolCall,
} from "@langchain/langgraph-sdk";
import { useStreamCustom } from "./stream.custom.js";
import { createReactiveSubagentAccessors } from "./subagents.js";

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
  stream: T
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
      "getStreamContext must be used within a component that has called setStreamContext"
    );
  }
  return ctx as WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;
}

/**
 * Creates a shared `useStream` instance and makes it available to all
 * descendant components via Svelte's `setContext`/`getContext`.
 *
 * Call this in a parent component's `<script>` block. Children access
 * the shared stream via {@link getStream}.
 *
 * Uses the same context key as {@link setStreamContext}/{@link getStreamContext},
 * so both retrieval functions work interchangeably.
 *
 * @example
 * ```svelte
 * <!-- ChatContainer.svelte -->
 * <script lang="ts">
 *   import { provideStream } from "@langchain/svelte";
 *
 *   provideStream({
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
    | UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>
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
 *
 * @example
 * ```svelte
 * <!-- MessageList.svelte -->
 * <script lang="ts">
 *   import { getStream } from "@langchain/svelte";
 *
 *   const stream = getStream();
 * </script>
 *
 * {#each stream.messages as msg (msg.id)}
 *   <div>{msg.content}</div>
 * {/each}
 * ```
 */
export function getStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(): ReturnType<typeof useStream<T, Bag>> {
  const context = getContext(STREAM_CONTEXT_KEY);
  if (context == null) {
    throw new Error(
      "getStream() requires a parent component to call provideStream(). " +
        "Add provideStream({ assistantId: '...' }) in an ancestor component."
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return context as any;
}

export type { ClassSubagentStreamInterface } from "@langchain/langgraph-sdk/ui";

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: ResolveStreamOptions<T, InferBag<T, Bag>>
): WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>
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
  const reactiveSubagents = createReactiveSubagentAccessors(
    {
      getSubagent: (toolCallId) => orchestrator.getSubagent(toolCallId),
      getSubagentsByType: (type) => orchestrator.getSubagentsByType(type),
      getSubagentsByMessage: (messageId) =>
        orchestrator.getSubagentsByMessage(messageId),
    },
    version
  );
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
    () => orchestrator.isThreadLoading
  );
  const experimentalBranchTreeStore = derived(
    version,
    () => orchestrator.experimental_branchTree
  );
  const subagentsStore = derived(version, () => {
    orchestrator.trackStreamMode("updates", "messages-tuple");
    return reactiveSubagents.mapSubagents(orchestrator.subagents);
  });
  const activeSubagentsStore = derived(version, () => {
    orchestrator.trackStreamMode("updates", "messages-tuple");
    return reactiveSubagents.mapActiveSubagents(orchestrator.activeSubagents);
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
    setBranch(value: string) {
      orchestrator.setBranch(value);
    },

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
      index?: number
    ): MessageMetadata<StateType> | undefined {
      return orchestrator.getMessagesMetadata(message, index);
    },

    submit: (...args: Parameters<typeof orchestrator.submit>) =>
      orchestrator.submit(...args),
    stop: () => orchestrator.stop(),
    joinStream: (...args: Parameters<typeof orchestrator.joinStream>) =>
      orchestrator.joinStream(...args),

    queue: {
      get entries() {
        return queueEntriesRef.current;
      },
      get size() {
        return queueSizeRef.current;
      },
      cancel: (id: string) => orchestrator.cancelQueueItem(id),
      clear: () => orchestrator.clearQueue(),
    },

    switchThread(newThreadId: string | null) {
      orchestrator.switchThread(newThreadId);
    },

    get subagents() {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return subagentsRef.current;
    },
    get activeSubagents() {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return activeSubagentsRef.current;
    },
    getSubagent(toolCallId: string) {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return reactiveSubagents.getSubagent(toolCallId);
    },
    getSubagentsByType(type: string) {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return reactiveSubagents.getSubagentsByType(type);
    },
    getSubagentsByMessage(messageId: string) {
      orchestrator.trackStreamMode("updates", "messages-tuple");
      return reactiveSubagents.getSubagentsByMessage(messageId);
    },
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
export type {
  HeadlessToolImplementation,
  AnyHeadlessToolImplementation,
  ToolEvent,
  HeadlessToolInterrupt,
  OnToolCallback,
  FlushPendingHeadlessToolInterruptsOptions,
} from "@langchain/langgraph-sdk";

export {
  SubagentManager,
  extractToolCallIdFromNamespace,
  calculateDepthFromNamespace,
  extractParentIdFromNamespace,
  isSubagentNamespace,
} from "@langchain/langgraph-sdk/ui";
export {
  isHeadlessToolInterrupt,
  parseHeadlessToolInterruptPayload,
  filterOutHeadlessToolInterrupts,
  findHeadlessTool,
  executeHeadlessTool,
  handleHeadlessToolInterrupt,
  headlessToolResumeCommand,
  flushPendingHeadlessToolInterrupts,
} from "@langchain/langgraph-sdk";
