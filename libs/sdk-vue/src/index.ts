import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import {
  StreamManager,
  MessageTupleManager,
  filterStream,
  unique,
  getBranchContext,
  getMessagesMetadataMap,
  StreamError,
  extractInterrupts,
  FetchStreamTransport,
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
} from "@langchain/langgraph-sdk/ui";
import { getToolCallsWithResults } from "@langchain/langgraph-sdk/utils";

import {
  Client,
  type StreamMode,
  type StreamEvent,
  type Message,
  type Interrupt,
  type BagTemplate,
  type ThreadState,
} from "@langchain/langgraph-sdk";

import { useStreamCustom } from "./stream.custom.js";

export { FetchStreamTransport };

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

function useStreamLGP<
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

  const runMetadataStorage = (() => {
    if (typeof window === "undefined") return null;
    const storage = options.reconnectOnMount;
    if (storage === true) return window.sessionStorage;
    if (typeof storage === "function") return storage();
    return null;
  })();

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

  const threadId = ref<string | undefined>(undefined);

  const client = options.client ?? new Client({ apiUrl: options.apiUrl });

  const history = shallowRef<UseStreamThread<StateType>>({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: async () => undefined,
  });

  async function mutate(
    mutateId?: string
  ): Promise<ThreadState<StateType>[] | undefined> {
    const tid = mutateId ?? threadId.value;
    if (!tid) return undefined;
    try {
      const data = await fetchHistory<StateType>(client, tid, {
        limit: historyLimit,
      });
      history.value = {
        data,
        error: undefined,
        isLoading: false,
        mutate,
      };
      return data;
    } catch (err) {
      history.value = {
        ...history.value,
        error: err,
        isLoading: false,
      };
      options.onError?.(err, undefined);
      return undefined;
    }
  }

  history.value = { ...history.value, mutate };

  const branch = ref<string>("");
  const branchContext = computed(() =>
    getBranchContext(branch.value, history.value.data ?? undefined)
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
      branchContext.value.threadHead?.values ??
      options.initialValues ??
      ({} as StateType)
  );

  const historyError = computed(() => {
    const error = branchContext.value.threadHead?.tasks?.at(-1)?.error;
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

  const streamValues = shallowRef<StateType | null>(stream.values);
  const streamError = shallowRef<unknown>(stream.error);
  const isLoading = shallowRef(stream.isLoading);

  const values = computed(() => streamValues.value ?? historyValues.value);
  const error = computed(
    () => streamError.value ?? historyError.value ?? history.value.error
  );

  const messageMetadata = computed(() =>
    getMessagesMetadataMap({
      initialValues: options.initialValues,
      history: history.value.data,
      getMessages,
      branchContext: branchContext.value,
    })
  );

  const unsubscribe = stream.subscribe(() => {
    streamValues.value = stream.values;
    streamError.value = stream.error;
    isLoading.value = stream.isLoading;
  });

  onUnmounted(() => unsubscribe());

  watch(
    () => {
      const hvMessages = getMessages(historyValues.value);
      return {
        should:
          options.filterSubagentMessages &&
          !isLoading.value &&
          !history.value.isLoading &&
          hvMessages.length > 0,
        len: hvMessages.length,
      };
    },
    ({ should }) => {
      if (should) {
        const hvMessages = getMessages(historyValues.value);
        stream.reconstructSubagents(hvMessages, { skipIfPopulated: true });
      }
    },
    { immediate: true }
  );

  function stop() {
    return stream.stop(historyValues.value, {
      onStop: (args) => {
        if (runMetadataStorage && threadId.value) {
          const runId = runMetadataStorage.getItem(
            `lg:stream:${threadId.value}`
          );
          if (runId) void client.runs.cancel(threadId.value, runId);
          runMetadataStorage.removeItem(`lg:stream:${threadId.value}`);
        }

        options.onStop?.(args);
      },
    });
  }

  function setBranch(value: string) {
    branch.value = value;
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
    if (!threadId.value) return;

    const callbackMeta: RunCallbackMeta = {
      thread_id: threadId.value,
      run_id: runId,
    };

    await stream.start(
      async (signal: AbortSignal) => {
        const rawStream = client.runs.joinStream(
          threadId.value!,
          runId,
          {
            signal,
            lastEventId,
            streamMode: joinOptions?.streamMode,
          }
        ) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;

        return joinOptions?.filter != null
          ? filterStream(rawStream, joinOptions.filter)
          : rawStream;
      },
      {
        getMessages,
        setMessages,

        initialValues: historyValues.value,
        callbacks: options,
        async onSuccess() {
          runMetadataStorage?.removeItem(`lg:stream:${threadId.value}`);
          const newHistory = await mutate(threadId.value);
          const lastHead = newHistory?.at(0);
          if (lastHead) options.onFinish?.(lastHead, callbackMeta);
        },
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
      }
    );
  }

  function submit(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>
  ) {
    const currentBranchContext = branchContext.value;

    const checkpointId = submitOptions?.checkpoint?.checkpoint_id;
    branch.value =
      checkpointId != null
        ? currentBranchContext.branchByCheckpoint[checkpointId]?.branch ?? ""
        : "";

    const includeImplicitBranch =
      historyLimit === true || typeof historyLimit === "number";

    const shouldRefetch = options.onFinish != null || includeImplicitBranch;

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

    let callbackMeta: RunCallbackMeta | undefined;
    let rejoinKey: `lg:stream:${string}` | undefined;
    let usableThreadId: string | undefined;

    return stream.start(
      async (signal) => {
        usableThreadId = threadId.value;
        if (!usableThreadId) {
          const thread = await client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          usableThreadId = thread.thread_id;
          threadId.value = usableThreadId;
          options.onThreadId?.(usableThreadId);
        }

        const streamMode = unique([
          ...(submitOptions?.streamMode ?? []),
          "values" as StreamMode,
          "messages-tuple" as StreamMode,
        ]);

        if (options.onUpdateEvent && !streamMode.includes("updates"))
          streamMode.push("updates");
        if (options.onCustomEvent && !streamMode.includes("custom"))
          streamMode.push("custom");
        if (options.onCheckpointEvent && !streamMode.includes("checkpoints"))
          streamMode.push("checkpoints");
        if (options.onTaskEvent && !streamMode.includes("tasks"))
          streamMode.push("tasks");
        if (
          "onDebugEvent" in options &&
          options.onDebugEvent &&
          !streamMode.includes("debug")
        )
          streamMode.push("debug");
        if (
          "onLangChainEvent" in options &&
          options.onLangChainEvent &&
          !streamMode.includes("events")
        )
          streamMode.push("events");

        stream.setStreamValues(() => {
          const prev = { ...historyValues.value, ...stream.values };

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

        const streamResumable =
          submitOptions?.streamResumable ?? !!runMetadataStorage;

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
          streamMode,
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

        initialValues: historyValues.value,
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

  // --- Auto-reconnect on mount ---
  let shouldReconnect = !!runMetadataStorage;

  onMounted(() => {
    if (shouldReconnect && runMetadataStorage && threadId.value) {
      const runId = runMetadataStorage.getItem(
        `lg:stream:${threadId.value}`
      );
      if (runId) {
        shouldReconnect = false;
        void joinStream(runId);
      }
    }
  });

  watch(
    () => threadId.value,
    () => {
      shouldReconnect = !!runMetadataStorage;
    }
  );

  const toolCalls = computed(() =>
    getToolCallsWithResults(getMessages(values.value))
  );

  function getToolCalls(message: Message) {
    const allToolCalls = getToolCallsWithResults(getMessages(values.value));
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  }

  const interrupts = computed((): Interrupt<InterruptType>[] => {
    const v = values.value;
    if (
      v != null &&
      "__interrupt__" in v &&
      Array.isArray(v.__interrupt__)
    ) {
      const valueInterrupts = v.__interrupt__;
      if (valueInterrupts.length === 0) return [{ when: "breakpoint" }];
      return valueInterrupts;
    }

    if (isLoading.value) return [];

    const allTasks = branchContext.value.threadHead?.tasks ?? [];
    const allInterrupts = allTasks.flatMap((t) => t.interrupts ?? []);

    if (allInterrupts.length > 0) {
      return allInterrupts as Interrupt<InterruptType>[];
    }

    const next = branchContext.value.threadHead?.next ?? [];
    if (!next.length || error.value != null) return [];
    return [{ when: "breakpoint" }];
  });

  const flatHistory = computed(() => {
    if (historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `history`"
      );
    }
    return branchContext.value.flatHistory;
  });

  const isThreadLoading = computed(
    () => history.value.isLoading && history.value.data == null
  );

  const experimentalBranchTree = computed(() => {
    if (historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `experimental_branchTree`"
      );
    }
    return branchContext.value.branchTree;
  });

  return {
    assistantId: options.assistantId,
    client,

    values,
    error,
    isLoading,

    branch,
    setBranch,

    messages: computed(() =>
      getMessages(streamValues.value ?? historyValues.value)
    ),

    toolCalls,
    getToolCalls,

    interrupt: computed(() =>
      extractInterrupts<InterruptType>(streamValues.value, {
        isLoading: isLoading.value,
        threadState: branchContext.value.threadHead,
        error: streamError.value,
      })
    ),

    interrupts,
    history: flatHistory,
    isThreadLoading,
    experimental_branchTree: experimentalBranchTree,

    getMessagesMetadata: (
      message: Message,
      index?: number
    ): MessageMetadata<StateType> | undefined => {
      const streamMetadata = messageManager.get(message.id)?.metadata;
      const historyMetadata = messageMetadata.value?.find(
        (m) => m.messageId === (message.id ?? index)
      );

      if (streamMetadata != null || historyMetadata != null) {
        return {
          ...historyMetadata,
          streamMetadata,
        } as MessageMetadata<StateType>;
      }

      return undefined;
    },

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

export function useStream<
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _T = Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _Bag extends BagTemplate = BagTemplate
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
>(options: any): any {
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
