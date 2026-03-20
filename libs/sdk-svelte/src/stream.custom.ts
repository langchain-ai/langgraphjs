import { writable, derived, get, fromStore } from "svelte/store";
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

  let threadId: string | null = options.threadId ?? null;

  const branch = writable<string>("");

  const streamValues = writable<StateType | null>(stream.values);
  const streamError = writable<unknown>(stream.error);
  const isLoading = writable(stream.isLoading);

  const subagentVersion = writable(0);

  const unsubscribe = stream.subscribe(() => {
    streamValues.set(stream.values);
    streamError.set(stream.error);
    isLoading.set(stream.isLoading);
    subagentVersion.update((v) => v + 1);
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

  const valuesStore = derived(
    [streamValues],
    ([$streamValues]) => $streamValues ?? ({} as StateType),
  );

  const messagesStore = derived([streamValues], ([$streamValues]) => {
    if (!$streamValues) return [];
    return ensureMessageInstances(getMessages($streamValues));
  });

  const toolCallsStore = derived([streamValues], ([$streamValues]) => {
    if (!$streamValues) return [];
    const msgs = getMessages($streamValues);
    return getToolCallsWithResults<ToolCallType>(msgs);
  });

  const interruptStore = derived([streamValues], ([$streamValues]) =>
    extractInterrupts<InterruptType>($streamValues),
  );

  const interruptsStore = derived(
    [streamValues],
    ([$streamValues]): Interrupt<InterruptType>[] => {
      if (
        $streamValues != null &&
        "__interrupt__" in $streamValues &&
        Array.isArray($streamValues.__interrupt__)
      ) {
        const valueInterrupts = $streamValues.__interrupt__;
        if (valueInterrupts.length === 0) return [{ when: "breakpoint" }];
        return valueInterrupts;
      }

      return [];
    },
  );

  function getToolCalls(message: Message) {
    const $streamValues = get(streamValues);
    if (!$streamValues) return [];
    const msgs = getMessages($streamValues);
    const allToolCalls = getToolCallsWithResults<ToolCallType>(msgs);
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  }

  function setBranch(value: string) {
    branch.set(value);
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

  const emptyEntries = writable<never[]>([]);
  const emptySize = writable(0);

  const subagentsStore = derived(subagentVersion, () =>
    stream.getSubagents(),
  );
  const activeSubagentsStore = derived(subagentVersion, () =>
    stream.getActiveSubagents(),
  );

  const valuesRef = fromStore(valuesStore);
  const errorRef = fromStore(streamError);
  const isLoadingRef = fromStore(isLoading);
  const branchRef = fromStore(branch);
  const messagesRef = fromStore(messagesStore);
  const toolCallsRef = fromStore(toolCallsStore);
  const interruptRef = fromStore(interruptStore);
  const interruptsRef = fromStore(interruptsStore);
  const subagentsRef = fromStore(subagentsStore);
  const activeSubagentsRef = fromStore(activeSubagentsStore);
  const emptyEntriesRef = fromStore(emptyEntries);
  const emptySizeRef = fromStore(emptySize);

  return {
    get values() {
      return valuesRef.current;
    },
    get error() {
      return errorRef.current;
    },
    get isLoading() {
      return isLoadingRef.current;
    },

    stop,
    submit,
    switchThread,

    get branch() {
      return branchRef.current;
    },
    setBranch,
    getMessagesMetadata,

    queue: {
      get entries() {
        return emptyEntriesRef.current;
      },
      get size() {
        return emptySizeRef.current;
      },
      async cancel() {
        return false;
      },
      async clear() {},
    },

    get interrupt() {
      return interruptRef.current;
    },
    get interrupts() {
      return interruptsRef.current;
    },

    get messages() {
      return messagesRef.current;
    },
    get toolCalls() {
      return toolCallsRef.current;
    },
    getToolCalls,

    get subagents() {
      return subagentsRef.current;
    },
    get activeSubagents() {
      return activeSubagentsRef.current;
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
