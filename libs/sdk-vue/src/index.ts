import { computed, onUnmounted, ref, shallowRef } from "vue";
import {
  StreamManager,
  MessageTupleManager,
  getBranchContext,
  getMessagesMetadataMap,
  StreamError,
  extractInterrupts,
  type UseStreamThread,
  type BagTemplate,
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
} from "@langchain/langgraph-sdk";

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

  // TODO: add history fetching
  const history = shallowRef<UseStreamThread<StateType>>({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: async () => undefined,
  });

  const getMessages = (value: StateType): Message[] => {
    const messagesKey = options.messagesKey ?? "messages";
    return Array.isArray(value[messagesKey]) ? value[messagesKey] : [];
  };

  const setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  const threadId = ref<string | undefined>(undefined);

  const branch = ref<string>("");
  const branchContext = computed(() =>
    getBranchContext(branch.value, history.value.data ?? undefined)
  );

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager);
  const client = new Client({ apiUrl: options.apiUrl });

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

  const values = computed(() => stream.values ?? historyValues.value);
  const error = computed(
    () => stream.error ?? historyError.value ?? history.value.error
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

  function submit(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>
  ) {
    return stream.start(
      async (signal) => {
        if (!threadId.value) {
          // generate random thread id
          const thread = await client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          threadId.value = thread.thread_id;
        }

        const streamMode = ["values", "messages-tuple"] as StreamMode[];

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

        return client.runs.stream(threadId.value, options.assistantId, {
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

        initialValues: {} as StateType,
        callbacks: options,

        onSuccess: () => undefined,
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

    messages: computed(() =>
      getMessages(streamValues.value ?? ({} as StateType))
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
