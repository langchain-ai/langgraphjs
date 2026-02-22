import { signal, computed, effect } from "@angular/core";
import type { BaseMessage } from "@langchain/core/messages";
import {
  StreamManager,
  MessageTupleManager,
  filterStream,
  getBranchContext,
  getMessagesMetadataMap,
  StreamError,
  extractInterrupts,
  toMessageClass,
  type UseStreamThread,
  type GetConfigurableType,
  type GetCustomEventType,
  type GetInterruptType,
  type GetUpdateType,
  type MessageMetadata,
  type AnyStreamOptions,
  type SubmitOptions,
  type EventStreamEvent,
  type RunCallbackMeta,
  type ResolveStreamOptions,
  type ResolveStreamInterface,
  type InferBag,
  type InferStateType,
  type UseStreamCustomOptions,
} from "@langchain/langgraph-sdk/ui";

import {
  Client,
  type StreamEvent,
  type StreamMode,
  type Message,
  type Interrupt,
  type BagTemplate,
  type ThreadState,
} from "@langchain/langgraph-sdk";
import { getToolCallsWithResults } from "@langchain/langgraph-sdk/utils";
import { useStreamCustom } from "./stream.custom.js";

export { FetchStreamTransport } from "@langchain/langgraph-sdk/ui";

type WithClassMessages<T> = Omit<T, "messages" | "getMessagesMetadata"> & {
  messages: BaseMessage[];
  getMessagesMetadata: (
    message: BaseMessage,
    index?: number
  ) => MessageMetadata<Record<string, unknown>> | undefined;
};

function fetchHistory<StateType extends Record<string, unknown>>(
  client: Client,
  threadId: string,
  options?: { limit?: boolean | number }
) {
  if (options?.limit === false) {
    return client.threads.getState<StateType>(threadId).then((state) => {
      if (state.checkpoint == null) return [];
      return [state];
    });
  }

  const limit = typeof options?.limit === "number" ? options.limit : 10;
  return client.threads.getHistory<StateType>(threadId, { limit });
}

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(
  options: ResolveStreamOptions<T, InferBag<T, Bag>>
): WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
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

function resolveRunMetadataStorage(
  reconnectOnMount: AnyStreamOptions["reconnectOnMount"]
) {
  if (typeof globalThis.window === "undefined") return null;
  if (reconnectOnMount === true) return globalThis.window.sessionStorage;
  if (typeof reconnectOnMount === "function") return reconnectOnMount();
  return null;
}

export function useStreamLGP<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(options: AnyStreamOptions<StateType, Bag>) {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type CustomType = GetCustomEventType<Bag>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;

  const runMetadataStorage = resolveRunMetadataStorage(
    options.reconnectOnMount
  );

  const getMessages = (value: StateType): Message[] => {
    const messagesKey = options.messagesKey ?? "messages";
    return Array.isArray(value[messagesKey]) ? value[messagesKey] : [];
  };

  const setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  const historyLimit =
    typeof options.fetchStateHistory === "object" &&
    options.fetchStateHistory != null
      ? options.fetchStateHistory.limit ?? false
      : options.fetchStateHistory ?? false;

  const threadId = signal<string | undefined>(undefined);

  const client = options.client ?? new Client({ apiUrl: options.apiUrl });

  const history = signal<UseStreamThread<StateType>>({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: async () => undefined,
  });

  async function mutate(
    mutateId?: string
  ): Promise<ThreadState<StateType>[] | undefined> {
    const tid = mutateId ?? threadId();
    if (!tid) return undefined;
    try {
      const data = await fetchHistory<StateType>(client, tid, {
        limit: historyLimit,
      });
      history.set({
        data,
        error: undefined,
        isLoading: false,
        mutate,
      });
      return data;
    } catch (err) {
      history.update((prev) => ({
        ...prev,
        error: err,
        isLoading: false,
      }));
      options.onError?.(err, undefined);
      return undefined;
    }
  }

  history.update((prev) => ({ ...prev, mutate }));

  const branch = signal<string>("");
  const branchContext = computed(() =>
    getBranchContext(branch(), history().data ?? undefined)
  );

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager, {
    throttle: options.throttle ?? false,
    subagentToolNames: options.subagentToolNames,
    filterSubagentMessages: options.filterSubagentMessages,
    toMessage: toMessageClass,
  });

  const historyValues = computed(
    () =>
      branchContext().threadHead?.values ??
      options.initialValues ??
      ({} as StateType)
  );

  const historyError = computed(() => {
    const error = branchContext().threadHead?.tasks?.at(-1)?.error;
    if (error == null) return undefined;
    try {
      const parsed = JSON.parse(error) as unknown;
      if (StreamError.isStructuredError(parsed)) return new StreamError(parsed);
      return parsed;
    } catch {
      // do nothing
    }
    return error;
  });

  const streamValues = signal<StateType | null>(stream.values);
  const streamError = signal<unknown>(stream.error);
  const isLoading = signal(stream.isLoading);

  const values = computed(() => streamValues() ?? historyValues());
  const error = computed(
    () => streamError() ?? historyError() ?? history().error
  );

  const messageMetadata = computed(() =>
    getMessagesMetadataMap({
      initialValues: options.initialValues,
      history: history().data,
      getMessages,
      branchContext: branchContext(),
    })
  );

  effect((onCleanup) => {
    const unsubscribe = stream.subscribe(() => {
      streamValues.set(stream.values);
      streamError.set(stream.error);
      isLoading.set(stream.isLoading);
    });

    onCleanup(() => unsubscribe());
  });

  effect(() => {
    const hvMessages = getMessages(historyValues());
    const should =
      options.filterSubagentMessages &&
      !isLoading() &&
      !history().isLoading &&
      hvMessages.length > 0;
    if (should) {
      stream.reconstructSubagents(hvMessages, { skipIfPopulated: true });
    }
  });

  function stop() {
    return stream.stop(historyValues(), {
      onStop: (args) => {
        if (runMetadataStorage && threadId()) {
          const tid = threadId()!;
          const runId = runMetadataStorage.getItem(`lg:stream:${tid}`);
          if (runId) void client.runs.cancel(tid, runId);
          runMetadataStorage.removeItem(`lg:stream:${tid}`);
        }

        options.onStop?.(args);
      },
    });
  }

  function setBranch(value: string) {
    branch.set(value);
  }

  function submit(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>
  ) {
    const currentBranchContext = branchContext();

    const checkpointId = submitOptions?.checkpoint?.checkpoint_id;
    branch.set(
      checkpointId != null
        ? currentBranchContext.branchByCheckpoint[checkpointId]?.branch ?? ""
        : ""
    );

    const includeImplicitBranch =
      historyLimit === true || typeof historyLimit === "number";

    const shouldRefetch =
      options.onFinish != null || includeImplicitBranch;

    let checkpoint =
      submitOptions?.checkpoint ??
      (includeImplicitBranch
        ? currentBranchContext.threadHead?.checkpoint
        : undefined) ??
      undefined;

    if (submitOptions?.checkpoint === null) checkpoint = undefined;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    if (checkpoint != null) delete checkpoint.thread_id;

    const streamResumable =
      submitOptions?.streamResumable ?? !!runMetadataStorage;

    let callbackMeta: RunCallbackMeta | undefined;
    let rejoinKey: `lg:stream:${string}` | undefined;
    let usableThreadId: string | undefined;

    return stream.start(
      async (signal) => {
        usableThreadId = threadId();
        if (!usableThreadId) {
          const thread = await client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          usableThreadId = thread.thread_id;
          threadId.set(usableThreadId);
          options.onThreadId?.(usableThreadId);
        }

        const streamMode = new Set<StreamMode>([
          ...(submitOptions?.streamMode ?? []),
          "values",
          "messages-tuple",
        ]);
        if (options.onUpdateEvent) streamMode.add("updates");
        if (options.onCustomEvent) streamMode.add("custom");
        if (options.onCheckpointEvent) streamMode.add("checkpoints");
        if (options.onTaskEvent) streamMode.add("tasks");
        if ("onDebugEvent" in options && options.onDebugEvent)
          streamMode.add("debug");
        if ("onLangChainEvent" in options && options.onLangChainEvent)
          streamMode.add("events");

        stream.setStreamValues(() => {
          const prev = { ...historyValues(), ...stream.values };

          if (submitOptions?.optimisticValues != null) {
            return {
              ...prev,
              ...(typeof submitOptions.optimisticValues === "function"
                ? submitOptions.optimisticValues(prev)
                : submitOptions.optimisticValues),
            };
          }

          return { ...prev };
        });

        return client.runs.stream(usableThreadId!, options.assistantId, {
          input: values as Record<string, unknown>,
          config: submitOptions?.config,
          context: submitOptions?.context,
          command: submitOptions?.command,

          interruptBefore: submitOptions?.interruptBefore,
          interruptAfter: submitOptions?.interruptAfter,
          metadata: submitOptions?.metadata,
          multitaskStrategy: submitOptions?.multitaskStrategy,
          onCompletion: submitOptions?.onCompletion,
          onDisconnect:
            submitOptions?.onDisconnect ??
            (streamResumable ? "continue" : "cancel"),

          signal,

          checkpoint,
          streamMode: [...streamMode],
          streamSubgraphs: submitOptions?.streamSubgraphs,
          streamResumable,
          durability: submitOptions?.durability,
          onRunCreated(params) {
            callbackMeta = {
              run_id: params.run_id,
              thread_id: params.thread_id ?? usableThreadId!,
            };

            if (runMetadataStorage) {
              rejoinKey = `lg:stream:${usableThreadId}`;
              runMetadataStorage.setItem(rejoinKey, callbackMeta.run_id);
            }

            options.onCreated?.(callbackMeta);
          },
        }) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;
      },
      {
        getMessages,
        setMessages,

        initialValues: historyValues(),
        callbacks: options,

        async onSuccess() {
          if (rejoinKey) runMetadataStorage?.removeItem(rejoinKey);

          if (shouldRefetch && usableThreadId) {
            const newHistory = await mutate(usableThreadId);
            const lastHead = newHistory?.at(0);
            if (lastHead) {
              options.onFinish?.(lastHead, callbackMeta);
              return null;
            }
          }
          return undefined;
        },
        onError: (error) => options.onError?.(error, callbackMeta),
        onFinish: () => {},
      }
    );
  }

  async function joinStream(
    runId: string,
    lastEventId?: string,
    joinOptions?: {
      streamMode?: StreamMode | StreamMode[];
      filter?: (event: {
        id?: string;
        event: StreamEvent;
        data: unknown;
      }) => boolean;
    }
  ) {
    // eslint-disable-next-line no-param-reassign
    lastEventId ??= "-1";
    const tid = threadId();
    if (!tid) return;

    const callbackMeta: RunCallbackMeta = {
      thread_id: tid,
      run_id: runId,
    };

    await stream.start(
      async (signal: AbortSignal) => {
        const rawStream = client.runs.joinStream(tid, runId, {
          signal,
          lastEventId,
          streamMode: joinOptions?.streamMode,
        }) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;

        return joinOptions?.filter != null
          ? filterStream(rawStream, joinOptions.filter)
          : rawStream;
      },
      {
        getMessages,
        setMessages,

        initialValues: historyValues(),
        callbacks: options,
        async onSuccess() {
          runMetadataStorage?.removeItem(`lg:stream:${tid}`);
          const newHistory = await mutate(tid);
          const lastHead = newHistory?.at(0);
          if (lastHead) options.onFinish?.(lastHead, callbackMeta);
        },
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
        onFinish() {},
      }
    );
  }

  const shouldReconnect = !!runMetadataStorage;
  let hasReconnected = false;

  effect(() => {
    const tid = threadId();
    if (
      !hasReconnected &&
      shouldReconnect &&
      runMetadataStorage &&
      tid &&
      !isLoading()
    ) {
      const runId = runMetadataStorage.getItem(`lg:stream:${tid}`);
      if (runId) {
        hasReconnected = true;
        void joinStream(runId);
      }
    }
  });

  const messages = computed(() => getMessages(values()));

  const toolCalls = computed(() => getToolCallsWithResults(getMessages(values())));

  function getToolCalls(message: Message) {
    const allToolCalls = getToolCallsWithResults(getMessages(values()));
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  }

  const interrupt = computed(() =>
    extractInterrupts<InterruptType>(values(), {
      isLoading: isLoading(),
      threadState: branchContext().threadHead,
      error: error(),
    })
  );

  const interrupts = computed((): Interrupt<InterruptType>[] => {
    const vals = values();
    if (
      vals != null &&
      "__interrupt__" in vals &&
      Array.isArray(vals.__interrupt__)
    ) {
      const valueInterrupts = vals.__interrupt__;
      if (valueInterrupts.length === 0) return [{ when: "breakpoint" }];
      return valueInterrupts;
    }

    if (isLoading()) return [];

    const allTasks = branchContext().threadHead?.tasks ?? [];
    const allInterrupts = allTasks.flatMap((t) => t.interrupts ?? []);

    if (allInterrupts.length > 0) {
      return allInterrupts as Interrupt<InterruptType>[];
    }

    const next = branchContext().threadHead?.next ?? [];
    if (!next.length || error() != null) return [];
    return [{ when: "breakpoint" }];
  });

  const historyList = computed(() => {
    if (historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `history`"
      );
    }
    return branchContext().flatHistory;
  });

  const isThreadLoading = computed(
    () => history().isLoading && history().data == null
  );

  const experimentalBranchTree = computed(() => {
    if (historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `experimental_branchTree`"
      );
    }
    return branchContext().branchTree;
  });

  function getMessagesMetadata(
    message: Message,
    index?: number
  ): MessageMetadata<StateType> | undefined {
    const streamMetadata = messageManager.get(message.id)?.metadata;
    const historyMetadata = messageMetadata().find(
      (m) => m.messageId === (message.id ?? index)
    );

    if (streamMetadata != null || historyMetadata != null) {
      return {
        ...historyMetadata,
        streamMetadata,
      } as MessageMetadata<StateType>;
    }

    return undefined;
  }

  return {
    assistantId: options.assistantId,
    client,

    values,
    error,
    isLoading,

    branch,
    setBranch,

    messages,
    toolCalls,
    getToolCalls,

    interrupt,
    interrupts,

    history: historyList,
    isThreadLoading,
    experimental_branchTree: experimentalBranchTree,

    getMessagesMetadata,

    submit,
    stop,
    joinStream,

    get subagents() {
      return stream.getSubagents();
    },
    get activeSubagents() {
      return stream.getActiveSubagents();
    },
    getSubagent(toolCallId: string) {
      return stream.getSubagent(toolCallId);
    },
    getSubagentsByType(type: string) {
      return stream.getSubagentsByType(type);
    },
    getSubagentsByMessage(messageId: string) {
      return stream.getSubagentsByMessage(messageId);
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
} from "@langchain/langgraph-sdk/ui";

export type {
  ToolCallWithResult,
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
