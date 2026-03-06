import { signal, computed, effect } from "@angular/core";
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
  type GetToolCallsType,
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
  type ToolCallType = GetToolCallsType<StateType>;

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager, {
    throttle: options.throttle ?? false,
    subagentToolNames: options.subagentToolNames,
    filterSubagentMessages: options.filterSubagentMessages,
    toMessage: toMessageClass,
  });

  const streamValues = signal<StateType | null>(stream.values);
  const streamError = signal<unknown>(stream.error);
  const isLoading = signal(stream.isLoading);

  const subagentVersion = signal(0);

  effect((onCleanup) => {
    const unsubscribe = stream.subscribe(() => {
      streamValues.set(stream.values);
      streamError.set(stream.error);
      isLoading.set(stream.isLoading);
      subagentVersion.update((v) => v + 1);
    });

    onCleanup(() => unsubscribe());
  });

  let threadId: string | null = options.threadId ?? null;

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
  const shouldReconstructSubagents =
    options.filterSubagentMessages &&
    !stream.isLoading &&
    historyMessages.length > 0;

  effect(() => {
    const loading = isLoading();
    const hvMessages = getMessages(historyValues);
    const should =
      options.filterSubagentMessages && !loading && hvMessages.length > 0;
    if (should) {
      stream.reconstructSubagents(hvMessages, { skipIfPopulated: true });
    }
  });

  if (shouldReconstructSubagents) {
    stream.reconstructSubagents(historyMessages, { skipIfPopulated: true });
  }

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

    let usableThreadId = threadId;

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

        onSuccess: () => undefined,
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

  const values = computed(() => streamValues() ?? ({} as StateType));

  return {
    values,
    error: streamError,
    isLoading,

    stop,
    submit,
    switchThread,

    queue: {
      entries: signal([]),
      size: signal(0),
      async cancel() {
        return false;
      },
      async clear() {},
    },

    interrupts: computed((): Interrupt<InterruptType>[] => {
      const vals = streamValues();
      if (
        vals != null &&
        "__interrupt__" in vals &&
        Array.isArray(vals.__interrupt__)
      ) {
        const valueInterrupts = vals.__interrupt__;
        if (valueInterrupts.length === 0) return [{ when: "breakpoint" }];
        return valueInterrupts;
      }

      return [];
    }),

    interrupt: computed((): Interrupt<InterruptType> | undefined => {
      return extractInterrupts<InterruptType>(streamValues());
    }),

    messages: computed(() => {
      const vals = streamValues();
      if (!vals) return [];
      return ensureMessageInstances(getMessages(vals));
    }),

    toolCalls: computed(() => {
      const vals = streamValues();
      if (!vals) return [];
      const msgs = getMessages(vals);
      return getToolCallsWithResults<ToolCallType>(msgs);
    }),

    getToolCalls(message: Message<ToolCallType>) {
      const vals = streamValues();
      if (!vals) return [];
      const msgs = getMessages(vals);
      const allToolCalls = getToolCallsWithResults<ToolCallType>(msgs);
      return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
    },

    get subagents() {
      void subagentVersion();
      return stream.getSubagents();
    },

    get activeSubagents() {
      void subagentVersion();
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
