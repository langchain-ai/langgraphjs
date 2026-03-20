import { onDestroy } from "svelte";
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
  type ToolCallType = GetToolCallsType<StateType>;

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager, {
    throttle: options.throttle ?? false,
    subagentToolNames: options.subagentToolNames,
    filterSubagentMessages: options.filterSubagentMessages,
    toMessage: toMessageClass,
  });

  let currentThreadId: string | null = options.threadId ?? null;

  let branch = $state<string>("");

  let streamValues = $state<StateType | null>(stream.values);
  let streamError = $state<unknown>(stream.error);
  let isLoadingState = $state(stream.isLoading);

  let subagentVersion = $state(0);

  const unsubscribe = stream.subscribe(() => {
    streamValues = stream.values;
    streamError = stream.error;
    isLoadingState = stream.isLoading;
    subagentVersion += 1;
  });

  onDestroy(() => {
    unsubscribe();
  });

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

  if (shouldReconstructSubagents) {
    stream.reconstructSubagents(historyMessages, { skipIfPopulated: true });
  }

  function switchThread(newThreadId: string | null) {
    if (newThreadId !== currentThreadId) {
      currentThreadId = newThreadId;
      stream.clear();
    }
  }

  function stop() {
    return stream.stop(historyValues, { onStop: options.onStop });
  }

  async function submitDirect(
    submitValues: UpdateType | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>,
  ) {
    const optionThreadId = options.threadId ?? null;
    if (optionThreadId !== currentThreadId) {
      currentThreadId = optionThreadId;
      stream.clear();
    }

    let usableThreadId = currentThreadId ?? submitOptions?.threadId;

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
          currentThreadId = usableThreadId;
          options.onThreadId?.(usableThreadId);
        }

        if (!usableThreadId) {
          throw new Error("Failed to obtain valid thread ID.");
        }

        return options.transport.stream({
          input: submitValues,
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
        onError(submitError) {
          options.onError?.(submitError, undefined);
          submitOptions?.onError?.(submitError, undefined);
        },
      },
    );
  }

  async function submit(
    submitValues: UpdateType | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>,
  ) {
    await submitDirect(submitValues, submitOptions);
  }

  const valuesComputed = $derived(streamValues ?? ({} as StateType));

  const messagesComputed = $derived.by(() => {
    if (!streamValues) return [];
    return ensureMessageInstances(getMessages(streamValues));
  });

  const toolCallsComputed = $derived.by(() => {
    if (!streamValues) return [];
    const msgs = getMessages(streamValues);
    return getToolCallsWithResults<ToolCallType>(msgs);
  });

  const interruptComputed = $derived(
    extractInterrupts<InterruptType>(streamValues),
  );

  const interruptsComputed = $derived.by((): Interrupt<InterruptType>[] => {
    if (
      streamValues != null &&
      "__interrupt__" in streamValues &&
      Array.isArray(streamValues.__interrupt__)
    ) {
      const valueInterrupts = streamValues.__interrupt__;
      if (valueInterrupts.length === 0) return [{ when: "breakpoint" }];
      return valueInterrupts;
    }

    return [];
  });

  function getToolCalls(message: Message) {
    if (!streamValues) return [];
    const msgs = getMessages(streamValues);
    const allToolCalls = getToolCallsWithResults<ToolCallType>(msgs);
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  }

  function setBranch(value: string) {
    branch = value;
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _subagentTrigger = $derived(subagentVersion);
  const subagentsComputed = $derived.by(() => {
    void _subagentTrigger;
    return stream.getSubagents();
  });
  const activeSubagentsComputed = $derived.by(() => {
    void _subagentTrigger;
    return stream.getActiveSubagents();
  });

  return {
    get values() {
      return valuesComputed;
    },
    get error() {
      return streamError;
    },
    get isLoading() {
      return isLoadingState;
    },

    stop,
    submit,
    switchThread,

    get branch() {
      return branch;
    },
    setBranch,
    getMessagesMetadata,

    queue: {
      get entries() {
        return [] as never[];
      },
      get size() {
        return 0;
      },
      async cancel() {
        return false;
      },
      async clear() {},
    },

    get interrupt() {
      return interruptComputed;
    },
    get interrupts() {
      return interruptsComputed;
    },

    get messages() {
      return messagesComputed;
    },
    get toolCalls() {
      return toolCallsComputed;
    },
    getToolCalls,

    get subagents() {
      return subagentsComputed;
    },
    get activeSubagents() {
      return activeSubagentsComputed;
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
