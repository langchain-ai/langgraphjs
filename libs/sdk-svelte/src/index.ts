import { writable, derived, get } from "svelte/store";
import { onDestroy, onMount } from "svelte";

import {
  StreamManager,
  MessageTupleManager,
  getBranchContext,
  getMessagesMetadataMap,
  StreamError,
  extractInterrupts,
  filterStream,
  FetchStreamTransport,
  type UseStreamThread,
  type GetConfigurableType,
  type GetCustomEventType,
  type GetInterruptType,
  type GetUpdateType,
  type MessageMetadata,
  type AnyStreamOptions,
  type SubmitOptions,
  type EventStreamEvent,
  type RunCallbackMeta,
} from "@langchain/langgraph-sdk/ui";
import {
  Client,
  type BagTemplate,
  type StreamMode,
  type StreamEvent,
  type Message,
  type ThreadState,
} from "@langchain/langgraph-sdk";
import { getToolCallsWithResults } from "@langchain/langgraph-sdk/utils";
import { useStreamCustom } from "./stream.custom.js";

export { FetchStreamTransport };

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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _T = Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _Bag extends BagTemplate = BagTemplate
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
>(options: any): any {
  if ("transport" in options) {
    return useStreamCustom(options);
  }
  return useStreamLGP(options);
}

function useStreamLGP<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(options: AnyStreamOptions<StateType, Bag>) {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type CustomType = GetCustomEventType<Bag>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;

  const runMetadataStorage = (() => {
    if (typeof window === "undefined") return null;
    const storage = options.reconnectOnMount;
    if (storage === true) return window.sessionStorage;
    if (typeof storage === "function") return storage();
    return null;
  })();

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
    subagentToolNames: options.subagentToolNames,
    filterSubagentMessages: options.filterSubagentMessages,
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

  const shouldReconstructSubagents = derived(
    [isLoading, history],
    ([$isLoading, $history]) => {
      if (!options.filterSubagentMessages) return false;
      if ($isLoading || $history.isLoading) return false;
      const hvMessages = getMessages(get(historyValues));
      return hvMessages.length > 0;
    }
  );

  const unsubReconstruct = shouldReconstructSubagents.subscribe(($should) => {
    if ($should) {
      const hvMessages = getMessages(get(historyValues));
      stream.reconstructSubagents(hvMessages, { skipIfPopulated: true });
    }
  });

  onDestroy(() => {
    unsubscribe();
    unsubReconstruct();
  });

  function stop() {
    return stream.stop(get(historyValues), {
      onStop: (args) => {
        const tid = get(threadId);
        if (runMetadataStorage && tid) {
          const runId = runMetadataStorage.getItem(`lg:stream:${tid}`);
          if (runId) void client.runs.cancel(tid, runId);
          runMetadataStorage.removeItem(`lg:stream:${tid}`);
        }

        options.onStop?.(args);
      },
    });
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

    let callbackMeta: RunCallbackMeta | undefined;
    let rejoinKey: `lg:stream:${string}` | undefined;
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

        const streamResumable =
          submitOptions?.streamResumable ?? !!runMetadataStorage;

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
          onDisconnect:
            submitOptions?.onDisconnect ??
            (streamResumable ? "continue" : "cancel"),

          signal,

          checkpoint,
          streamMode,
          streamSubgraphs: submitOptions?.streamSubgraphs,
          streamResumable,
          durability: submitOptions?.durability,
          onRunCreated(params) {
            callbackMeta = {
              run_id: params.run_id,
              thread_id: params.thread_id ?? usableThreadId!,
            };

            if (runMetadataStorage) {
              rejoinKey = `lg:stream:${usableThreadId}`;
              runMetadataStorage.setItem(rejoinKey, callbackMeta.run_id);
            }

            options.onCreated?.(callbackMeta);
          },
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
          if (rejoinKey) runMetadataStorage?.removeItem(rejoinKey);

          if (shouldRefetch && usableThreadId) {
            const newHistory = await mutate(usableThreadId);
            const lastHead = newHistory?.at(0);
            if (lastHead) {
              options.onFinish?.(lastHead, callbackMeta);
              return null;
            }
          }
          return undefined;
        },
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
        onFinish: () => {},
      }
    );
  }

  async function joinStream(
    runId: string,
    lastEventId?: string,
    joinOptions?: {
      streamMode?: StreamMode | StreamMode[];
      filter?: (event: {
        id?: string;
        event: StreamEvent;
        data: unknown;
      }) => boolean;
    }
  ) {
    // eslint-disable-next-line no-param-reassign
    lastEventId ??= "-1";
    const tid = get(threadId);
    if (!tid) return;

    const callbackMeta: RunCallbackMeta = {
      thread_id: tid,
      run_id: runId,
    };

    await stream.start(
      async (signal: AbortSignal) => {
        const rawStream = client.runs.joinStream(tid, runId, {
          signal,
          lastEventId,
          streamMode: joinOptions?.streamMode,
        }) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;

        return joinOptions?.filter != null
          ? filterStream(rawStream, joinOptions.filter)
          : rawStream;
      },
      {
        getMessages,
        setMessages,

        initialValues: get(historyValues),
        callbacks: options,
        async onSuccess() {
          runMetadataStorage?.removeItem(`lg:stream:${tid}`);
          const newHistory = await mutate(tid);
          const lastHead = newHistory?.at(0);
          if (lastHead) options.onFinish?.(lastHead, callbackMeta);
        },
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
        onFinish: () => {},
      }
    );
  }

  let shouldReconnect = !!runMetadataStorage;

  onMount(() => {
    const tid = get(threadId);
    if (shouldReconnect && runMetadataStorage && tid) {
      const runId = runMetadataStorage.getItem(`lg:stream:${tid}`);
      if (runId) {
        shouldReconnect = false;
        void joinStream(runId);
      }
    }
  });

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

  const interrupts = derived(
    [streamValues, streamError, branchContext, isLoading],
    ([$streamValues, $streamError, $branchContext, $isLoading]) => {
      const vals = $streamValues ?? get(historyValues);
      if (
        vals != null &&
        "__interrupt__" in vals &&
        Array.isArray(vals.__interrupt__)
      ) {
        const valueInterrupts = vals.__interrupt__;
        if (valueInterrupts.length === 0) return [{ when: "breakpoint" }];
        return valueInterrupts;
      }

      if ($isLoading) return [];

      const allTasks = $branchContext.threadHead?.tasks ?? [];
      const allInterrupts = allTasks.flatMap((t) => t.interrupts ?? []);
      if (allInterrupts.length > 0) return allInterrupts;

      const next = $branchContext.threadHead?.next ?? [];
      if (!next.length || $streamError != null) return [];
      return [{ when: "breakpoint" }];
    }
  );

  const toolCalls = derived(
    [streamValues, historyValues],
    ([$streamValues, $historyValues]) =>
      getToolCallsWithResults(getMessages($streamValues ?? $historyValues))
  );

  function getToolCalls(message: Message) {
    const currentValues = get(streamValues) ?? get(historyValues);
    const allToolCalls = getToolCallsWithResults(getMessages(currentValues));
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  }

  const historyList = derived([branchContext], ([$branchContext]) => {
    if (historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `history`"
      );
    }
    return $branchContext.flatHistory;
  });

  const isThreadLoading = derived(
    [history],
    ([$history]) => $history.isLoading && $history.data == null
  );

  const experimentalBranchTree = derived(
    [branchContext],
    ([$branchContext]) => {
      if (historyLimit === false) {
        throw new Error(
          "`fetchStateHistory` must be set to `true` to use `experimental_branchTree`"
        );
      }
      return $branchContext.branchTree;
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
    client,

    values,
    error,
    isLoading,
    isThreadLoading,

    branch,
    setBranch,

    messages,
    toolCalls,
    getToolCalls,

    interrupt,
    interrupts,

    history: historyList,
    experimental_branchTree: experimentalBranchTree,

    getMessagesMetadata,

    submit,
    stop,
    joinStream,

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

export type {
  BaseStream,
  UseAgentStream,
  UseAgentStreamOptions,
  UseDeepAgentStream,
  UseDeepAgentStreamOptions,
  ResolveStreamInterface,
  ResolveStreamOptions,
  InferStateType,
  InferToolCalls,
  InferSubagentStates,
  InferNodeNames,
  InferBag,
  MessageMetadata,
  UseStreamOptions,
  UseStreamCustomOptions,
  UseStreamTransport,
  UseStreamThread,
  GetToolCallsType,
  AgentTypeConfigLike,
  IsAgentLike,
  ExtractAgentConfig,
  InferAgentToolCalls,
  SubagentToolCall,
  SubagentStatus,
  SubAgentLike,
  CompiledSubAgentLike,
  DeepAgentTypeConfigLike,
  IsDeepAgentLike,
  ExtractDeepAgentConfig,
  ExtractSubAgentMiddleware,
  InferDeepAgentSubagents,
  InferSubagentByName,
  InferSubagentState,
  InferSubagentNames,
  SubagentStateMap,
  DefaultSubagentStates,
  BaseSubagentState,
} from "@langchain/langgraph-sdk/ui";

export type {
  ToolCallWithResult,
  ToolCallState,
  DefaultToolCall,
  ToolCallFromTool,
  ToolCallsFromTools,
} from "@langchain/langgraph-sdk";

export {
  SubagentManager,
  extractToolCallIdFromNamespace,
  calculateDepthFromNamespace,
  extractParentIdFromNamespace,
  isSubagentNamespace,
} from "@langchain/langgraph-sdk/ui";
