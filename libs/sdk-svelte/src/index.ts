import { writable, derived, get } from "svelte/store";
import { onDestroy } from "svelte";

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
  type BagTemplate,
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

  const getMessages = (value: StateType): Message[] => {
    const messagesKey = options.messagesKey ?? "messages";
    return Array.isArray(value[messagesKey]) ? value[messagesKey] : [];
  };

  const setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  // TODO: add history fetching
  const history = writable<UseStreamThread<StateType>>({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: async () => undefined,
  });

  const threadId = writable<string | undefined>(undefined);

  const branch = writable<string>("");
  const branchContext = derived([branch, history], ([$branch, $history]) =>
    getBranchContext($branch, $history.data ?? undefined)
  );

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager, {
    throttle: options.throttle ?? false,
  });
  const client = new Client({ apiUrl: options.apiUrl });

  const historyValues = derived(
    [branchContext],
    ([$branchContext]) =>
      $branchContext.threadHead?.values ??
      options.initialValues ??
      ({} as StateType)
  );

  const historyError = derived([branchContext], ([$branchContext]) => {
    const error = $branchContext.threadHead?.tasks?.at(-1)?.error;
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

  const streamValues = writable<StateType | null>(stream.values);
  const streamError = writable<unknown>(stream.error);
  const isLoading = writable(stream.isLoading);

  const values = derived(
    [streamValues, historyValues],
    ([$streamValues, $historyValues]) => $streamValues ?? $historyValues
  );

  const error = derived(
    [streamError, historyError, history],
    ([$streamError, $historyError, $history]) =>
      $streamError ?? $historyError ?? $history.error
  );

  const messageMetadata = derived(
    [history, branchContext],
    ([$history, $branchContext]) =>
      getMessagesMetadataMap({
        initialValues: options.initialValues,
        history: $history.data,
        getMessages,
        branchContext: $branchContext,
      })
  );

  const unsubscribe = stream.subscribe(() => {
    streamValues.set(stream.values);
    streamError.set(stream.error);
    isLoading.set(stream.isLoading);
  });

  onDestroy(() => unsubscribe());

  function stop() {
    return stream.stop(get(historyValues), { onStop: options.onStop });
  }

  function submit(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>
  ) {
    return stream.start(
      async (signal) => {
        const currentThreadId = get(threadId);
        if (!currentThreadId) {
          // generate random thread id
          const thread = await client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          threadId.set(thread.thread_id);
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
          const prev = { ...get(historyValues), ...stream.values };

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

        return client.runs.stream(get(threadId)!, options.assistantId, {
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

  const messages = derived(
    [streamValues, historyValues],
    ([$streamValues, $historyValues]) =>
      getMessages($streamValues ?? $historyValues)
  );

  const interrupt = derived(
    [streamValues, streamError, branchContext, isLoading],
    ([$streamValues, $streamError, $branchContext, $isLoading]) => {
      return extractInterrupts<InterruptType>($streamValues, {
        isLoading: $isLoading,
        threadState: $branchContext.threadHead,
        error: $streamError,
      });
    }
  );

  function getMessagesMetadata(
    message: Message,
    index?: number
  ): MessageMetadata<StateType> | undefined {
    const streamMetadata = messageManager.get(message.id)?.metadata;
    const historyMetadata = get(messageMetadata)?.find(
      (m) => m.messageId === (message.id ?? index)
    );

    if (streamMetadata != null || historyMetadata != null) {
      return {
        ...historyMetadata,
        streamMetadata,
      } as MessageMetadata<StateType>;
    }

    return undefined;
  }

  return {
    assistantId: options.assistantId,

    values,
    error,
    isLoading,

    branch,

    messages,

    interrupt,

    getMessagesMetadata,

    submit,
    stop,
  };
}
