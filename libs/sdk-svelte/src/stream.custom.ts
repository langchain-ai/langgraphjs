import { writable, derived, get } from "svelte/store";
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

  const values = derived(
    [streamValues],
    ([$streamValues]) => $streamValues ?? ({} as StateType),
  );

  const messages = derived([streamValues], ([$streamValues]) => {
    if (!$streamValues) return [];
    return ensureMessageInstances(getMessages($streamValues));
  });

  const toolCalls = derived([streamValues], ([$streamValues]) => {
    if (!$streamValues) return [];
    const msgs = getMessages($streamValues);
    return getToolCallsWithResults<ToolCallType>(msgs);
  });

  const interrupt = derived([streamValues], ([$streamValues]) =>
    extractInterrupts<InterruptType>($streamValues),
  );

  const interrupts = derived(
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

  return {
    values,
    error: streamError,
    isLoading,

    stop,
    submit,
    switchThread,

    branch,
    setBranch,
    getMessagesMetadata,

    queue: {
      entries: writable([]),
      size: writable(0),
      async cancel() {
        return false;
      },
      async clear() {},
    },

    interrupt,
    interrupts,

    messages,
    toolCalls,
    getToolCalls,

    subagents: derived(subagentVersion, () => stream.getSubagents()),

    activeSubagents: derived(subagentVersion, () =>
      stream.getActiveSubagents(),
    ),
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
