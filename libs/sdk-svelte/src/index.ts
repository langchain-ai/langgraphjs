import { writable, derived, get, fromStore } from "svelte/store";
import { onDestroy, onMount, setContext, getContext } from "svelte";

import type {
  BaseMessage,
  ToolMessage as CoreToolMessage,
  AIMessage as CoreAIMessage,
} from "@langchain/core/messages";
import {
  StreamManager,
  MessageTupleManager,
  PendingRunsTracker,
  getBranchContext,
  getMessagesMetadataMap,
  StreamError,
  extractInterrupts,
  filterStream,
  FetchStreamTransport,
  toMessageClass,
  ensureMessageInstances,
  ensureHistoryMessageInstances,
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
  type ResolveStreamInterface,
  type ResolveStreamOptions,
  type InferBag,
  type InferStateType,
  type AcceptBaseMessages,
  type UseStreamCustomOptions,
  type SubagentStreamInterface,
  type HistoryWithBaseMessages,
} from "@langchain/langgraph-sdk/ui";
import {
  Client,
  type BagTemplate,
  type StreamMode,
  type StreamEvent,
  type Message,
  type ThreadState,
  type ToolCallWithResult as _ToolCallWithResult,
  type DefaultToolCall,
} from "@langchain/langgraph-sdk";
import { getToolCallsWithResults } from "@langchain/langgraph-sdk/utils";
import { useStreamCustom } from "./stream.custom.js";

export { FetchStreamTransport };
export { provideStream, getStream } from "./context.js";

const STREAM_CONTEXT_KEY = Symbol.for("langchain:stream-context");

/**
 * Provides a `useStream` return value to all descendant components via
 * Svelte's context API. Must be called during component initialisation
 * (i.e. at the top level of a `<script>` block).
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useStream, setStreamContext } from "@langchain/svelte";
 *
 *   const stream = useStream({ assistantId: "agent", apiUrl: "..." });
 *   setStreamContext(stream);
 * </script>
 *
 * <ChildComponent />
 * ```
 */
export function setStreamContext<T extends ReturnType<typeof useStream>>(
  stream: T,
): T {
  setContext(STREAM_CONTEXT_KEY, stream);
  return stream;
}

/**
 * Retrieves the `useStream` instance previously provided by a parent
 * component via {@link setStreamContext}. Must be called during component
 * initialisation.
 *
 * @throws If no stream context has been set by an ancestor component.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { getStreamContext } from "@langchain/svelte";
 *
 *   const stream = getStreamContext();
 * </script>
 * ```
 */
export function getStreamContext<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(): WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>> {
  const ctx = getContext(STREAM_CONTEXT_KEY);
  if (!ctx) {
    throw new Error(
      "getStreamContext must be used within a component that has called setStreamContext",
    );
  }
  return ctx as WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;
}

function fetchHistory<StateType extends Record<string, unknown>>(
  client: Client,
  threadId: string,
  options?: { limit?: boolean | number },
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

type ClassToolCallWithResult<T> =
  T extends _ToolCallWithResult<infer TC, unknown, unknown>
    ? _ToolCallWithResult<TC, CoreToolMessage, CoreAIMessage>
    : T;

export type ClassSubagentStreamInterface<
  StateType = Record<string, unknown>,
  ToolCall = DefaultToolCall,
  SubagentName extends string = string,
> = Omit<
  SubagentStreamInterface<StateType, ToolCall, SubagentName>,
  "messages"
> & {
  messages: BaseMessage[];
};

/**
 * Maps a stream interface to Svelte 5-reactive types:
 * - `messages` becomes `BaseMessage[]`
 * - `getMessagesMetadata` accepts `BaseMessage`
 * - `toolCalls` uses `@langchain/core` message classes
 * - `getToolCalls` accepts `CoreAIMessage`, returns class-based tool call results
 * - `queue` properties are plain values and functions
 * - `client`, `assistantId`, `subagents`, `activeSubagents` remain unwrapped
 * - Functions remain unchanged
 * - All other reactive properties are exposed as plain values via getters
 */
type WithClassMessages<T> = {
  [K in keyof T as K extends
    | "getSubagent"
    | "getSubagentsByType"
    | "getSubagentsByMessage"
    ? never
    : K]: K extends "messages"
    ? BaseMessage[]
    : K extends "getMessagesMetadata"
      ? (
          message: BaseMessage,
          index?: number,
        ) => MessageMetadata<Record<string, unknown>> | undefined
      : K extends "toolCalls"
        ? T[K] extends (infer TC)[]
          ? ClassToolCallWithResult<TC>[]
          : T[K]
        : K extends "getToolCalls"
          ? T[K] extends (message: infer _M) => (infer TC)[]
            ? (message: CoreAIMessage) => ClassToolCallWithResult<TC>[]
            : T[K]
          : K extends "queue"
            ? {
                [QK in keyof T[K]]: T[K][QK] extends (
                  ...args: infer A
                ) => infer R
                  ? (...args: A) => R
                  : T[K][QK];
              }
            : K extends "client" | "assistantId"
              ? T[K]
              : K extends "subagents"
                ? T[K] extends Map<
                    string,
                    SubagentStreamInterface<infer S, infer TC, infer N>
                  >
                  ? Map<string, ClassSubagentStreamInterface<S, TC, N>>
                  : T[K]
                : K extends "activeSubagents"
                  ? T[K] extends SubagentStreamInterface<
                      infer S,
                      infer TC,
                      infer N
                    >[]
                    ? ClassSubagentStreamInterface<S, TC, N>[]
                    : T[K]
                  : K extends "submit"
                    ? T[K] extends (
                        values: infer V,
                        options?: infer O,
                      ) => infer Ret
                      ? (
                          values:
                            | AcceptBaseMessages<Exclude<V, null | undefined>>
                            | null
                            | undefined,
                          options?: O,
                        ) => Ret
                      : T[K]
                    : K extends "history"
                      ? HistoryWithBaseMessages<T[K]>
                      : T[K] extends (...args: infer A) => infer R
                        ? (...args: A) => R
                        : T[K];
} & ("subagents" extends keyof T
  ? {
      getSubagent: T extends {
        getSubagent: (
          id: string,
        ) => SubagentStreamInterface<infer S, infer TC, infer N> | undefined;
      }
        ? (
            toolCallId: string,
          ) => ClassSubagentStreamInterface<S, TC, N> | undefined
        : never;
      getSubagentsByType: T extends {
        getSubagentsByType: (
          type: string,
        ) => SubagentStreamInterface<infer S, infer TC, infer N>[];
      }
        ? (type: string) => ClassSubagentStreamInterface<S, TC, N>[]
        : never;
      getSubagentsByMessage: T extends {
        getSubagentsByMessage: (
          id: string,
        ) => SubagentStreamInterface<infer S, infer TC, infer N>[];
      }
        ? (messageId: string) => ClassSubagentStreamInterface<S, TC, N>[]
        : never;
    }
  : unknown);

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: ResolveStreamOptions<T, InferBag<T, Bag>>,
): WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>,
): WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStream(options: any): any {
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
  } = BagTemplate,
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
      ? (options.fetchStateHistory.limit ?? false)
      : (options.fetchStateHistory ?? false);

  const threadId = writable<string | undefined>(undefined);
  let threadIdPromise: Promise<string> | null = null;

  const client = options.client ?? new Client({ apiUrl: options.apiUrl });

  const history = writable<UseStreamThread<StateType>>({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: async () => undefined,
  });

  async function mutate(
    mutateId?: string,
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
    getBranchContext($branch, $history.data ?? undefined),
  );

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager, {
    throttle: options.throttle ?? false,
    subagentToolNames: options.subagentToolNames,
    filterSubagentMessages: options.filterSubagentMessages,
    toMessage: toMessageClass,
  });

  const pendingRuns = new PendingRunsTracker<
    StateType,
    SubmitOptions<StateType, ConfigurableType>
  >();

  const historyValues = derived(
    [branchContext],
    ([$branchContext]) =>
      $branchContext.threadHead?.values ??
      options.initialValues ??
      ({} as StateType),
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

  const queueEntries = writable(pendingRuns.entries);
  const queueSize = writable(pendingRuns.size);

  const values = derived(
    [streamValues, historyValues],
    ([$streamValues, $historyValues]) => $streamValues ?? $historyValues,
  );

  const error = derived(
    [streamError, historyError, history],
    ([$streamError, $historyError, $history]) =>
      $streamError ?? $historyError ?? $history.error,
  );

  const messageMetadata = derived(
    [history, branchContext],
    ([$history, $branchContext]) =>
      getMessagesMetadataMap({
        initialValues: options.initialValues,
        history: $history.data,
        getMessages,
        branchContext: $branchContext,
      }),
  );

  const subagentVersion = writable(0);

  const unsubscribe = stream.subscribe(() => {
    streamValues.set(stream.values);
    streamError.set(stream.error);
    isLoading.set(stream.isLoading);
    subagentVersion.update((v) => v + 1);
  });

  const unsubQueue = pendingRuns.subscribe(() => {
    queueEntries.set(pendingRuns.entries);
    queueSize.set(pendingRuns.size);
  });

  const shouldReconstructSubagents = derived(
    [isLoading, history],
    ([$isLoading, $history]) => {
      if (!options.filterSubagentMessages) return false;
      if ($isLoading || $history.isLoading) return false;
      const hvMessages = getMessages(get(historyValues));
      return hvMessages.length > 0;
    },
  );

  let fetchController: AbortController | null = null;

  const unsubReconstruct = shouldReconstructSubagents.subscribe(($should) => {
    if ($should) {
      const hvMessages = getMessages(get(historyValues));
      stream.reconstructSubagents(hvMessages, { skipIfPopulated: true });
      fetchController?.abort();
      fetchController = new AbortController();
      const tid = get(threadId);
      if (tid) {
        void stream.fetchSubagentHistory(client.threads, tid, {
          messagesKey: options.messagesKey ?? "messages",
          signal: fetchController.signal,
        });
      }
    }
  });

  onDestroy(() => {
    fetchController?.abort();
    unsubscribe();
    unsubReconstruct();
    unsubQueue();
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

  function submitDirect(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>,
  ) {
    const currentBranchContext = get(branchContext);

    const checkpointId = submitOptions?.checkpoint?.checkpoint_id;
    branch.set(
      checkpointId != null
        ? (currentBranchContext.branchByCheckpoint[checkpointId]?.branch ?? "")
        : "",
    );

    const includeImplicitBranch =
      historyLimit === true || typeof historyLimit === "number";

    const shouldRefetch = options.onFinish != null || includeImplicitBranch;

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
          const threadPromise = client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          threadIdPromise = threadPromise.then((t) => t.thread_id);

          const thread = await threadPromise;

          usableThreadId = thread.thread_id;
          threadId.set(usableThreadId);
          options.onThreadId?.(usableThreadId);
        }

        const streamMode: StreamMode[] = [
          "values",
          "messages-tuple",
          "updates",
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
          submitOptions?.onError?.(error, callbackMeta);
        },
        onFinish: () => {},
      },
    );
  }

  let submitting = false;

  function drainQueue() {
    if (!get(isLoading) && !submitting && pendingRuns.size > 0) {
      const next = pendingRuns.shift();
      if (next) {
        submitting = true;
        void joinStream(next.id).finally(() => {
          submitting = false;
          drainQueue();
        });
      }
    }
  }

  isLoading.subscribe(() => {
    drainQueue();
  });

  async function submit(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>,
  ) {
    if (stream.isLoading || submitting) {
      const shouldAbort =
        submitOptions?.multitaskStrategy === "interrupt" ||
        submitOptions?.multitaskStrategy === "rollback";

      if (shouldAbort) {
        submitting = true;
        try {
          await submitDirect(values, submitOptions);
        } finally {
          submitting = false;
        }
        return;
      }

      let usableThreadId: string | undefined = get(threadId);
      if (!usableThreadId && threadIdPromise) {
        usableThreadId = await threadIdPromise;
      }
      if (usableThreadId) {
        try {
          const run = await client.runs.create(
            usableThreadId,
            options.assistantId,
            {
              input: values as Record<string, unknown>,
              config: submitOptions?.config,
              context: submitOptions?.context,
              command: submitOptions?.command,
              interruptBefore: submitOptions?.interruptBefore,
              interruptAfter: submitOptions?.interruptAfter,
              metadata: submitOptions?.metadata,
              multitaskStrategy: "enqueue",
              streamResumable: true,
              streamSubgraphs: submitOptions?.streamSubgraphs,
              durability: submitOptions?.durability,
            },
          );

          pendingRuns.add({
            id: run.run_id,
            values: values as Partial<StateType> | null | undefined,
            options: submitOptions,
            createdAt: new Date(run.created_at),
          });
        } catch (error) {
          options.onError?.(error, undefined);
          submitOptions?.onError?.(error, undefined);
        }
        return;
      }
    }

    submitting = true;
    const result = submitDirect(values, submitOptions);
    void Promise.resolve(result).finally(() => {
      submitting = false;
      drainQueue();
    });
    return result;
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
    },
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
      },
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
      ensureMessageInstances(getMessages($streamValues ?? $historyValues)),
  );

  const interrupt = derived(
    [streamValues, streamError, branchContext, isLoading],
    ([$streamValues, $streamError, $branchContext, $isLoading]) => {
      return extractInterrupts<InterruptType>($streamValues, {
        isLoading: $isLoading,
        threadState: $branchContext.threadHead,
        error: $streamError,
      });
    },
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
    },
  );

  const toolCalls = derived(
    [streamValues, historyValues],
    ([$streamValues, $historyValues]) =>
      getToolCallsWithResults(getMessages($streamValues ?? $historyValues)),
  );

  function getToolCalls(message: Message) {
    const currentValues = get(streamValues) ?? get(historyValues);
    const allToolCalls = getToolCallsWithResults(getMessages(currentValues));
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  }

  const historyList = derived([branchContext], ([$branchContext]) => {
    if (historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `history`",
      );
    }
    return ensureHistoryMessageInstances(
      $branchContext.flatHistory,
      options.messagesKey ?? "messages",
    );
  });

  const isThreadLoading = derived(
    [history],
    ([$history]) => $history.isLoading && $history.data == null,
  );

  const experimentalBranchTree = derived(
    [branchContext],
    ([$branchContext]) => {
      if (historyLimit === false) {
        throw new Error(
          "`fetchStateHistory` must be set to `true` to use `experimental_branchTree`",
        );
      }
      return $branchContext.branchTree;
    },
  );

  function getMessagesMetadata(
    message: Message,
    index?: number,
  ): MessageMetadata<StateType> | undefined {
    const streamMetadata = messageManager.get(message.id)?.metadata;
    const historyMetadata = get(messageMetadata)?.find(
      (m) => m.messageId === (message.id ?? index),
    );

    if (streamMetadata != null || historyMetadata != null) {
      return {
        ...historyMetadata,
        streamMetadata,
      } as MessageMetadata<StateType>;
    }

    return undefined;
  }

  const subagentsStore = derived(subagentVersion, () =>
    stream.getSubagents(),
  );
  const activeSubagentsStore = derived(subagentVersion, () =>
    stream.getActiveSubagents(),
  );

  const valuesRef = fromStore(values);
  const errorRef = fromStore(error);
  const isLoadingRef = fromStore(isLoading);
  const isThreadLoadingRef = fromStore(isThreadLoading);
  const branchRef = fromStore(branch);
  const messagesRef = fromStore(messages);
  const toolCallsRef = fromStore(toolCalls);
  const interruptRef = fromStore(interrupt);
  const interruptsRef = fromStore(interrupts);
  const historyListRef = fromStore(historyList);
  const experimentalBranchTreeRef = fromStore(experimentalBranchTree);
  const subagentsRef = fromStore(subagentsStore);
  const activeSubagentsRef = fromStore(activeSubagentsStore);
  const queueEntriesRef = fromStore(queueEntries);
  const queueSizeRef = fromStore(queueSize);

  return {
    assistantId: options.assistantId,
    client,

    get values() {
      return valuesRef.current;
    },
    get error() {
      return errorRef.current;
    },
    get isLoading() {
      return isLoadingRef.current;
    },
    get isThreadLoading() {
      return isThreadLoadingRef.current;
    },

    get branch() {
      return branchRef.current;
    },
    setBranch,

    get messages() {
      return messagesRef.current;
    },
    get toolCalls() {
      return toolCallsRef.current;
    },
    getToolCalls,

    get interrupt() {
      return interruptRef.current;
    },
    get interrupts() {
      return interruptsRef.current;
    },

    get history() {
      return historyListRef.current;
    },
    get experimental_branchTree() {
      return experimentalBranchTreeRef.current;
    },

    getMessagesMetadata,

    submit,
    stop,
    joinStream,

    queue: {
      get entries() {
        return queueEntriesRef.current;
      },
      get size() {
        return queueSizeRef.current;
      },
      async cancel(id: string) {
        const tid = get(threadId);
        const removed = pendingRuns.remove(id);
        if (removed && tid) {
          await client.runs.cancel(tid, id);
        }
        return removed;
      },
      async clear() {
        const tid = get(threadId);
        const removed = pendingRuns.removeAll();
        if (tid && removed.length > 0) {
          await Promise.all(removed.map((e) => client.runs.cancel(tid!, e.id)));
        }
      },
    },

    switchThread(newThreadId: string | null) {
      const current = get(threadId) ?? null;
      if (newThreadId !== current) {
        const prevThreadId = get(threadId);
        threadId.set(newThreadId ?? undefined);
        stream.clear();

        const removed = pendingRuns.removeAll();
        if (prevThreadId && removed.length > 0) {
          void Promise.all(
            removed.map((e) => client.runs.cancel(prevThreadId, e.id)),
          );
        }

        if (newThreadId != null) {
          options.onThreadId?.(newThreadId);
        }
      }
    },

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
  SubagentApi,
  SubagentStream,
  SubagentStreamInterface,
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
  QueueEntry,
  QueueInterface,
} from "@langchain/langgraph-sdk/ui";

export type ToolCallWithResult<ToolCall = DefaultToolCall> =
  _ToolCallWithResult<ToolCall, CoreToolMessage, CoreAIMessage>;
export type {
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
