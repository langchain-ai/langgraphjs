import { onUnmounted, ref, shallowRef, watch } from "vue";
import {
  StreamManager,
  MessageTupleManager,
  SubmitQueue,
  extractInterrupts,
  toMessageClass,
  type EventStreamEvent,
  type GetUpdateType,
  type GetCustomEventType,
  type GetInterruptType,
  type GetConfigurableType,
  type AnyStreamCustomOptions,
  type CustomSubmitOptions,
} from "@langchain/langgraph-sdk/ui";
import { getToolCallsWithResults } from "@langchain/langgraph-sdk/utils";
import type { BagTemplate, Message, Interrupt } from "@langchain/langgraph-sdk";

export function useStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(options: AnyStreamCustomOptions<StateType, Bag>) {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type CustomType = GetCustomEventType<Bag>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager, {
    throttle: options.throttle ?? false,
    subagentToolNames: options.subagentToolNames,
    filterSubagentMessages: options.filterSubagentMessages,
    toMessage: toMessageClass,
  });

  const submitQueue = new SubmitQueue<
    StateType,
    CustomSubmitOptions<StateType, ConfigurableType>
  >();
  const queueEntries = shallowRef(submitQueue.entries);
  const queueSize = ref(submitQueue.size);

  const streamValues = shallowRef<StateType | null>(stream.values);
  const streamError = shallowRef<unknown>(stream.error);
  const isLoading = shallowRef(stream.isLoading);

  const unsubscribe = stream.subscribe(() => {
    streamValues.value = stream.values;
    streamError.value = stream.error;
    isLoading.value = stream.isLoading;
  });

  const unsubQueue = submitQueue.subscribe(() => {
    queueEntries.value = submitQueue.entries;
    queueSize.value = submitQueue.size;
  });

  onUnmounted(() => {
    unsubscribe();
    unsubQueue();
  });

  let threadId: string | null = options.threadId ?? null;

  watch(
    () => options.threadId,
    (newId) => {
      const resolved = newId ?? null;
      if (resolved !== threadId) {
        threadId = resolved;
        stream.clear();
      }
    },
  );

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

  const historyValues = options.initialValues ?? ({} as StateType);

  const historyMessages = getMessages(historyValues);
  // @ts-expect-error used in watch callback below
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const shouldReconstructSubagents =
    options.filterSubagentMessages &&
    !stream.isLoading &&
    historyMessages.length > 0;

  watch(
    () => ({
      should:
        options.filterSubagentMessages &&
        !isLoading.value &&
        getMessages(historyValues).length > 0,
      len: getMessages(historyValues).length,
    }),
    ({ should }) => {
      if (should) {
        stream.reconstructSubagents(getMessages(historyValues), {
          skipIfPopulated: true,
        });
      }
    },
    { immediate: true },
  );

  function switchThread(newThreadId: string | null) {
    if (newThreadId !== threadId) {
      threadId = newThreadId;
      stream.clear();
      submitQueue.clear();
    }
  }

  function stop() {
    return stream.stop(historyValues, { onStop: options.onStop });
  }

  async function submitDirect(
    values: UpdateType | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>,
  ) {
    const currentThreadId = options.threadId ?? null;
    if (currentThreadId !== threadId) {
      threadId = currentThreadId;
      stream.clear();
    }

    stream.setStreamValues(() => {
      if (submitOptions?.optimisticValues != null) {
        return {
          ...historyValues,
          ...(typeof submitOptions.optimisticValues === "function"
            ? submitOptions.optimisticValues(historyValues)
            : submitOptions.optimisticValues),
        };
      }

      return { ...historyValues };
    });

    await stream.start(
      async (signal: AbortSignal) => {
        if (!threadId) {
          threadId = crypto.randomUUID();
          options.onThreadId?.(threadId);
        }

        if (!threadId) {
          throw new Error("Failed to obtain valid thread ID.");
        }

        return options.transport.stream({
          input: values,
          context: submitOptions?.context,
          command: submitOptions?.command,
          signal,
          config: {
            ...submitOptions?.config,
            configurable: {
              thread_id: threadId,
              ...submitOptions?.config?.configurable,
            } as unknown as GetConfigurableType<Bag>,
          },
        }) as Promise<
          AsyncGenerator<EventStreamEvent<StateType, UpdateType, CustomType>>
        >;
      },
      {
        getMessages,
        setMessages,

        initialValues: {} as StateType,
        callbacks: options,

        onSuccess: () => undefined,
        onError(error) {
          options.onError?.(error, undefined);
        },
      },
    );
  }

  const submitting = ref(false);
  submitQueue.setDrainHandler(async (entry) => {
    submitting.value = true;
    try {
      await submitDirect(
        entry.values as UpdateType | null | undefined,
        entry.options as CustomSubmitOptions<StateType, ConfigurableType>,
      );
    } finally {
      submitting.value = false;
    }
  });

  watch(
    () => ({
      loading: isLoading.value,
      submitting: submitting.value,
      size: submitQueue.size,
    }),
    ({ loading, submitting: s, size }) => {
      if (!loading && !s && size > 0) {
        submitQueue.drain(options.onQueueError);
      }
    },
  );

  function submit(
    values: UpdateType | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>,
  ) {
    if (options.queue && (stream.isLoading || submitting.value)) {
      submitQueue.enqueue(
        values as Partial<StateType> | null | undefined,
        submitOptions,
      );
      return;
    }
    submitting.value = true;
    const result = submitDirect(values, submitOptions);
    void Promise.resolve(result).finally(() => {
      submitting.value = false;
    });
    return result;
  }

  return {
    get values() {
      return streamValues.value ?? ({} as StateType);
    },

    error: streamError,
    isLoading,

    stop,
    submit,
    switchThread,

    queue: {
      entries: queueEntries,
      size: queueSize,
      cancel: submitQueue.cancel,
      clear: submitQueue.clear,
    },

    get interrupts(): Interrupt<InterruptType>[] {
      if (
        streamValues.value != null &&
        "__interrupt__" in streamValues.value &&
        Array.isArray(streamValues.value.__interrupt__)
      ) {
        const valueInterrupts = streamValues.value.__interrupt__;
        if (valueInterrupts.length === 0) return [{ when: "breakpoint" }];
        return valueInterrupts;
      }

      return [];
    },

    get interrupt(): Interrupt<InterruptType> | undefined {
      return extractInterrupts<InterruptType>(streamValues.value);
    },

    get messages(): Message[] {
      if (!streamValues.value) return [];
      return getMessages(streamValues.value);
    },

    get toolCalls() {
      if (!streamValues.value) return [];
      return getToolCallsWithResults(getMessages(streamValues.value));
    },

    getToolCalls(message: Message) {
      if (!streamValues.value) return [];
      const allToolCalls = getToolCallsWithResults(
        getMessages(streamValues.value),
      );
      return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
    },

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
