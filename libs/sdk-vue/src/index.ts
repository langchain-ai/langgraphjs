import {
  computed,
  inject,
  onScopeDispose,
  reactive,
  ref,
  shallowRef,
  toValue,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
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
  type ClassToolCallWithResult,
  type ClassSubagentStreamInterface,
} from "@langchain/langgraph-sdk/ui";

import {
  Client,
  type Message,
  type BagTemplate,
  type ToolCallWithResult as _ToolCallWithResult,
  type DefaultToolCall,
} from "@langchain/langgraph-sdk";

import { useStreamCustom } from "./stream.custom.js";
import type { VueReactiveOptions } from "./types.js";
import { LANGCHAIN_OPTIONS, type LangChainPluginOptions } from "./context.js";
import { createReactiveSubagentAccessors } from "./subagents.js";

export { FetchStreamTransport };
export type { VueReactiveOptions } from "./types.js";
export {
  LangChainPlugin,
  provideStream,
  useStreamContext,
  LANGCHAIN_OPTIONS,
} from "./context.js";
export type { LangChainPluginOptions } from "./context.js";

function useStreamLGP<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate,
>(options: VueReactiveOptions<AnyStreamOptions<StateType, Bag>>) {
  const pluginOptions: LangChainPluginOptions = inject(LANGCHAIN_OPTIONS, {});

  const client = computed(() => {
    const c = toValue(options.client) ?? pluginOptions.client;
    if (c) return c;
    return new Client({
      apiUrl: toValue(options.apiUrl) ?? pluginOptions.apiUrl,
      apiKey: toValue(options.apiKey) ?? pluginOptions.apiKey,
      callerOptions: toValue(options.callerOptions),
      defaultHeaders: toValue(options.defaultHeaders),
    });
  });

  const orchestrator = new StreamOrchestrator<StateType, Bag>(
    options as unknown as AnyStreamOptions<StateType, Bag>,
    {
      getClient: () => client.value,
      getAssistantId: () => toValue(options.assistantId),
      getMessagesKey: () => toValue(options.messagesKey) ?? "messages",
    }
  );

  const initialThreadId = toValue(options.threadId) ?? undefined;
  orchestrator.initThreadId(initialThreadId);

  watch(
    () => toValue(options.threadId),
    (newId) => {
      const resolved = newId ?? undefined;
      orchestrator.setThreadId(resolved);
    },
    { flush: "sync" }
  );

  // Monotonically increasing counter bumped on every orchestrator update.
  // Computed properties read `version.value` (via `void version.value`)
  // solely to register a reactive dependency, so Vue knows to invalidate
  // their cached values when the orchestrator state changes.
  const version = shallowRef(0);
  const reactiveSubagents = createReactiveSubagentAccessors(
    {
      getSubagent: (toolCallId) => orchestrator.getSubagent(toolCallId),
      getSubagentsByType: (type) => orchestrator.getSubagentsByType(type),
      getSubagentsByMessage: (messageId) =>
        orchestrator.getSubagentsByMessage(messageId),
    },
    version
  );
  const subagentsRef = shallowRef(
    reactiveSubagents.mapSubagents(orchestrator.subagents)
  );
  const activeSubagentsRef = shallowRef(
    reactiveSubagents.mapActiveSubagents(orchestrator.activeSubagents)
  );

  const unsubscribe = orchestrator.subscribe(() => {
    version.value += 1;
    subagentsRef.value = reactiveSubagents.mapSubagents(orchestrator.subagents);
    activeSubagentsRef.value = reactiveSubagents.mapActiveSubagents(
      orchestrator.activeSubagents
    );
  });

  onScopeDispose(() => {
    unsubscribe();
    orchestrator.dispose();
  });

  // Subagent reconstruction
  watch(
    () => {
      void version.value;
      const hvMessages = orchestrator.messages;
      return {
        should:
          options.filterSubagentMessages &&
          !orchestrator.isLoading &&
          !orchestrator.historyData.isLoading &&
          hvMessages.length > 0,
        len: hvMessages.length,
      };
    },
    ({ should }, _prev, onCleanup) => {
      if (should) {
        const controller = orchestrator.reconstructSubagentsIfNeeded();
        if (controller) {
          onCleanup(() => controller.abort());
        }
      }
    },
    { immediate: true }
  );

  // Queue draining
  watch(
    () => ({
      loading: orchestrator.isLoading,
      size: orchestrator.queueSize,
      v: version.value,
    }),
    () => {
      orchestrator.drainQueue();
    }
  );

  // Auto-reconnect
  let { shouldReconnect } = orchestrator;
  if (shouldReconnect) {
    orchestrator.tryReconnect();
  }

  watch(
    () => {
      void version.value;
      return orchestrator.threadId;
    },
    () => {
      ({ shouldReconnect } = orchestrator);
      if (shouldReconnect) {
        orchestrator.tryReconnect();
      }
    }
  );

  // Cached computed properties derived from the orchestrator.
  //
  // The orchestrator is not itself reactive — it is a plain object whose
  // state is mutated in place. To bridge it into Vue's reactivity system
  // we bump `version` (a shallowRef) inside the orchestrator's subscribe
  // callback. Each computed below reads `version.value` (via `void`) to
  // register it as a dependency. When `version` increments, Vue marks
  // every computed that depends on it as dirty, causing a re-evaluation
  // on the next access. The `void` operator discards the unused value
  // and signals this intent to future readers.
  const values = computed(() => {
    void version.value;
    return orchestrator.values;
  });

  const error = computed(() => {
    void version.value;
    return orchestrator.error;
  });

  const isLoading = computed(() => {
    void version.value;
    return orchestrator.isLoading;
  });

  const branch = ref<string>("");
  watch(
    () => {
      void version.value;
      return orchestrator.branch;
    },
    (newBranch) => {
      if (branch.value !== newBranch) branch.value = newBranch;
    },
    { immediate: true }
  );

  const messages = computed(() => {
    void version.value;
    orchestrator.trackStreamMode("messages-tuple");
    return ensureMessageInstances(orchestrator.messages);
  });

  const toolCalls = computed(() => {
    void version.value;
    return orchestrator.toolCalls;
  });

  const interrupt = computed(() => {
    void version.value;
    return orchestrator.interrupt;
  });

  const interrupts = computed(() => {
    void version.value;
    return orchestrator.interrupts;
  });

  const flatHistory = computed(() => {
    void version.value;
    return orchestrator.flatHistory;
  });

  const isThreadLoading = computed(() => {
    void version.value;
    return orchestrator.isThreadLoading;
  });

  const experimentalBranchTree = computed(() => {
    void version.value;
    return orchestrator.experimental_branchTree;
  });

  const queueEntries = computed(() => {
    void version.value;
    return orchestrator.queueEntries;
  });

  const queueSize = computed(() => {
    void version.value;
    return orchestrator.queueSize;
  });

  return {
    get assistantId() {
      return toValue(options.assistantId);
    },
    get client() {
      return client.value;
    },

    values,
    error,
    isLoading,

    branch,
    setBranch(value: string) {
      orchestrator.setBranch(value);
    },

    messages,
    toolCalls,

    getToolCalls(message: Message) {
      orchestrator.trackStreamMode("messages-tuple");
      return orchestrator.getToolCalls(message);
    },

    interrupt,
    interrupts,
    history: flatHistory,
    isThreadLoading,
    experimental_branchTree: experimentalBranchTree,

    getMessagesMetadata: (
      message: Message,
      index?: number
    ): MessageMetadata<StateType> | undefined => {
      return orchestrator.getMessagesMetadata(message, index);
    },

    submit: (...args: Parameters<typeof orchestrator.submit>) =>
      orchestrator.submit(...args),
    stop: () => orchestrator.stop(),
    joinStream: (...args: Parameters<typeof orchestrator.joinStream>) =>
      orchestrator.joinStream(...args),

    queue: reactive({
      entries: queueEntries,
      size: queueSize,
      cancel: (id: string) => orchestrator.cancelQueueItem(id),
      clear: () => orchestrator.clearQueue(),
    }),

    switchThread(newThreadId: string | null) {
      orchestrator.switchThread(newThreadId);
    },

    get subagents() {
      void messages.value.length;
      void version.value;
      return reactiveSubagents.mapSubagents(orchestrator.subagents);
    },
    get activeSubagents() {
      void messages.value.length;
      void version.value;
      return reactiveSubagents.mapActiveSubagents(orchestrator.activeSubagents);
    },
    getSubagent(toolCallId: string) {
      void messages.value.length;
      void version.value;
      return reactiveSubagents.getSubagent(toolCallId);
    },
    getSubagentsByType(type: string) {
      void messages.value.length;
      void version.value;
      return reactiveSubagents.getSubagentsByType(type);
    },
    getSubagentsByMessage(messageId: string) {
      void messages.value.length;
      void version.value;
      return reactiveSubagents.getSubagentsByMessage(messageId);
    },
  };
}

export type { ClassSubagentStreamInterface } from "@langchain/langgraph-sdk/ui";

type WithClassMessages<T> = {
  [K in keyof T as K extends
    | "getSubagent"
    | "getSubagentsByType"
    | "getSubagentsByMessage"
    ? never
    : K]: K extends "messages"
    ? ComputedRef<BaseMessage[]>
    : K extends "getMessagesMetadata"
      ? (
          message: BaseMessage,
          index?: number
        ) => MessageMetadata<Record<string, unknown>> | undefined
      : K extends "toolCalls"
        ? T[K] extends (infer TC)[]
          ? Ref<ClassToolCallWithResult<TC>[]>
          : Ref<T[K]>
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
                        options?: infer O
                      ) => infer Ret
                      ? (
                          values:
                            | AcceptBaseMessages<Exclude<V, null | undefined>>
                            | null
                            | undefined,
                          options?: O
                        ) => Ret
                      : T[K]
                    : K extends "history"
                      ? ComputedRef<HistoryWithBaseMessages<T[K]>>
                      : T[K] extends (...args: infer A) => infer R
                        ? (...args: A) => R
                        : Ref<T[K]>;
} & ("subagents" extends keyof T
  ? {
      getSubagent: T extends {
        getSubagent: (
          id: string
        ) => SubagentStreamInterface<infer S, infer TC, infer N> | undefined;
      }
        ? (
            toolCallId: string
          ) => ClassSubagentStreamInterface<S, TC, N> | undefined
        : never;
      getSubagentsByType: T extends {
        getSubagentsByType: (
          type: string
        ) => SubagentStreamInterface<infer S, infer TC, infer N>[];
      }
        ? (type: string) => ClassSubagentStreamInterface<S, TC, N>[]
        : never;
      getSubagentsByMessage: T extends {
        getSubagentsByMessage: (
          id: string
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
  options: VueReactiveOptions<ResolveStreamOptions<T, InferBag<T, Bag>>>
): WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: VueReactiveOptions<
    UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>
  >
): WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStream(options: any): any {
  if ("transport" in options) {
    return useStreamCustom(options);
  }
  return useStreamLGP(options);
}

export type { MaybeRefOrGetter } from "vue";

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
