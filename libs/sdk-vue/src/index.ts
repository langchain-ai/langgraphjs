import { computed, onUnmounted, ref, shallowRef } from "vue";
import {
  StreamManager,
  MessageTupleManager,
  getBranchContext,
  getMessagesMetadataMap,
  StreamError,
  extractInterrupts,
  type UseStreamThread,
  type GetConfigurableType,
  type GetCustomEventType,
  type GetInterruptType,
  type GetUpdateType,
  type MessageMetadata,
  type UseStreamOptions,
  type SubmitOptions,
  type EventStreamEvent,
} from "@langchain/langgraph-sdk/ui";

import {
  Client,
  type StreamMode,
  type Message,
  type BagTemplate,
  type ThreadState,
} from "@langchain/langgraph-sdk";

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
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(options: UseStreamOptions<StateType, Bag>) {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type CustomType = GetCustomEventType<Bag>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;

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

  function stop() {
    return stream.stop(historyValues.value, { onStop: options.onStop });
  }

  function setBranch(value: string) {
    branch.value = value;
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

        const streamMode: StreamMode[] = [
          "values",
          "messages-tuple",
          ...(submitOptions?.streamMode ?? []),
        ];
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
          onDisconnect: submitOptions?.onDisconnect,

          signal,

          checkpoint,
          streamMode,
          streamSubgraphs: submitOptions?.streamSubgraphs,
          durability: submitOptions?.durability,
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
          if (shouldRefetch && usableThreadId) {
            const newHistory = await mutate(usableThreadId);
            const lastHead = newHistory?.at(0);
            if (lastHead) {
              options.onFinish?.(lastHead, undefined);
              return null;
            }
          }
          return undefined;
        },
        onError: (error) => options.onError?.(error, undefined),
        onFinish: () => {},
      }
    );
  }

  return {
    assistantId: options.assistantId,

    values,
    error,
    isLoading,

    branch,
    setBranch,

    messages: computed(() =>
      getMessages(streamValues.value ?? historyValues.value)
    ),

    interrupt: computed(() =>
      extractInterrupts<InterruptType>(streamValues.value, {
        isLoading: isLoading.value,
        threadState: branchContext.value.threadHead,
        error: streamError.value,
      })
    ),

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
  };
}
