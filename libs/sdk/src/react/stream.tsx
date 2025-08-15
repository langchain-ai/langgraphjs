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
import { findLast, unique } from "./utils.js";
import { StreamError } from "./errors.js";
import { getBranchContext } from "./branching.js";
import { EventStreamEvent, StreamManager } from "./manager.js";
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
} from "./types.js";
import { Client, getClientConfigHash } from "../client.js";
import type { Message } from "../types.messages.js";
import type { Interrupt, ThreadState } from "../schema.js";
import type { StreamMode } from "../types.stream.js";

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

  const limit = typeof options?.limit === "number" ? options.limit : 1000;
  return client.threads.getHistory<StateType>(threadId, { limit });
}

function useThreadHistory<StateType extends Record<string, unknown>>(
  threadId: string | undefined | null,
  client: Client,
  limit: boolean | number,
  clearCallbackRef: RefObject<(() => void) | undefined>,
  submittingRef: RefObject<boolean>,
  onErrorRef: RefObject<((error: unknown) => void) | undefined>
) {
  const [history, setHistory] = useState<ThreadState<StateType>[] | undefined>(
    undefined
  );
  const [isLoading, setIsLoading] = useState(() => {
    if (threadId == null) return false;
    return true;
  });
  const [error, setError] = useState<unknown | undefined>(undefined);

  const clientHash = getClientConfigHash(client);
  const clientRef = useRef(client);
  clientRef.current = client;

  const fetcher = useCallback(
    (
      threadId: string | undefined | null
    ): Promise<ThreadState<StateType>[]> => {
      if (threadId != null) {
        const client = clientRef.current;

        setIsLoading(true);
        return fetchHistory<StateType>(client, threadId, {
          limit,
        })
          .then(
            (history) => {
              setHistory(history);
              return history;
            },
            (error) => {
              setError(error);
              onErrorRef.current?.(error);
              return Promise.reject(error);
            }
          )
          .finally(() => {
            setIsLoading(false);
          });
      }

      setHistory(undefined);
      setError(undefined);
      setIsLoading(false);

      clearCallbackRef.current?.();
      return Promise.resolve([]);
    },
    [clearCallbackRef, onErrorRef, limit]
  );

  useEffect(() => {
    if (submittingRef.current) return;
    void fetcher(threadId);
  }, [fetcher, submittingRef, clientHash, limit, threadId]);

  return {
    data: history,
    isLoading,
    error,
    mutate: (mutateId?: string) => fetcher(mutateId ?? threadId),
  };
}

const useControllableThreadId = (options?: {
  threadId?: string | null;
  onThreadId?: (threadId: string) => void;
}): [string | null, (threadId: string) => void] => {
  const [localThreadId, _setLocalThreadId] = useState<string | null>(
    options?.threadId ?? null
  );

  const onThreadIdRef = useRef(options?.onThreadId);
  onThreadIdRef.current = options?.onThreadId;

  const onThreadId = useCallback((threadId: string) => {
    _setLocalThreadId(threadId);
    onThreadIdRef.current?.(threadId);
  }, []);

  if (!options || !("threadId" in options)) {
    return [localThreadId, onThreadId];
  }

  return [options.threadId ?? null, onThreadId];
};

export function useStream<
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

  const [streamManager] = useState(() => new StreamManager<StateType, Bag>());
  useSyncExternalStore(
    streamManager.subscribe,
    streamManager.getSnapshot,
    streamManager.getSnapshot
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
  clearCallbackRef.current = streamManager.clear;

  const submittingRef = useRef(false);
  submittingRef.current = streamManager.isLoading;

  const onErrorRef = useRef<
    ((error: unknown, run?: RunCallbackMeta) => void) | undefined
  >(undefined);
  onErrorRef.current = options.onError;

  const history = useThreadHistory<StateType>(
    threadId,
    client,
    typeof options.fetchStateHistory === "object" &&
      options.fetchStateHistory != null
      ? options.fetchStateHistory.limit ?? true
      : options.fetchStateHistory ?? true,
    clearCallbackRef,
    submittingRef,
    onErrorRef
  );

  const getMessages = (value: StateType): Message[] => {
    const messagesKey = options.messagesKey ?? "messages";
    return Array.isArray(value[messagesKey]) ? value[messagesKey] : [];
  };

  const setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  const [branch, setBranch] = useState<string>("");
  const branchContext = getBranchContext(branch, history.data);

  const historyValues =
    branchContext.threadHead?.values ??
    options.initialValues ??
    ({} as StateType);

  const historyValueError = (() => {
    const error = branchContext.threadHead?.tasks?.at(-1)?.error;
    if (error == null) return undefined;
    try {
      const parsed = JSON.parse(error) as unknown;
      if (StreamError.isStructuredError(parsed)) {
        return new StreamError(parsed);
      }

      return parsed;
    } catch {
      // do nothing
    }
    return error;
  })();

  const messageMetadata = (() => {
    const alreadyShown = new Set<string>();
    return getMessages(historyValues).map(
      (message, idx): MessageMetadata<StateType> => {
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

          streamMetadata: streamManager.getMessageMetadata(message.id),
        };
      }
    );
  })();

  const stop = () =>
    streamManager.stop(historyValues, { onStop: options.onStop });

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

    streamManager.setStreamValues(() => {
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

    let callbackMeta: RunCallbackMeta | undefined;
    let rejoinKey: `lg:stream:${string}` | undefined;
    let usableThreadId = threadId;

    await streamManager.start(
      async (signal: AbortSignal) => {
        if (!usableThreadId) {
          const thread = await client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });
          onThreadId(thread.thread_id);
          usableThreadId = thread.thread_id;
        }

        if (!usableThreadId) {
          throw new Error("Failed to obtain valid thread ID.");
        }

        const streamMode = unique([
          ...(submitOptions?.streamMode ?? []),
          ...trackStreamModeRef.current,
          ...callbackStreamMode,
        ]);

        let checkpoint =
          submitOptions?.checkpoint ??
          branchContext.threadHead?.checkpoint ??
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
          const newHistory = await history.mutate(usableThreadId!);

          const lastHead = newHistory.at(0);
          if (lastHead) {
            // We now have the latest update from /history
            // Thus we can clear the local state
            options.onFinish?.(lastHead, callbackMeta);
            return null;
          }

          return undefined;
        },
        onError(error) {
          options.onError?.(error, callbackMeta);
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

    await streamManager.start(
      async (signal: AbortSignal) => {
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
          const lastHead = newHistory.at(0);
          if (lastHead) options.onFinish?.(lastHead, callbackMeta);
        },
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
      }
    );
  };

  const reconnectKey = useMemo(() => {
    if (!runMetadataStorage || streamManager.isLoading) return undefined;
    if (typeof window === "undefined") return undefined;
    const runId = runMetadataStorage?.getItem(`lg:stream:${threadId}`);
    if (!runId) return undefined;
    return { runId, threadId };
  }, [runMetadataStorage, streamManager.isLoading, threadId]);

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
  // --- END TRANSPORT ---

  const error = streamManager.error ?? historyValueError ?? history.error;
  const values = streamManager.values ?? historyValues;

  return {
    get values() {
      trackStreamMode("values");
      return values;
    },

    client,
    assistantId: options.assistantId,

    error,
    isLoading: streamManager.isLoading,

    stop,
    submit,

    joinStream,

    branch,
    setBranch,

    history: branchContext.flatHistory,
    isThreadLoading: history.isLoading && history.data == null,

    get experimental_branchTree() {
      if (options.fetchStateHistory === false) {
        throw new Error(
          "`experimental_branchTree` is not available when `fetchStateHistory` is set to `false`"
        );
      }

      return branchContext.branchTree;
    },

    get interrupt() {
      // Don't show the interrupt if the stream is loading
      if (streamManager.isLoading) return undefined;

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
      return messageMetadata?.find(
        (m) => m.messageId === (message.id ?? index)
      );
    },
  };
}
