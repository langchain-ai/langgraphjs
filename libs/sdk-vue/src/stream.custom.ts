import { onScopeDispose, ref, shallowRef, watch } from "vue";
import {
  StreamManager,
  MessageTupleManager,
  extractInterrupts,
  toMessageClass,
  ensureMessageInstances,
  type EventStreamEvent,
  type GetUpdateType,
  type GetCustomEventType,
  type GetInterruptType,
  type GetConfigurableType,
  type AnyStreamCustomOptions,
  type CustomSubmitOptions,
  type MessageMetadata,
} from "@langchain/langgraph-sdk/ui";
import { getToolCallsWithResults } from "@langchain/langgraph-sdk/utils";
import type {
  BagTemplate,
  Message,
  Interrupt,
  ThreadState,
} from "@langchain/langgraph-sdk";

function createCustomTransportThreadState<
  StateType extends Record<string, unknown>,
>(values: StateType, threadId: string): ThreadState<StateType> {
  return {
    values,
    next: [],
    tasks: [],
    metadata: undefined,
    created_at: null,
    checkpoint: {
      thread_id: threadId,
      checkpoint_id: null,
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    parent_checkpoint: null,
  };
}

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

  const streamValues = shallowRef<StateType | null>(stream.values);
  const streamError = shallowRef<unknown>(stream.error);
  const isLoading = shallowRef(stream.isLoading);

  const subagentVersion = shallowRef(0);

  const unsubscribe = stream.subscribe(() => {
    streamValues.value = stream.values;
    streamError.value = stream.error;
    isLoading.value = stream.isLoading;
    subagentVersion.value += 1;
  });

  const branch = ref<string>("");

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
    { flush: "sync" },
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

  onScopeDispose(() => {
    unsubscribe();
    void stream.stop(historyValues, { onStop: options.onStop });
  });

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

    let usableThreadId = threadId ?? submitOptions?.threadId;

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
        if (!usableThreadId) {
          usableThreadId = crypto.randomUUID();
          threadId = usableThreadId;
          options.onThreadId?.(usableThreadId);
        }

        if (!usableThreadId) {
          throw new Error("Failed to obtain valid thread ID.");
        }

        return options.transport.stream({
          input: values,
          context: submitOptions?.context,
          command: submitOptions?.command,
          streamSubgraphs: submitOptions?.streamSubgraphs,
          signal,
          config: {
            ...submitOptions?.config,
            configurable: {
              thread_id: usableThreadId,
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

        onSuccess: () => {
          if (!usableThreadId) return undefined;

          const finalValues = stream.values ?? historyValues;
          options.onFinish?.(
            createCustomTransportThreadState(finalValues, usableThreadId),
            undefined,
          );

          return undefined;
        },
        onError(error) {
          options.onError?.(error, undefined);
          submitOptions?.onError?.(error, undefined);
        },
      },
    );
  }

  async function submit(
    values: UpdateType | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>,
  ) {
    await submitDirect(values, submitOptions);
  }

  function setBranch(value: string) {
    branch.value = value;
  }

  function getMessagesMetadata(
    message: Message,
    index?: number,
  ): MessageMetadata<StateType> | undefined {
    const streamMetadata = messageManager.get(message.id)?.metadata;
    if (streamMetadata != null) {
      return {
        messageId: message.id ?? String(index),
        firstSeenState: undefined,
        branch: undefined,
        branchOptions: undefined,
        streamMetadata,
      } as MessageMetadata<StateType>;
    }
    return undefined;
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

    branch,
    setBranch,
    getMessagesMetadata,

    queue: {
      entries: [],
      size: 0,
      async cancel() {
        return false;
      },
      async clear() {},
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

    get messages() {
      if (!streamValues.value) return [];
      return ensureMessageInstances(getMessages(streamValues.value));
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
      void subagentVersion.value;
      return stream.getSubagents();
    },

    get activeSubagents() {
      void subagentVersion.value;
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
