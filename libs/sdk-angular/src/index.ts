import { signal, computed, effect } from "@angular/core";
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

  const getMessages = (value: StateType): Message[] => {
    const messagesKey = options.messagesKey ?? "messages";
    return Array.isArray(value[messagesKey]) ? value[messagesKey] : [];
  };

  const setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  // TODO: add history fetching
  const history = signal<UseStreamThread<StateType>>({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: async () => undefined,
  });

  const threadId = signal<string | undefined>(undefined);

  const branch = signal<string>("");
  const branchContext = computed(() =>
    getBranchContext(branch(), history().data ?? undefined)
  );

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager);
  const client = new Client({ apiUrl: options.apiUrl });

  const historyValues = computed(
    () =>
      branchContext().threadHead?.values ??
      options.initialValues ??
      ({} as StateType)
  );

  const historyError = computed(() => {
    const error = branchContext().threadHead?.tasks?.at(-1)?.error;
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

  const streamValues = signal<StateType | null>(stream.values);
  const streamError = signal<unknown>(stream.error);
  const isLoading = signal(stream.isLoading);

  const values = computed(() => streamValues() ?? historyValues());
  const error = computed(
    () => streamError() ?? historyError() ?? history().error
  );

  const messageMetadata = computed(() =>
    getMessagesMetadataMap({
      initialValues: options.initialValues,
      history: history().data,
      getMessages,
      branchContext: branchContext(),
    })
  );

  effect((onCleanup) => {
    const unsubscribe = stream.subscribe(() => {
      streamValues.set(stream.values);
      streamError.set(stream.error);
      isLoading.set(stream.isLoading);
    });

    onCleanup(() => unsubscribe());
  });

  function stop() {
    return stream.stop(historyValues(), { onStop: options.onStop });
  }

  function submit(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>
  ) {
    return stream.start(
      async (signal) => {
        let currentThreadId = threadId();
        if (!currentThreadId) {
          // generate random thread id
          const thread = await client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          currentThreadId = thread.thread_id;
          threadId.set(currentThreadId);
        }

        const streamMode = new Set<StreamMode>([
          ...(submitOptions?.streamMode ?? []),
          "values",
          "messages-tuple",
        ]);

        stream.setStreamValues(() => {
          const prev = { ...historyValues(), ...stream.values };

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

        return client.runs.stream(currentThreadId, options.assistantId, {
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

          streamMode: [...streamMode],
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

  const messages = computed(() => getMessages(values()));

  const interrupt = computed(() =>
    extractInterrupts<InterruptType>(values(), {
      isLoading: isLoading(),
      threadState: branchContext().threadHead,
      error: error(),
    })
  );

  function getMessagesMetadata(
    message: Message,
    index?: number
  ): MessageMetadata<StateType> | undefined {
    const streamMetadata = messageManager.get(message.id)?.metadata;
    const historyMetadata = messageMetadata().find(
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
