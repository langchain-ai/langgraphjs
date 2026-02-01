/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { filterStream, findLast, unique } from "../ui/utils.js";
import { StreamError } from "../ui/errors.js";
import { getBranchContext } from "../ui/branching.js";
import { EventStreamEvent, StreamManager } from "../ui/manager.js";
import type {
  UseStreamOptions,
  GetUpdateType,
  GetCustomEventType,
  GetInterruptType,
  GetConfigurableType,
  GetToolCallsType,
  RunCallbackMeta,
  MessageMetadata,
  UseStreamThread,
} from "../ui/types.js";
import type { UseStream, SubmitOptions } from "./types.js";
import { Client, getClientConfigHash } from "../client.js";
import type { AIMessage, Message } from "../types.messages.js";
import { getToolCallsWithResults } from "../utils/tools.js";
import type { Interrupt, ThreadState } from "../schema.js";
import type { StreamMode } from "../types.stream.js";
import { MessageTupleManager } from "../ui/messages.js";
import { useControllableThreadId } from "./thread.js";
import type { StreamEvent } from "../types.js";
import type { BagTemplate } from "../types.template.js";

function getFetchHistoryKey(
  client: Client,
  threadId: string | undefined | null,
  limit: boolean | number
) {
  return [getClientConfigHash(client), threadId, limit].join(":");
}

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

function useThreadHistory<StateType extends Record<string, unknown>>(
  client: Client,
  threadId: { value: string | undefined | null },
  limit: boolean | number,
  options: {
    passthrough: boolean;
    submittingRef: { value: string | null };
    onError?: (error: unknown, run?: RunCallbackMeta) => void;
  }
): UseStreamThread<StateType> {
  const key = computed(() => getFetchHistoryKey(client, threadId.value, limit));
  const state = shallowRef<{
    key: string | undefined;
    data: ThreadState<StateType>[] | undefined;
    error: unknown | undefined;
    isLoading: boolean;
  }>({
    key: undefined,
    data: undefined,
    error: undefined,
    isLoading: threadId.value != null,
  });

  const fetcher = async (
    threadIdValue: string | undefined | null,
    limitValue: boolean | number
  ): Promise<ThreadState<StateType>[]> => {
    // If only passthrough is enabled, don't fetch history
    if (options.passthrough) return Promise.resolve([]);

    const k = getFetchHistoryKey(client, threadIdValue, limitValue);

    if (threadIdValue != null) {
      state.value = (() => {
        if (state.value.key === k) return { ...state.value, isLoading: true };
        return { key: k, data: undefined, error: undefined, isLoading: true };
      })();

      return fetchHistory<StateType>(client, threadIdValue, {
        limit: limitValue,
      }).then(
        (data) => {
          state.value = (() => {
            if (state.value.key !== k) return state.value;
            return { key: k, data, error: undefined, isLoading: false };
          })();
          return data;
        },
        (error) => {
          state.value = (() => {
            if (state.value.key !== k) return state.value;
            return { key: k, data: state.value.data, error, isLoading: false };
          })();
          options.onError?.(error);
          return Promise.reject(error);
        }
      );
    }

    state.value = {
      key: k,
      data: undefined,
      error: undefined,
      isLoading: false,
    };
    return Promise.resolve([]);
  };

  watch(
    key,
    () => {
      // Skip if a stream is already in progress, no need to fetch history
      if (
        options.submittingRef.value != null &&
        options.submittingRef.value === threadId.value
      ) {
        return;
      }
      void fetcher(threadId.value, limit);
    },
    { immediate: true }
  );

  return {
    get data() {
      return state.value.data;
    },
    get error() {
      return state.value.error;
    },
    get isLoading() {
      return state.value.isLoading;
    },
    mutate: (mutateId?: string) => fetcher(mutateId ?? threadId.value, limit),
  };
}

export function useStreamLGP<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(options: UseStreamOptions<StateType, Bag>): UseStream<StateType, Bag> {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type CustomType = GetCustomEventType<Bag>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;
  type ToolCallType = GetToolCallsType<StateType>;

  const runMetadataStorage = (() => {
    if (typeof window === "undefined") return null;
    const storage = options.reconnectOnMount;
    if (storage === true) return window.sessionStorage;
    if (typeof storage === "function") return storage();
    return null;
  })();

  const client =
    options.client ??
    new Client({
      apiUrl: options.apiUrl,
      apiKey: options.apiKey,
      callerOptions: options.callerOptions,
      defaultHeaders: options.defaultHeaders,
    });

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager, {
    throttle: options.throttle ?? false,
  });

  // Bridge StreamManager's external store into Vue reactivity.
  const snapshot = shallowRef(stream.getSnapshot());
  const unsubscribe = stream.subscribe(() => {
    snapshot.value = stream.getSnapshot();
  });

  const [threadId, onThreadId] = useControllableThreadId(options);
  const trackStreamModeRef = shallowRef<Exclude<StreamMode, "messages">[]>([]);

  const trackStreamMode = (...mode: Exclude<StreamMode, "messages">[]) => {
    const refModes = trackStreamModeRef.value;
    for (const m of mode) {
      if (!refModes.includes(m)) refModes.push(m);
    }
  };

  const hasUpdateListener = options.onUpdateEvent != null;
  const hasCustomListener = options.onCustomEvent != null;
  const hasLangChainListener = options.onLangChainEvent != null;
  const hasDebugListener = options.onDebugEvent != null;
  const hasCheckpointListener = options.onCheckpointEvent != null;
  const hasTaskListener = options.onTaskEvent != null;

  const callbackStreamMode: Exclude<StreamMode, "messages">[] = (() => {
    const modes: Exclude<StreamMode, "messages">[] = [];
    if (hasUpdateListener) modes.push("updates");
    if (hasCustomListener) modes.push("custom");
    if (hasLangChainListener) modes.push("events");
    if (hasDebugListener) modes.push("debug");
    if (hasCheckpointListener) modes.push("checkpoints");
    if (hasTaskListener) modes.push("tasks");
    return modes;
  })();

  const threadIdRef = shallowRef<string | null>(threadId.value);
  const threadIdStreamingRef = shallowRef<string | null>(null);

  // Cancel the stream if thread ID has changed
  watch(
    threadId,
    (next) => {
      if (threadIdRef.value !== next) {
        threadIdRef.value = next;
        stream.clear();
      }
    },
    { flush: "sync" }
  );

  const historyLimit =
    typeof options.fetchStateHistory === "object" &&
    options.fetchStateHistory != null
      ? options.fetchStateHistory.limit ?? false
      : options.fetchStateHistory ?? false;

  const builtInHistory = useThreadHistory<StateType>(
    client,
    threadId,
    historyLimit,
    {
      passthrough: options.thread != null,
      submittingRef: threadIdStreamingRef,
      onError: options.onError,
    }
  );
  const history = options.thread ?? builtInHistory;

  const getMessages = (value: StateType): Message[] => {
    const messagesKey = options.messagesKey ?? "messages";
    return Array.isArray(value[messagesKey])
      ? (value[messagesKey] as Message[])
      : [];
  };

  const setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  const branch = ref<string>("");
  const setBranch = (nextBranch: string) => {
    branch.value = nextBranch;
  };

  const branchContext = computed(
    () => getBranchContext(branch.value, (history.data ?? undefined) as any) // eslint-disable-line @typescript-eslint/no-explicit-any
  );

  const historyValues = computed<StateType>(() => {
    return (
      (branchContext.value.threadHead?.values as StateType | undefined) ??
      (options.initialValues as StateType | null | undefined) ??
      ({} as StateType)
    );
  });

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

  const messageMetadata = computed(() => {
    const alreadyShown = new Set<string>();
    return getMessages(historyValues.value).map(
      (message, idx): Omit<MessageMetadata<StateType>, "streamMetadata"> => {
        const messageId = message.id ?? idx;

        // Find the first checkpoint where the message was seen
        const firstSeenState = findLast(history.data ?? [], (state) =>
          getMessages(state.values)
            .map((m, i) => m.id ?? i)
            .includes(messageId)
        );

        const checkpointId = firstSeenState?.checkpoint?.checkpoint_id;
        let branch =
          checkpointId != null
            ? branchContext.value.branchByCheckpoint[checkpointId]
            : undefined;
        if (!branch?.branch?.length) branch = undefined;

        // serialize branches
        const optionsShown = branch?.branchOptions?.flat(2).join(",");
        if (optionsShown) {
          if (alreadyShown.has(optionsShown)) branch = undefined;
          alreadyShown.add(optionsShown);
        }

        return {
          messageId: messageId.toString(),
          firstSeenState,
          branch: branch?.branch,
          branchOptions: branch?.branchOptions,
        };
      }
    );
  });

  const stop = () =>
    stream.stop(historyValues.value, {
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

  onScopeDispose(() => {
    unsubscribe();
    void stop();
  });

  const streamStateValues = computed(() => snapshot.value.values?.[0] ?? null);
  const streamIsLoading = computed(() => snapshot.value.isLoading);
  const streamError = computed(() => snapshot.value.error);

  const values = computed(() => streamStateValues.value ?? historyValues.value);

  const submit = async (
    values: UpdateType | null | undefined,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>
  ) => {
    // Unbranch things
    const checkpointId = submitOptions?.checkpoint?.checkpoint_id;
    setBranch(
      checkpointId != null
        ? branchContext.value.branchByCheckpoint[checkpointId]?.branch ?? ""
        : ""
    );

    // When `fetchStateHistory` is requested, thus we assume that branching
    // is enabled. We then need to include the implicit branch.
    const includeImplicitBranch =
      historyLimit === true || typeof historyLimit === "number";

    const shouldRefetch =
      // We're expecting the whole thread state in onFinish
      options.onFinish != null ||
      // We're fetching history, thus we need the latest checkpoint
      // to ensure we're not accidentally submitting to a wrong branch
      includeImplicitBranch;

    let callbackMeta: RunCallbackMeta | undefined;
    let rejoinKey: `lg:stream:${string}` | undefined;
    let usableThreadId = threadId.value;

    await stream.start(
      async (signal: AbortSignal) => {
        stream.setStreamValues((currentValues) => {
          const prev = { ...historyValues.value, ...(currentValues ?? {}) };
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

        if (!usableThreadId) {
          const thread = await client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
            signal,
          });

          usableThreadId = thread.thread_id;

          // Pre-emptively update the thread ID before stream cancellation
          // is kicked off and thread is being refetched.
          threadIdRef.value = usableThreadId;
          threadIdStreamingRef.value = usableThreadId;
          onThreadId(usableThreadId);
        }

        if (!usableThreadId) {
          throw new Error("Failed to obtain valid thread ID.");
        }

        threadIdStreamingRef.value = usableThreadId;

        const streamMode = unique([
          ...(submitOptions?.streamMode ?? []),
          ...trackStreamModeRef.value,
          ...callbackStreamMode,
        ]);

        let checkpoint =
          submitOptions?.checkpoint ??
          (includeImplicitBranch
            ? branchContext.value.threadHead?.checkpoint
            : undefined) ??
          undefined;

        // Avoid specifying a checkpoint if user explicitly set it to null
        if (submitOptions?.checkpoint === null) checkpoint = undefined;

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-expect-error
        if (checkpoint != null) delete checkpoint.thread_id;

        const streamResumable =
          submitOptions?.streamResumable ?? !!runMetadataStorage;

        return client.runs.stream(usableThreadId, options.assistantId, {
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

          if (shouldRefetch) {
            const newHistory = await history.mutate(usableThreadId!);
            const lastHead = newHistory?.at(0);
            if (lastHead) {
              // We now have the latest update from /history
              // Thus we can clear the local stream state
              options.onFinish?.(lastHead, callbackMeta);
              return null;
            }
          }

          return undefined;
        },
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
        onFinish() {
          threadIdStreamingRef.value = null;
        },
      }
    );
  };

  const joinStream = async (
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
  ) => {
    // eslint-disable-next-line no-param-reassign
    lastEventId ??= "-1";
    if (!threadId.value) return;

    const callbackMeta: RunCallbackMeta = {
      thread_id: threadId.value,
      run_id: runId,
    };

    await stream.start(
      async (signal: AbortSignal) => {
        threadIdStreamingRef.value = threadId.value;
        const stream = client.runs.joinStream(threadId.value, runId, {
          signal,
          lastEventId,
          streamMode: joinOptions?.streamMode,
        }) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;

        return joinOptions?.filter != null
          ? filterStream(stream, joinOptions.filter)
          : stream;
      },
      {
        getMessages,
        setMessages,
        initialValues: historyValues.value,
        callbacks: options,
        async onSuccess() {
          runMetadataStorage?.removeItem(`lg:stream:${threadId.value}`);
          const newHistory = await history.mutate(threadId.value!);
          const lastHead = newHistory?.at(0);
          if (lastHead) options.onFinish?.(lastHead, callbackMeta);
        },
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
        onFinish() {
          threadIdStreamingRef.value = null;
        },
      }
    );
  };

  const reconnectKey = computed(() => {
    if (!runMetadataStorage || streamIsLoading.value) return undefined;
    if (typeof window === "undefined") return undefined;
    if (!threadId.value) return undefined;
    const runId = runMetadataStorage.getItem(`lg:stream:${threadId.value}`);
    if (!runId) return undefined;
    return { runId, threadId: threadId.value };
  });

  const shouldReconnect = !!runMetadataStorage;
  const reconnectRef = shallowRef({
    threadId: threadId.value,
    shouldReconnect,
  });

  watch(threadId, (next) => {
    if (reconnectRef.value.threadId !== next) {
      reconnectRef.value = { threadId: next, shouldReconnect };
    }
  });

  watch(reconnectKey, (key) => {
    if (key && reconnectRef.value.shouldReconnect) {
      reconnectRef.value.shouldReconnect = false;
      void joinStream(key.runId);
    }
  });

  const error = computed(() => {
    return streamError.value ?? historyError.value ?? history.error;
  });

  const interrupt = computed((): Interrupt<InterruptType> | undefined => {
    const v = values.value;
    if (
      v != null &&
      "__interrupt__" in v &&
      Array.isArray((v as any).__interrupt__) // eslint-disable-line @typescript-eslint/no-explicit-any
    ) {
      const valueInterrupts = (v as any).__interrupt__ as unknown[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (valueInterrupts.length === 0) return { when: "breakpoint" };
      if (valueInterrupts.length === 1) return valueInterrupts[0] as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      // TODO: fix the typing of interrupts if multiple interrupts are returned
      return valueInterrupts as unknown as Interrupt<InterruptType>;
    }

    // If we're deferring to old interrupt detection logic, don't show the interrupt if the stream is loading
    if (streamIsLoading.value) return undefined;

    const interrupts =
      branchContext.value.threadHead?.tasks?.at(-1)?.interrupts;
    if (interrupts == null || interrupts.length === 0) {
      // check if there's a next task present
      const nextTasks = branchContext.value.threadHead?.next ?? [];
      if (!nextTasks.length || error.value != null) return undefined;
      return { when: "breakpoint" };
    }

    // Return only the current interrupt
    return interrupts.at(-1) as Interrupt<InterruptType> | undefined;
  });

  const messages = computed((): Message<ToolCallType>[] => {
    trackStreamMode("messages-tuple", "values");
    return getMessages(values.value) as Message<ToolCallType>[];
  });

  const toolCalls = computed(() => {
    trackStreamMode("messages-tuple", "values");
    const msgs = getMessages(values.value) as Message<ToolCallType>[];
    return getToolCallsWithResults<ToolCallType>(msgs);
  });

  const getToolCalls = (message: AIMessage<ToolCallType>) => {
    trackStreamMode("messages-tuple", "values");
    const allToolCalls = toolCalls.value;
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  };

  const getMessagesMetadata = (
    message: Message<ToolCallType>,
    index?: number
  ): MessageMetadata<StateType> | undefined => {
    trackStreamMode("values");
    const streamMetadata = messageManager.get(message.id)?.metadata;
    const historyMetadata = messageMetadata.value?.find(
      (m) => m.messageId === (message.id ?? index)?.toString()
    );

    if (streamMetadata != null || historyMetadata != null) {
      return {
        ...historyMetadata,
        streamMetadata,
      } as MessageMetadata<StateType>;
    }

    return undefined;
  };

  const historyComputed = computed(() => {
    if (historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `history`"
      );
    }
    return branchContext.value.flatHistory as ThreadState<StateType>[];
  });

  const branchTreeComputed = computed(() => {
    if (historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `experimental_branchTree`"
      );
    }
    return branchContext.value.branchTree;
  });

  const isThreadLoading = computed(
    () => history.isLoading && history.data == null
  );

  return {
    values: computed(() => {
      trackStreamMode("values");
      return values.value;
    }),
    client,
    assistantId: options.assistantId,
    error,
    isLoading: streamIsLoading,
    stop,
    submit,
    joinStream,
    branch,
    setBranch,
    history: historyComputed,
    isThreadLoading,
    experimental_branchTree: branchTreeComputed,
    interrupt,
    messages,
    toolCalls,
    getToolCalls,
    getMessagesMetadata,
  };
}
