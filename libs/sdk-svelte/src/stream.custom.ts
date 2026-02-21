import { writable, derived, get } from "svelte/store";
import { onDestroy } from "svelte";
import {
  StreamManager,
  MessageTupleManager,
  extractInterrupts,
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
  Bag extends BagTemplate = BagTemplate
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
  });

  let threadId: string | null = options.threadId ?? null;

  const streamValues = writable<StateType | null>(stream.values);
  const streamError = writable<unknown>(stream.error);
  const isLoading = writable(stream.isLoading);

  const unsubscribe = stream.subscribe(() => {
    streamValues.set(stream.values);
    streamError.set(stream.error);
    isLoading.set(stream.isLoading);
  });

  onDestroy(() => unsubscribe());

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

  function stop() {
    return stream.stop(historyValues, { onStop: options.onStop });
  }

  async function submit(
    values: UpdateType | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, ConfigurableType>
  ) {
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
        },
      }
    );
  }

  const values = derived(
    [streamValues],
    ([$streamValues]) => $streamValues ?? ({} as StateType)
  );

  const messages = derived([streamValues], ([$streamValues]) => {
    if (!$streamValues) return [] as Message<ToolCallType>[];
    return getMessages($streamValues) as Message<ToolCallType>[];
  });

  const toolCalls = derived([streamValues], ([$streamValues]) => {
    if (!$streamValues) return [];
    const msgs = getMessages($streamValues);
    return getToolCallsWithResults<ToolCallType>(msgs);
  });

  const interrupt = derived(
    [streamValues],
    ([$streamValues]) => extractInterrupts<InterruptType>($streamValues)
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
    }
  );

  function getToolCalls(message: Message) {
    const $streamValues = get(streamValues);
    if (!$streamValues) return [];
    const msgs = getMessages($streamValues);
    const allToolCalls = getToolCallsWithResults<ToolCallType>(msgs);
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  }

  return {
    values,
    error: streamError,
    isLoading,

    stop,
    submit,

    interrupt,
    interrupts,

    messages,
    toolCalls,
    getToolCalls,

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
