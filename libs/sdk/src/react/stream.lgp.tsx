/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { findLast, unique } from "../ui/utils.js";
import { StreamError } from "../ui/errors.js";
import { getBranchContext } from "../ui/branching.js";
import { EventStreamEvent, StreamManager } from "../ui/manager.js";
import type {
  BagTemplate,
  UseStreamOptions,
  UseStream,
  GetUpdateType,
  GetCustomEventType,
  GetInterruptType,
  GetConfigurableType,
  RunCallbackMeta,
  SubmitOptions,
  MessageMetadata,
  UseStreamThread,
} from "./types.js";
import { Client, getClientConfigHash } from "../client.js";
import type { Message } from "../types.messages.js";
import type { Interrupt, ThreadState } from "../schema.js";
import type { StreamMode } from "../types.stream.js";
import { MessageTupleManager } from "../ui/messages.js";
import { useControllableThreadId } from "./thread.js";

function getFetchHistoryKey(
  client: Client,
  threadId: string | undefined | null,
  limit: boolean | number
) {
  return [getClientConfigHash(client), threadId, limit].join(":");
}

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

function useThreadHistory<StateType extends Record<string, unknown>>(
  client: Client,
  threadId: string | undefined | null,
  limit: boolean | number,
  options: {
    passthrough: boolean;
    submittingRef: RefObject<string | null>;
    onError?: (error: unknown, run?: RunCallbackMeta) => void;
  }
): UseStreamThread<StateType> {
  const key = getFetchHistoryKey(client, threadId, limit);
  const [state, setState] = useState<{
    key: string | undefined;
    data: ThreadState<StateType>[] | undefined;
    error: unknown | undefined;
    isLoading: boolean;
  }>(() => ({
    key: undefined,
    data: undefined,
    error: undefined,
    isLoading: threadId != null,
  }));

  const clientRef = useRef(client);
  clientRef.current = client;

  const onErrorRef = useRef(options?.onError);
  onErrorRef.current = options?.onError;

  const fetcher = useCallback(
    (
      threadId: string | undefined | null,
      limit: boolean | number
    ): Promise<ThreadState<StateType>[]> => {
      // If only passthrough is enabled, don't fetch history
      if (options.passthrough) return Promise.resolve([]);

      const client = clientRef.current;
      const key = getFetchHistoryKey(client, threadId, limit);

      if (threadId != null) {
        setState((state) => {
          if (state.key === key) return { ...state, isLoading: true };
          return { key, data: undefined, error: undefined, isLoading: true };
        });
        return fetchHistory<StateType>(client, threadId, { limit }).then(
          (data) => {
            setState((state) => {
              if (state.key !== key) return state;
              return { key, data, error: undefined, isLoading: false };
            });
            return data;
          },
          (error) => {
            setState((state) => {
              if (state.key !== key) return state;
              return { key, data: state.data, error, isLoading: false };
            });
            onErrorRef.current?.(error);
            return Promise.reject(error);
          }
        );
      }

      setState({ key, data: undefined, error: undefined, isLoading: false });
      return Promise.resolve([]);
    },
    [options.passthrough]
  );

  useEffect(() => {
    // Skip if a stream is already in progress, no need to fetch history
    if (
      options.submittingRef.current != null &&
      options.submittingRef.current === threadId
    ) {
      return;
    }

    void fetcher(threadId, limit);
    // The `threadId` and `limit` arguments are already present in `key`
    // Thus we don't need to include them in the dependency array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher, key]);

  return {
    data: state.data,
    error: state.error,
    isLoading: state.isLoading,
    mutate: (mutateId?: string) => fetcher(mutateId ?? threadId, limit),
  };
}

export function useStreamLGP<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(options: UseStreamOptions<StateType, Bag>): UseStream<StateType, Bag> {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type CustomType = GetCustomEventType<Bag>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;

  const reconnectOnMountRef = useRef(options.reconnectOnMount);
  const runMetadataStorage = useMemo(() => {
    if (typeof window === "undefined") return null;
    const storage = reconnectOnMountRef.current;
    if (storage === true) return window.sessionStorage;
    if (typeof storage === "function") return storage();
    return null;
  }, []);

  const client = useMemo(
    () =>
      options.client ??
      new Client({
        apiUrl: options.apiUrl,
        apiKey: options.apiKey,
        callerOptions: options.callerOptions,
        defaultHeaders: options.defaultHeaders,
      }),
    [
      options.client,
      options.apiKey,
      options.apiUrl,
      options.callerOptions,
      options.defaultHeaders,
    ]
  );

  const [messageManager] = useState(() => new MessageTupleManager());
  const [stream] = useState(
    () =>
      new StreamManager<StateType, Bag>(messageManager, {
        throttle: options.throttle ?? false,
      })
  );

  useSyncExternalStore(
    stream.subscribe,
    stream.getSnapshot,
    stream.getSnapshot
  );

  const [threadId, onThreadId] = useControllableThreadId(options);
  const trackStreamModeRef = useRef<Exclude<StreamMode, "messages">[]>([]);

  const trackStreamMode = useCallback(
    (...mode: Exclude<StreamMode, "messages">[]) => {
      const ref = trackStreamModeRef.current;
      for (const m of mode) {
        if (!ref.includes(m)) ref.push(m);
      }
    },
    []
  );

  const hasUpdateListener = options.onUpdateEvent != null;
  const hasCustomListener = options.onCustomEvent != null;
  const hasLangChainListener = options.onLangChainEvent != null;
  const hasDebugListener = options.onDebugEvent != null;
  const hasCheckpointListener = options.onCheckpointEvent != null;
  const hasTaskListener = options.onTaskEvent != null;

  const callbackStreamMode = useMemo(() => {
    const modes: Exclude<StreamMode, "messages">[] = [];
    if (hasUpdateListener) modes.push("updates");
    if (hasCustomListener) modes.push("custom");
    if (hasLangChainListener) modes.push("events");
    if (hasDebugListener) modes.push("debug");
    if (hasCheckpointListener) modes.push("checkpoints");
    if (hasTaskListener) modes.push("tasks");
    return modes;
  }, [
    hasUpdateListener,
    hasCustomListener,
    hasLangChainListener,
    hasDebugListener,
    hasCheckpointListener,
    hasTaskListener,
  ]);

  const clearCallbackRef = useRef<() => void>(null!);
  clearCallbackRef.current = stream.clear;

  const threadIdRef = useRef<string | null>(threadId);
  const threadIdStreamingRef = useRef<string | null>(null);

  // Cancel the stream if thread ID has changed
  useEffect(() => {
    if (threadIdRef.current !== threadId) {
      threadIdRef.current = threadId;
      stream.clear();
    }
  }, [threadId, stream]);

  const historyLimit =
    typeof options.fetchStateHistory === "object" &&
    options.fetchStateHistory != null
      ? options.fetchStateHistory.limit ?? false
      : options.fetchStateHistory ?? false;

  const builtInHistory = useThreadHistory<StateType>(
    client,
    threadId,
    historyLimit,
    {
      passthrough: options.thread != null,
      submittingRef: threadIdStreamingRef,
      onError: options.onError,
    }
  );
  const history = options.thread ?? builtInHistory;

  const getMessages = (value: StateType): Message[] => {
    const messagesKey = options.messagesKey ?? "messages";
    return Array.isArray(value[messagesKey]) ? value[messagesKey] : [];
  };

  const setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  const [branch, setBranch] = useState<string>("");
  const branchContext = getBranchContext(branch, history.data ?? undefined);

  const historyValues =
    branchContext.threadHead?.values ??
    options.initialValues ??
    ({} as StateType);

  const historyError = (() => {
    const error = branchContext.threadHead?.tasks?.at(-1)?.error;
    if (error == null) return undefined;
    try {
      const parsed = JSON.parse(error) as unknown;
      if (StreamError.isStructuredError(parsed)) return new StreamError(parsed);
      return parsed;
    } catch {
      // do nothing
    }
    return error;
  })();

  const messageMetadata = (() => {
    const alreadyShown = new Set<string>();
    return getMessages(historyValues).map(
      (message, idx): Omit<MessageMetadata<StateType>, "streamMetadata"> => {
        const messageId = message.id ?? idx;

        // Find the first checkpoint where the message was seen
        const firstSeenState = findLast(history.data ?? [], (state) =>
          getMessages(state.values)
            .map((m, idx) => m.id ?? idx)
            .includes(messageId)
        );

        const checkpointId = firstSeenState?.checkpoint?.checkpoint_id;
        let branch =
          checkpointId != null
            ? branchContext.branchByCheckpoint[checkpointId]
            : undefined;
        if (!branch?.branch?.length) branch = undefined;

        // serialize branches
        const optionsShown = branch?.branchOptions?.flat(2).join(",");
        if (optionsShown) {
          if (alreadyShown.has(optionsShown)) branch = undefined;
          alreadyShown.add(optionsShown);
        }

        return {
          messageId: messageId.toString(),
          firstSeenState,

          branch: branch?.branch,
          branchOptions: branch?.branchOptions,
        };
      }
    );
  })();

  const stop = () =>
    stream.stop(historyValues, {
      onStop: (args) => {
        if (runMetadataStorage && threadId) {
          const runId = runMetadataStorage.getItem(`lg:stream:${threadId}`);
          if (runId) void client.runs.cancel(threadId, runId);
          runMetadataStorage.removeItem(`lg:stream:${threadId}`);
        }

        options.onStop?.(args);
      },
    });

  // --- TRANSPORT ---
  const submit = async (
    values: UpdateType | null | undefined,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>
  ) => {
    // Unbranch things
    const checkpointId = submitOptions?.checkpoint?.checkpoint_id;
    setBranch(
      checkpointId != null
        ? branchContext.branchByCheckpoint[checkpointId]?.branch ?? ""
        : ""
    );

    // When `fetchStateHistory` is requested, thus we assume that branching
    // is enabled. We then need to include the implicit branch.
    const includeImplicitBranch =
      historyLimit === true || typeof historyLimit === "number";

    const shouldRefetch =
      // We're expecting the whole thread state in onFinish
      options.onFinish != null ||
      // We're fetching history, thus we need the latest checkpoint
      // to ensure we're not accidentally submitting to a wrong branch
      includeImplicitBranch;

    stream.setStreamValues(() => {
      const prev = shouldRefetch
        ? historyValues
        : { ...historyValues, ...stream.values };

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

    let callbackMeta: RunCallbackMeta | undefined;
    let rejoinKey: `lg:stream:${string}` | undefined;
    let usableThreadId = threadId;

    await stream.start(
      async (signal: AbortSignal) => {
        if (!usableThreadId) {
          const thread = await client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          usableThreadId = thread.thread_id;

          // Pre-emptively update the thread ID before
          // stream cancellation is kicked off and thread
          // is being refetched
          threadIdRef.current = usableThreadId;
          threadIdStreamingRef.current = usableThreadId;

          onThreadId(usableThreadId);
        }

        if (!usableThreadId) {
          throw new Error("Failed to obtain valid thread ID.");
        }

        threadIdStreamingRef.current = usableThreadId;

        const streamMode = unique([
          ...(submitOptions?.streamMode ?? []),
          ...trackStreamModeRef.current,
          ...callbackStreamMode,
        ]);

        let checkpoint =
          submitOptions?.checkpoint ??
          (includeImplicitBranch
            ? branchContext.threadHead?.checkpoint
            : undefined) ??
          undefined;

        // Avoid specifying a checkpoint if user explicitly set it to null
        if (submitOptions?.checkpoint === null) checkpoint = undefined;

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-expect-error
        if (checkpoint != null) delete checkpoint.thread_id;
        const streamResumable =
          submitOptions?.streamResumable ?? !!runMetadataStorage;

        return client.runs.stream(usableThreadId, options.assistantId, {
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

        initialValues: historyValues,
        callbacks: options,

        async onSuccess() {
          if (rejoinKey) runMetadataStorage?.removeItem(rejoinKey);

          if (shouldRefetch) {
            const newHistory = await history.mutate(usableThreadId!);
            const lastHead = newHistory?.at(0);
            if (lastHead) {
              // We now have the latest update from /history
              // Thus we can clear the local stream state
              options.onFinish?.(lastHead, callbackMeta);
              return null;
            }
          }

          return undefined;
        },
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
        onFinish() {
          threadIdStreamingRef.current = null;
        },
      }
    );
  };

  const joinStream = async (
    runId: string,
    lastEventId?: string,
    joinOptions?: { streamMode?: StreamMode | StreamMode[] }
  ) => {
    // eslint-disable-next-line no-param-reassign
    lastEventId ??= "-1";
    if (!threadId) return;

    const callbackMeta: RunCallbackMeta = {
      thread_id: threadId,
      run_id: runId,
    };

    await stream.start(
      async (signal: AbortSignal) => {
        threadIdStreamingRef.current = threadId;
        return client.runs.joinStream(threadId, runId, {
          signal,
          lastEventId,
          streamMode: joinOptions?.streamMode,
        }) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;
      },
      {
        getMessages,
        setMessages,

        initialValues: historyValues,
        callbacks: options,
        async onSuccess() {
          runMetadataStorage?.removeItem(`lg:stream:${threadId}`);
          const newHistory = await history.mutate(threadId);
          const lastHead = newHistory?.at(0);
          if (lastHead) options.onFinish?.(lastHead, callbackMeta);
        },
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
        onFinish() {
          threadIdStreamingRef.current = null;
        },
      }
    );
  };

  const reconnectKey = useMemo(() => {
    if (!runMetadataStorage || stream.isLoading) return undefined;
    if (typeof window === "undefined") return undefined;
    const runId = runMetadataStorage?.getItem(`lg:stream:${threadId}`);
    if (!runId) return undefined;
    return { runId, threadId };
  }, [runMetadataStorage, stream.isLoading, threadId]);

  const shouldReconnect = !!runMetadataStorage;
  const reconnectRef = useRef({ threadId, shouldReconnect });

  const joinStreamRef = useRef<typeof joinStream>(joinStream);
  joinStreamRef.current = joinStream;

  useEffect(() => {
    // reset shouldReconnect when switching threads
    if (reconnectRef.current.threadId !== threadId) {
      reconnectRef.current = { threadId, shouldReconnect };
    }
  }, [threadId, shouldReconnect]);

  useEffect(() => {
    if (reconnectKey && reconnectRef.current.shouldReconnect) {
      reconnectRef.current.shouldReconnect = false;
      void joinStreamRef.current?.(reconnectKey.runId);
    }
  }, [reconnectKey]);

  const error = stream.error ?? historyError ?? history.error;
  const values = stream.values ?? historyValues;

  return {
    get values() {
      trackStreamMode("values");
      return values;
    },

    client,
    assistantId: options.assistantId,

    error,
    isLoading: stream.isLoading,

    stop,
    submit,

    joinStream,

    branch,
    setBranch,

    get history() {
      if (historyLimit === false) {
        throw new Error(
          "`fetchStateHistory` must be set to `true` to use `history`"
        );
      }

      return branchContext.flatHistory;
    },

    isThreadLoading: history.isLoading && history.data == null,

    get experimental_branchTree() {
      if (historyLimit === false) {
        throw new Error(
          "`fetchStateHistory` must be set to `true` to use `experimental_branchTree`"
        );
      }

      return branchContext.branchTree;
    },

    get interrupt() {
      if (
        values != null &&
        "__interrupt__" in values &&
        Array.isArray(values.__interrupt__)
      ) {
        const valueInterrupts = values.__interrupt__;
        if (valueInterrupts.length === 0) return { when: "breakpoint" };
        if (valueInterrupts.length === 1) return valueInterrupts[0];

        // TODO: fix the typing of interrupts if multiple interrupts are returned
        return valueInterrupts;
      }

      // If we're deferring to old interrupt detection logic, don't show the interrupt if the stream is loading
      if (stream.isLoading) return undefined;

      const interrupts = branchContext.threadHead?.tasks?.at(-1)?.interrupts;
      if (interrupts == null || interrupts.length === 0) {
        // check if there's a next task present
        const next = branchContext.threadHead?.next ?? [];
        if (!next.length || error != null) return undefined;
        return { when: "breakpoint" };
      }

      // Return only the current interrupt
      return interrupts.at(-1) as Interrupt<InterruptType> | undefined;
    },

    get messages() {
      trackStreamMode("messages-tuple", "values");
      return getMessages(values);
    },

    getMessagesMetadata(
      message: Message,
      index?: number
    ): MessageMetadata<StateType> | undefined {
      trackStreamMode("values");

      const streamMetadata = messageManager.get(message.id)?.metadata;
      const historyMetadata = messageMetadata?.find(
        (m) => m.messageId === (message.id ?? index)
      );

      if (streamMetadata != null || historyMetadata != null) {
        return {
          ...historyMetadata,
          streamMetadata,
        } as MessageMetadata<StateType>;
      }

      return undefined;
    },
  };
}
