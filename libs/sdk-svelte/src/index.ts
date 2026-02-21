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
  type ThreadState,
} from "@langchain/langgraph-sdk";

function fetchHistory<StateType extends Record<string, unknown>>(
  client: Client,
  threadId: string,
  options?: { limit?: boolean | number }
) {
  if (options?.limit === false) {
    return client.threads.getState<StateType>(threadId).then((state) => {
      if (state.checkpoint == null) return [];
      return [state];
    });
  }

  const limit = typeof options?.limit === "number" ? options.limit : 10;
  return client.threads.getHistory<StateType>(threadId, { limit });
}

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

  const historyLimit =
    typeof options.fetchStateHistory === "object" &&
    options.fetchStateHistory != null
      ? options.fetchStateHistory.limit ?? false
      : options.fetchStateHistory ?? false;

  const threadId = writable<string | undefined>(undefined);

  const client = options.client ?? new Client({ apiUrl: options.apiUrl });

  const history = writable<UseStreamThread<StateType>>({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: async () => undefined,
  });

  async function mutate(
    mutateId?: string
  ): Promise<ThreadState<StateType>[] | undefined> {
    const tid = mutateId ?? get(threadId);
    if (!tid) return undefined;
    try {
      const data = await fetchHistory<StateType>(client, tid, {
        limit: historyLimit,
      });
      history.set({
        data,
        error: undefined,
        isLoading: false,
        mutate,
      });
      return data;
    } catch (err) {
      history.update((prev) => ({
        ...prev,
        error: err,
        isLoading: false,
      }));
      options.onError?.(err, undefined);
      return undefined;
    }
  }

  history.update((prev) => ({ ...prev, mutate }));

  const branch = writable<string>("");
  const branchContext = derived([branch, history], ([$branch, $history]) =>
    getBranchContext($branch, $history.data ?? undefined)
  );

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager, {
    throttle: options.throttle ?? false,
  });

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

  function setBranch(value: string) {
    branch.set(value);
  }

  function submit(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>
  ) {
    const currentBranchContext = get(branchContext);

    const checkpointId = submitOptions?.checkpoint?.checkpoint_id;
    branch.set(
      checkpointId != null
        ? currentBranchContext.branchByCheckpoint[checkpointId]?.branch ?? ""
        : ""
    );

    const includeImplicitBranch =
      historyLimit === true || typeof historyLimit === "number";

    const shouldRefetch =
      options.onFinish != null || includeImplicitBranch;

    let checkpoint =
      submitOptions?.checkpoint ??
      (includeImplicitBranch
        ? currentBranchContext.threadHead?.checkpoint
        : undefined) ??
      undefined;

    if (submitOptions?.checkpoint === null) checkpoint = undefined;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    if (checkpoint != null) delete checkpoint.thread_id;

    let usableThreadId: string | undefined;

    return stream.start(
      async (signal) => {
        usableThreadId = get(threadId);
        if (!usableThreadId) {
          const thread = await client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          usableThreadId = thread.thread_id;
          threadId.set(usableThreadId);
          options.onThreadId?.(usableThreadId);
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

        return client.runs.stream(usableThreadId!, options.assistantId, {
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

          checkpoint,
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

        initialValues: get(historyValues),
        callbacks: options,

        async onSuccess() {
          if (shouldRefetch && usableThreadId) {
            const newHistory = await mutate(usableThreadId);
            const lastHead = newHistory?.at(0);
            if (lastHead) {
              options.onFinish?.(lastHead, undefined);
              return null;
            }
          }
          return undefined;
        },
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
    setBranch,

    messages,

    interrupt,

    getMessagesMetadata,

    submit,
    stop,
  };
}
