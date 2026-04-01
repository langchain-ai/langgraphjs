"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Interrupt,
  Message,
  Run,
  StreamEvent,
  Thread,
} from "@langchain/langgraph-sdk";
import { Client } from "@langchain/langgraph-sdk/client";
import type {
  QueueEntry,
  QueueInterface,
  RunCallbackMeta,
  SubmitOptions,
} from "@langchain/langgraph-sdk/ui";
import { useControllableThreadId } from "./thread.js";

type ThreadStreamMode = "run_modes" | "lifecycle" | "state_update";

type ThreadStreamEvent = {
  id?: string;
  event: StreamEvent;
  data: unknown;
};

type ClientInit = NonNullable<ConstructorParameters<typeof Client>[0]>;

type ThreadSubmitOptions<StateType extends Record<string, unknown>> =
  SubmitOptions<StateType, Record<string, unknown>>;

type ThreadQueueEntry<StateType extends Record<string, unknown>> = QueueEntry<
  StateType,
  ThreadSubmitOptions<StateType>
>;

const DEFAULT_RECONCILE_DEBOUNCE_MS = 150;
const DEFAULT_MAX_RUNS = 50;
const FALLBACK_REFRESH_IDLE_MS = 3000;
const FALLBACK_REFRESH_BUSY_MS = 1000;
const STREAM_RECONNECT_DELAY_MS = 250;

function isAbortError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;

  if (
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  ) {
    return true;
  }

  return (
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_ABORTED"
  );
}

function isValidRedisStreamId(value: string): boolean {
  return /^(\d+)-(\d+)$/.test(value);
}

function isHttpNotFoundError(error: unknown): boolean {
  let message: string | undefined;
  if (typeof error === "string") {
    message = error;
  } else if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    message = (error as { message: string }).message;
  }

  if (!message) return false;

  return message.includes("HTTP 404");
}

function getReconnectKey(threadId: string): `lg:thread-stream:${string}` {
  return `lg:thread-stream:${threadId}`;
}

export interface UseThreadStreamOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
> {
  assistantId?: string;
  threadId?: string | null;
  onThreadId?: (threadId: string) => void;
  client?: Client;
  apiUrl?: string;
  apiKey?: string;
  callerOptions?: ClientInit["callerOptions"];
  defaultHeaders?: ClientInit["defaultHeaders"];
  streamMode?: ThreadStreamMode | ThreadStreamMode[];
  reconcileDebounceMs?: number;
  maxRuns?: number;
  enabled?: boolean;
  reconnectOnMount?: boolean | (() => Storage | null);
  reconcileOnFocus?: boolean;
  reconcileOnReconnect?: boolean;
  messagesKey?: keyof StateType & string;
  getMessages?: (values: StateType | undefined) => Message[];
  onEvent?: (event: ThreadStreamEvent) => void;
  onError?: (error: unknown) => void;
  onCreated?: (run: RunCallbackMeta) => void;
  onStop?: () => void;
}

export interface UseThreadStreamValue<
  StateType extends Record<string, unknown> = Record<string, unknown>,
> {
  client: Client;
  assistantId?: string;
  threadId: string | null;
  thread: Thread<StateType> | null;
  values: StateType | undefined;
  messages: Message[];
  runningRuns: Run[];
  pendingRuns: Run[];
  queuedRunCount: number;
  isBusy: boolean;
  isConnected: boolean;
  isLoading: boolean;
  error: unknown;
  lastEventId?: string;
  interrupt: Interrupt | undefined;
  interrupts: Interrupt[];
  refresh: () => Promise<void>;
  submit: (
    values: Partial<StateType> | null | undefined,
    submitOptions?: ThreadSubmitOptions<StateType>,
  ) => Promise<void>;
  stop: () => Promise<void>;
  switchThread: (threadId: string | null) => void;
  queue: QueueInterface<StateType, ThreadSubmitOptions<StateType>>;
}

/**
 * Subscribe to a thread-wide stream and reconcile busy/queue state.
 *
 * @experimental
 */
export function useThreadStream(
  options: UseThreadStreamOptions,
): UseThreadStreamValue;

export function useThreadStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
>(
  options: UseThreadStreamOptions<StateType>,
): UseThreadStreamValue<StateType>;

export function useThreadStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
>(
  options: UseThreadStreamOptions<StateType>,
): UseThreadStreamValue<StateType> {
  const {
    assistantId,
    enabled: enabledOption,
    maxRuns: maxRunsOption,
    reconcileDebounceMs: reconcileDebounceMsOption,
    streamMode: streamModeOption,
    reconnectOnMount,
    getMessages,
    messagesKey,
  } = options;

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
      options.apiUrl,
      options.apiKey,
      options.callerOptions,
      options.defaultHeaders,
    ],
  );

  const enabled = enabledOption ?? true;
  const maxRuns = maxRunsOption ?? DEFAULT_MAX_RUNS;
  const reconcileDebounceMs =
    reconcileDebounceMsOption ?? DEFAULT_RECONCILE_DEBOUNCE_MS;

  const streamModeKey = useMemo(() => {
    const mode = streamModeOption ?? ["run_modes"];
    if (Array.isArray(mode)) {
      return mode.join("|");
    }
    return mode;
  }, [streamModeOption]);

  const streamMode = useMemo<ThreadStreamMode | ThreadStreamMode[]>(() => {
    const mode = streamModeOption ?? ["run_modes"];
    return Array.isArray(mode) ? [...mode] : mode;
  }, [streamModeKey]);

  const [threadId, setThreadId] = useControllableThreadId(options);

  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;

  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  const onCreatedRef = useRef(options.onCreated);
  onCreatedRef.current = options.onCreated;

  const onStopRef = useRef(options.onStop);
  onStopRef.current = options.onStop;

  const clientRef = useRef(client);
  clientRef.current = client;

  const streamModeRef = useRef<ThreadStreamMode | ThreadStreamMode[]>(streamMode);
  streamModeRef.current = streamMode;

  const [thread, setThread] = useState<Thread<StateType> | null>(null);
  const [runningRuns, setRunningRuns] = useState<Run[]>([]);
  const [pendingRuns, setPendingRuns] = useState<Run[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<unknown>();
  const [isThreadStreamSupported, setIsThreadStreamSupported] = useState(true);
  const [lastEventId, setLastEventId] = useState<string | undefined>(undefined);
  const [queueEntries, setQueueEntries] = useState<ThreadQueueEntry<StateType>[]>(
    [],
  );

  const reconnectStorage = useMemo(() => {
    if (typeof window === "undefined") return null;

    if (reconnectOnMount === true) return window.sessionStorage;
    if (typeof reconnectOnMount === "function") return reconnectOnMount();
    return null;
  }, [reconnectOnMount]);

  const reconnectStorageRef = useRef(reconnectStorage);
  reconnectStorageRef.current = reconnectStorage;

  const mountedRef = useRef(true);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const isBusyRef = useRef(false);
  const lastEventIdRef = useRef<string | undefined>(undefined);
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueMetaRef = useRef(
    new Map<
      string,
      {
        values: Partial<StateType> | null | undefined;
        options?: ThreadSubmitOptions<StateType>;
        createdAt: Date;
      }
    >(),
  );

  const syncQueueEntries = useCallback((runs: Run[]) => {
    const pendingIds = new Set(runs.map((run) => run.run_id));

    for (const id of queueMetaRef.current.keys()) {
      if (!pendingIds.has(id)) queueMetaRef.current.delete(id);
    }

    setQueueEntries(
      runs.map((run) => {
        const metadata = queueMetaRef.current.get(run.run_id);
        return {
          id: run.run_id,
          values: metadata?.values,
          options: metadata?.options,
          createdAt: metadata?.createdAt ?? new Date(run.created_at),
        };
      }),
    );
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearReconcileTimer = useCallback(() => {
    if (reconcileTimerRef.current != null) {
      clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled || threadId == null) {
      if (!mountedRef.current) return;
      setThread(null);
      setRunningRuns([]);
      setPendingRuns([]);
      setQueueEntries([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    const threadIdAtStart = threadId;
    try {
      const [nextThread, nextRunning, nextPending] = await Promise.all([
        client.threads.get<StateType>(threadIdAtStart),
        client.runs.list(threadIdAtStart, {
          status: "running",
          limit: maxRuns,
        }),
        client.runs.list(threadIdAtStart, {
          status: "pending",
          limit: maxRuns,
        }),
      ]);

      if (
        !mountedRef.current ||
        threadIdRef.current == null ||
        threadIdRef.current !== threadIdAtStart
      ) {
        return;
      }

      setThread(nextThread);
      setRunningRuns(nextRunning);
      setPendingRuns(nextPending);
      syncQueueEntries(nextPending);
      setError(undefined);
    } catch (nextError) {
      if (!isAbortError(nextError)) {
        setError(nextError);
        onErrorRef.current?.(nextError);
      }
    } finally {
      if (
        mountedRef.current &&
        threadIdRef.current != null &&
        threadIdRef.current === threadIdAtStart
      ) {
        setIsLoading(false);
      }
    }
  }, [client, enabled, maxRuns, syncQueueEntries, threadId]);

  const scheduleReconcile = useCallback(() => {
    if (reconcileTimerRef.current != null) return;

    reconcileTimerRef.current = setTimeout(() => {
      reconcileTimerRef.current = null;
      void refresh();
    }, reconcileDebounceMs);
  }, [reconcileDebounceMs, refresh]);

  const scheduleReconcileRef = useRef(scheduleReconcile);
  scheduleReconcileRef.current = scheduleReconcile;

  useEffect(() => {
    if (!enabled || threadId == null) {
      clearReconcileTimer();
      setThread(null);
      setRunningRuns([]);
      setPendingRuns([]);
      setQueueEntries([]);
      setIsConnected(false);
      setIsLoading(false);
      setError(undefined);
      setIsThreadStreamSupported(true);
      setLastEventId(undefined);
      lastEventIdRef.current = undefined;
      return;
    }

    if (reconnectStorage) {
      const reconnectKey = getReconnectKey(threadId);
      const storedEventId = reconnectStorage.getItem(reconnectKey);
      if (storedEventId != null) {
        if (isValidRedisStreamId(storedEventId)) {
          setLastEventId(storedEventId);
          lastEventIdRef.current = storedEventId;
        } else {
          reconnectStorage.removeItem(reconnectKey);
          setLastEventId(undefined);
          lastEventIdRef.current = undefined;
        }
      }
    }

    void refresh();
  }, [clearReconcileTimer, enabled, reconnectStorage, refresh, threadId]);

  useEffect(() => {
    if (!isThreadStreamSupported) return;
    if (!enabled || threadId == null) return;
    if (typeof window === "undefined") return;

    const reconcileOnFocus = options.reconcileOnFocus ?? true;
    const reconcileOnReconnect = options.reconcileOnReconnect ?? true;

    const onVisible = () => {
      if (!reconcileOnFocus) return;
      if (document.visibilityState === "visible") void refresh();
    };
    const onFocus = () => {
      if (reconcileOnFocus) void refresh();
    };
    const onOnline = () => {
      if (reconcileOnReconnect) void refresh();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [
    enabled,
    options.reconcileOnFocus,
    options.reconcileOnReconnect,
    refresh,
    threadId,
  ]);

  useEffect(() => {
    if (!enabled || threadId == null) return;

    const controller = new AbortController();
    let isDisposed = false;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });

    const consume = async () => {
      while (!isDisposed && !controller.signal.aborted) {
        try {
          setIsConnected(true);

          const joinOptions: {
            signal: AbortSignal;
            streamMode: ThreadStreamMode | ThreadStreamMode[];
            lastEventId?: string;
          } = {
            signal: controller.signal,
            streamMode: streamModeRef.current,
          };

          const reconnectEventId = lastEventIdRef.current;
          if (reconnectEventId && isValidRedisStreamId(reconnectEventId)) {
            joinOptions.lastEventId = reconnectEventId;
          }

          for await (const event of clientRef.current.threads.joinStream(
            threadId,
            joinOptions,
          )) {
            if (!mountedRef.current || controller.signal.aborted || isDisposed) {
              return;
            }

            if (event.id != null && event.id !== lastEventIdRef.current) {
              lastEventIdRef.current = event.id;
              setLastEventId(event.id);
              reconnectStorageRef.current?.setItem(
                getReconnectKey(threadId),
                event.id,
              );
            }

            onEventRef.current?.({
              id: event.id,
              event: event.event,
              data: event.data,
            });

            scheduleReconcileRef.current();
          }

          if (controller.signal.aborted || isDisposed) return;

          setIsConnected(false);
          await wait(STREAM_RECONNECT_DELAY_MS);
          continue;
        } catch (nextError) {
          if (controller.signal.aborted || isAbortError(nextError)) return;

          if (isHttpNotFoundError(nextError)) {
            setIsThreadStreamSupported(false);
            setError(undefined);
            return;
          }

          setError(nextError);
          onErrorRef.current?.(nextError);
          setIsConnected(false);

          await wait(STREAM_RECONNECT_DELAY_MS);
        }
      }
    };

    void consume();

    return () => {
      isDisposed = true;
      controller.abort();
      setIsConnected(false);
    };
  }, [
    enabled,
    isThreadStreamSupported,
    threadId,
  ]);

  const isBusy =
    thread?.status === "busy" ||
    runningRuns.length > 0 ||
    pendingRuns.length > 0;

  const fallbackRefreshMs = isBusy
    ? FALLBACK_REFRESH_BUSY_MS
    : FALLBACK_REFRESH_IDLE_MS;

  useEffect(() => {
    isBusyRef.current = isBusy;
  }, [isBusy]);

  useEffect(() => {
    if (isThreadStreamSupported) return;
    if (!enabled || threadId == null) return;

    let isDisposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (isDisposed) return;
      await refresh();
      if (isDisposed) return;
      timer = setTimeout(() => {
        void poll();
      }, fallbackRefreshMs);
    };

    void poll();

    return () => {
      isDisposed = true;
      if (timer != null) clearTimeout(timer);
    };
  }, [
    enabled,
    fallbackRefreshMs,
    isThreadStreamSupported,
    refresh,
    threadId,
  ]);

  const switchThread = useCallback(
    (newThreadId: string | null) => {
      clearReconcileTimer();
      queueMetaRef.current.clear();
      setQueueEntries([]);
      setThreadId(newThreadId);
    },
    [clearReconcileTimer, setThreadId],
  );

  const submit = useCallback(
    async (
      values: Partial<StateType> | null | undefined,
      submitOptions?: ThreadSubmitOptions<StateType>,
    ) => {
      if (!assistantId) {
        throw new Error(
          "`assistantId` is required to submit runs with useThreadStream.",
        );
      }

      let usableThreadId = threadIdRef.current;
      if (!usableThreadId) {
        const thread = await client.threads.create({
          threadId: submitOptions?.threadId,
          metadata: submitOptions?.metadata,
        });
        usableThreadId = thread.thread_id;
        setThreadId(usableThreadId);
      }

      if (!usableThreadId) {
        throw new Error("Could not resolve thread id.");
      }

      const shouldEnqueue =
        isBusyRef.current &&
        submitOptions?.multitaskStrategy !== "interrupt" &&
        submitOptions?.multitaskStrategy !== "rollback";

      const run = await client.runs.create(usableThreadId, assistantId, {
        input: (values ?? {}) as Record<string, unknown>,
        config: submitOptions?.config,
        context: submitOptions?.context,
        command: submitOptions?.command,
        interruptBefore: submitOptions?.interruptBefore,
        interruptAfter: submitOptions?.interruptAfter,
        metadata: submitOptions?.metadata,
        multitaskStrategy: shouldEnqueue
          ? "enqueue"
          : submitOptions?.multitaskStrategy,
        onCompletion: submitOptions?.onCompletion,
        streamSubgraphs: submitOptions?.streamSubgraphs,
        streamResumable: true,
        durability: submitOptions?.durability,
      });

      const callbackMeta: RunCallbackMeta = {
        run_id: run.run_id,
        thread_id: usableThreadId,
      };
      onCreatedRef.current?.(callbackMeta);

      if (shouldEnqueue) {
        queueMetaRef.current.set(run.run_id, {
          values,
          options: submitOptions,
          createdAt: new Date(run.created_at),
        });
      }

      await refresh();
    },
    [assistantId, client, refresh, setThreadId],
  );

  const stop = useCallback(async () => {
    const currentThreadId = threadIdRef.current;
    const activeRunId = runningRuns[0]?.run_id;

    if (currentThreadId && activeRunId) {
      await client.runs.cancel(currentThreadId, activeRunId);
    }

    onStopRef.current?.();
    await refresh();
  }, [client, refresh, runningRuns]);

  const queue = useMemo<
    QueueInterface<StateType, ThreadSubmitOptions<StateType>>
  >(
    () => ({
      get entries() {
        return queueEntries;
      },
      get size() {
        return queueEntries.length;
      },
      cancel: async (id: string) => {
        const currentThreadId = threadIdRef.current;
        if (!currentThreadId) return false;
        const found = queueEntries.some((entry) => entry.id === id);
        if (!found) return false;
        await client.runs.cancel(currentThreadId, id);
        queueMetaRef.current.delete(id);
        await refresh();
        return true;
      },
      clear: async () => {
        const currentThreadId = threadIdRef.current;
        if (!currentThreadId) return;

        const ids = queueEntries.map((entry) => entry.id);
        await Promise.all(ids.map((id) => client.runs.cancel(currentThreadId, id)));
        queueMetaRef.current.clear();
        await refresh();
      },
    }),
    [client, queueEntries, refresh],
  );

  const values = thread?.values;
  const messages = useMemo(() => {
    if (getMessages != null) {
      return getMessages(values);
    }

    const resolvedMessagesKey = (messagesKey ?? "messages") as keyof StateType;
    const threadMessages = values?.[resolvedMessagesKey];
    return Array.isArray(threadMessages) ? (threadMessages as Message[]) : [];
  }, [getMessages, messagesKey, values]);

  const interrupts = useMemo(() => {
    if (values == null || !("__interrupt__" in values)) return [];
    const rawInterrupts = (values as { __interrupt__?: unknown }).__interrupt__;
    return Array.isArray(rawInterrupts) ? (rawInterrupts as Interrupt[]) : [];
  }, [values]);

  return {
    client,
    assistantId,
    threadId,
    thread,
    values,
    messages,
    runningRuns,
    pendingRuns,
    queuedRunCount: pendingRuns.length,
    isBusy,
    isConnected,
    isLoading,
    error,
    lastEventId,
    interrupt: interrupts[0],
    interrupts,
    refresh,
    submit,
    stop,
    switchThread,
    queue,
  };
}
