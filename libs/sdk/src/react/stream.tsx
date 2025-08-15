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
import { Client, getClientConfigHash, type ClientConfig } from "../client.js";
import type {
  Command,
  DisconnectMode,
  Durability,
  MultitaskStrategy,
  OnCompletionBehavior,
} from "../types.js";
import type { Message } from "../types.messages.js";
import type {
  Checkpoint,
  Config,
  Interrupt,
  Metadata,
  ThreadState,
} from "../schema.js";
import type {
  CheckpointsStreamEvent,
  CustomStreamEvent,
  DebugStreamEvent,
  EventsStreamEvent,
  MetadataStreamEvent,
  StreamMode,
  TasksStreamEvent,
  UpdatesStreamEvent,
} from "../types.stream.js";
import { findLast, unique } from "./utils.js";
import { StreamError } from "./errors.js";
import { type Sequence, getBranchContext } from "./branching.js";
import { type EventStreamEvent, StreamManager } from "./manager.js";

export type MessageMetadata<StateType extends Record<string, unknown>> = {
  /**
   * The ID of the message used.
   */
  messageId: string;

  /**
   * The first thread state the message was seen in.
   */
  firstSeenState: ThreadState<StateType> | undefined;

  /**
   * The branch of the message.
   */
  branch: string | undefined;

  /**
   * The list of branches this message is part of.
   * This is useful for displaying branching controls.
   */
  branchOptions: string[] | undefined;

  /**
   * Metadata sent alongside the message during run streaming.
   * @remarks This metadata only exists temporarily in browser memory during streaming and is not persisted after completion.
   */
  streamMetadata: Record<string, unknown> | undefined;
};

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

type BagTemplate = {
  ConfigurableType?: Record<string, unknown>;
  InterruptType?: unknown;
  CustomEventType?: unknown;
  UpdateType?: unknown;
};

type GetUpdateType<
  Bag extends BagTemplate,
  StateType extends Record<string, unknown>
> = Bag extends { UpdateType: unknown }
  ? Bag["UpdateType"]
  : Partial<StateType>;

type GetConfigurableType<Bag extends BagTemplate> = Bag extends {
  ConfigurableType: Record<string, unknown>;
}
  ? Bag["ConfigurableType"]
  : Record<string, unknown>;

type GetInterruptType<Bag extends BagTemplate> = Bag extends {
  InterruptType: unknown;
}
  ? Bag["InterruptType"]
  : unknown;

type GetCustomEventType<Bag extends BagTemplate> = Bag extends {
  CustomEventType: unknown;
}
  ? Bag["CustomEventType"]
  : unknown;

interface RunCallbackMeta {
  run_id: string;
  thread_id: string;
}

export interface UseStreamOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  /**
   * The ID of the assistant to use.
   */
  assistantId: string;

  /**
   * Client used to send requests.
   */
  client?: Client;

  /**
   * The URL of the API to use.
   */
  apiUrl?: ClientConfig["apiUrl"];

  /**
   * The API key to use.
   */
  apiKey?: ClientConfig["apiKey"];

  /**
   * Custom call options, such as custom fetch implementation.
   */
  callerOptions?: ClientConfig["callerOptions"];

  /**
   * Default headers to send with requests.
   */
  defaultHeaders?: ClientConfig["defaultHeaders"];

  /**
   * Specify the key within the state that contains messages.
   * Defaults to "messages".
   *
   * @default "messages"
   */
  messagesKey?: string;

  /**
   * Callback that is called when an error occurs.
   */
  onError?: (error: unknown, run: RunCallbackMeta | undefined) => void;

  /**
   * Callback that is called when the stream is finished.
   */
  onFinish?: (
    state: ThreadState<StateType>,
    run: RunCallbackMeta | undefined
  ) => void;

  /**
   * Callback that is called when a new stream is created.
   */
  onCreated?: (run: RunCallbackMeta) => void;

  /**
   * Callback that is called when an update event is received.
   */
  onUpdateEvent?: (
    data: UpdatesStreamEvent<GetUpdateType<Bag, StateType>>["data"],
    options: {
      namespace: string[] | undefined;
      mutate: (
        update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
      ) => void;
    }
  ) => void;

  /**
   * Callback that is called when a custom event is received.
   */
  onCustomEvent?: (
    data: CustomStreamEvent<GetCustomEventType<Bag>>["data"],
    options: {
      namespace: string[] | undefined;
      mutate: (
        update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
      ) => void;
    }
  ) => void;

  /**
   * Callback that is called when a metadata event is received.
   */
  onMetadataEvent?: (data: MetadataStreamEvent["data"]) => void;

  /**
   * Callback that is called when a LangChain event is received.
   * @see https://langchain-ai.github.io/langgraph/cloud/how-tos/stream_events/#stream-graph-in-events-mode for more details.
   */
  onLangChainEvent?: (data: EventsStreamEvent["data"]) => void;

  /**
   * Callback that is called when a debug event is received.
   * @internal This API is experimental and subject to change.
   */
  onDebugEvent?: (
    data: DebugStreamEvent["data"],
    options: { namespace: string[] | undefined }
  ) => void;

  /**
   * Callback that is called when a checkpoints event is received.
   */
  onCheckpointEvent?: (
    data: CheckpointsStreamEvent<StateType>["data"],
    options: { namespace: string[] | undefined }
  ) => void;

  /**
   * Callback that is called when a tasks event is received.
   */
  onTaskEvent?: (
    data: TasksStreamEvent<StateType, GetUpdateType<Bag, StateType>>["data"],
    options: { namespace: string[] | undefined }
  ) => void;

  /**
   * Callback that is called when the stream is stopped by the user.
   * Provides a mutate function to update the stream state immediately
   * without requiring a server roundtrip.
   *
   * @example
   * ```typescript
   * onStop: ({ mutate }) => {
   *   mutate((prev) => ({
   *     ...prev,
   *     ui: prev.ui?.map(component =>
   *       component.props.isLoading
   *         ? { ...component, props: { ...component.props, stopped: true, isLoading: false }}
   *         : component
   *     )
   *   }));
   * }
   * ```
   */
  onStop?: (options: {
    mutate: (
      update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
    ) => void;
  }) => void;

  /**
   * The ID of the thread to fetch history and current values from.
   */
  threadId?: string | null;

  /**
   * Callback that is called when the thread ID is updated (ie when a new thread is created).
   */
  onThreadId?: (threadId: string) => void;

  /** Will reconnect the stream on mount */
  reconnectOnMount?: boolean | (() => RunMetadataStorage);

  /**
   * Initial values to display immediately when loading a thread.
   * Useful for displaying cached thread data while official history loads.
   * These values will be replaced when official thread data is fetched.
   *
   * Note: UI components from initialValues will render immediately if they're
   * predefined in LoadExternalComponent's components prop, providing instant
   * cached UI display without server fetches.
   */
  initialValues?: StateType | null;

  /**
   * Whether to fetch the history of the thread.
   * If true, the history will be fetched from the server. Defaults to 1000 entries.
   * If false, only the last state will be fetched from the server.
   * @default true
   */
  fetchStateHistory?: boolean | { limit: number };
}

interface RunMetadataStorage {
  getItem(key: `lg:stream:${string}`): string | null;
  setItem(key: `lg:stream:${string}`, value: string): void;
  removeItem(key: `lg:stream:${string}`): void;
}

export interface UseStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  /**
   * The current values of the thread.
   */
  values: StateType;

  /**
   * Last seen error from the thread or during streaming.
   */
  error: unknown;

  /**
   * Whether the stream is currently running.
   */
  isLoading: boolean;

  /**
   * Whether the thread is currently being loaded.
   */
  isThreadLoading: boolean;

  /**
   * Stops the stream.
   */
  stop: () => Promise<void>;

  /**
   * Create and stream a run to the thread.
   */
  submit: (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    options?: SubmitOptions<StateType, GetConfigurableType<Bag>>
  ) => Promise<void>;

  /**
   * The current branch of the thread.
   */
  branch: string;

  /**
   * Set the branch of the thread.
   */
  setBranch: (branch: string) => void;

  /**
   * Flattened history of thread states of a thread.
   */
  history: ThreadState<StateType>[];

  /**
   * Tree of all branches for the thread.
   * @experimental
   */
  experimental_branchTree: Sequence<StateType>;

  /**
   * Get the interrupt value for the stream if interrupted.
   */
  interrupt: Interrupt<GetInterruptType<Bag>> | undefined;

  /**
   * Messages inferred from the thread.
   * Will automatically update with incoming message chunks.
   */
  messages: Message[];

  /**
   * Get the metadata for a message, such as first thread state the message
   * was seen in and branch information.
   
   * @param message - The message to get the metadata for.
   * @param index - The index of the message in the thread.
   * @returns The metadata for the message.
   */
  getMessagesMetadata: (
    message: Message,
    index?: number
  ) => MessageMetadata<StateType> | undefined;

  /**
   * LangGraph SDK client used to send request and receive responses.
   */
  client: Client;

  /**
   * The ID of the assistant to use.
   */
  assistantId: string;

  /**
   * Join an active stream.
   */
  joinStream: (
    runId: string,
    lastEventId?: string,
    options?: { streamMode?: StreamMode | StreamMode[] }
  ) => Promise<void>;
}

type ConfigWithConfigurable<ConfigurableType extends Record<string, unknown>> =
  Config & { configurable?: ConfigurableType };

interface SubmitOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  ContextType extends Record<string, unknown> = Record<string, unknown>
> {
  config?: ConfigWithConfigurable<ContextType>;
  context?: ContextType;
  checkpoint?: Omit<Checkpoint, "thread_id"> | null;
  command?: Command;
  interruptBefore?: "*" | string[];
  interruptAfter?: "*" | string[];
  metadata?: Metadata;
  multitaskStrategy?: MultitaskStrategy;
  onCompletion?: OnCompletionBehavior;
  onDisconnect?: DisconnectMode;
  feedbackKeys?: string[];
  streamMode?: Array<StreamMode>;
  optimisticValues?:
    | Partial<StateType>
    | ((prev: StateType) => Partial<StateType>);

  /**
   * Whether or not to stream the nodes of any subgraphs called
   * by the assistant.
   * @default false
   */
  streamSubgraphs?: boolean;

  /**
   * Mark the stream as resumable. All events emitted during the run will be temporarily persisted
   * in order to be re-emitted if the stream is re-joined.
   * @default false
   */
  streamResumable?: boolean;

  /**
   * Whether to checkpoint during the run (or only at the end/interruption).
   * - `"async"`: Save checkpoint asynchronously while the next step executes (default).
   * - `"sync"`: Save checkpoint synchronously before the next step starts.
   * - `"exit"`: Save checkpoint only when the graph exits.
   * @default "async"
   */
  durability?: Durability;
  /**
   * The ID to use when creating a new thread. When provided, this ID will be used
   * for thread creation when threadId is `null` or `undefined`.
   * This enables optimistic UI updates where you know the thread ID
   * before the thread is actually created.
   */
  threadId?: string;
}

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

  const {
    messagesKey = "messages",
    assistantId,
    fetchStateHistory,
    onCreated,
  } = options;

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

  const trackStreamModeRef = useRef<
    Array<
      | "values"
      | "updates"
      | "events"
      | "custom"
      | "messages-tuple"
      | "checkpoints"
      | "tasks"
    >
  >([]);

  const trackStreamMode = useCallback(
    (...mode: Exclude<StreamMode, "debug" | "messages">[]) => {
      for (const m of mode) {
        if (!trackStreamModeRef.current.includes(m)) {
          trackStreamModeRef.current.push(m);
        }
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
    typeof fetchStateHistory === "object" && fetchStateHistory != null
      ? fetchStateHistory.limit ?? true
      : fetchStateHistory ?? true,
    clearCallbackRef,
    submittingRef,
    onErrorRef
  );

  const getMessages = (value: StateType): Message[] =>
    Array.isArray(value[messagesKey]) ? value[messagesKey] : [];

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
    streamManager.stop(historyValues, { ...options, messagesKey });

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

    await streamManager.start(
      async (signal: AbortSignal) => {
        let usableThreadId = threadId;
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
        let rejoinKey: `lg:stream:${string}` | undefined;
        let callbackMeta: RunCallbackMeta | undefined;
        const streamResumable =
          submitOptions?.streamResumable ?? !!runMetadataStorage;

        const stream = client.runs.stream(usableThreadId, assistantId, {
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
              thread_id: params.thread_id ?? usableThreadId,
            };

            if (runMetadataStorage) {
              rejoinKey = `lg:stream:${callbackMeta.thread_id}`;
              runMetadataStorage.setItem(rejoinKey, callbackMeta.run_id);
            }
            onCreated?.(callbackMeta);
          },
        }) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;

        return {
          stream,
          getCallbackMeta: () => callbackMeta,
          onSuccess: () => {
            if (rejoinKey) runMetadataStorage?.removeItem(rejoinKey);
            return history.mutate(usableThreadId);
          },
        };
      },
      historyValues,
      { ...options, messagesKey }
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

    await streamManager.start(
      async (signal: AbortSignal) => {
        const stream = client.runs.joinStream(threadId, runId, {
          signal,
          lastEventId,
          streamMode: joinOptions?.streamMode,
        }) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;

        return {
          onSuccess: () => {
            runMetadataStorage?.removeItem(`lg:stream:${threadId}`);
            return history.mutate(threadId);
          },
          stream,
          getCallbackMeta: () => ({ thread_id: threadId, run_id: runId }),
        };
      },
      historyValues,
      { ...options, messagesKey }
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
    assistantId,

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
      if (fetchStateHistory === false) {
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
