/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type BaseMessageChunk,
  type BaseMessage,
  coerceMessageLikeToMessage,
  convertToChunk,
  isBaseMessageChunk,
} from "@langchain/core/messages";
import { Client, getClientConfigHash, type ClientConfig } from "../client.js";
import type {
  Command,
  DisconnectMode,
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
  ErrorStreamEvent,
  EventsStreamEvent,
  FeedbackStreamEvent,
  MessagesStreamEvent,
  MessagesTupleStreamEvent,
  MetadataStreamEvent,
  StreamMode,
  TasksStreamEvent,
  UpdatesStreamEvent,
  ValuesStreamEvent,
} from "../types.stream.js";

class StreamError extends Error {
  constructor(data: { error?: string; name?: string; message: string }) {
    super(data.message);
    this.name = data.name ?? data.error ?? "StreamError";
  }

  static isStructuredError(error: unknown): error is {
    error?: string;
    name?: string;
    message: string;
  } {
    return typeof error === "object" && error != null && "message" in error;
  }
}

function tryConvertToChunk(message: BaseMessage): BaseMessageChunk | null {
  try {
    return convertToChunk(message);
  } catch {
    return null;
  }
}

class MessageTupleManager {
  chunks: Record<
    string,
    { chunk?: BaseMessageChunk | BaseMessage; index?: number }
  > = {};

  constructor() {
    this.chunks = {};
  }

  add(serialized: Message): string | null {
    // TODO: this is sometimes sent from the API
    // figure out how to prevent this or move this to LC.js
    if (serialized.type.endsWith("MessageChunk")) {
      // eslint-disable-next-line no-param-reassign
      serialized.type = serialized.type
        .slice(0, -"MessageChunk".length)
        .toLowerCase() as Message["type"];
    }

    const message = coerceMessageLikeToMessage(serialized);
    const chunk = tryConvertToChunk(message);

    const { id } = chunk ?? message;
    if (!id) {
      console.warn(
        "No message ID found for chunk, ignoring in state",
        serialized
      );
      return null;
    }

    this.chunks[id] ??= {};
    if (chunk) {
      const prev = this.chunks[id].chunk;
      this.chunks[id].chunk =
        (isBaseMessageChunk(prev) ? prev : null)?.concat(chunk) ?? chunk;
    } else {
      this.chunks[id].chunk = message;
    }

    return id;
  }

  clear() {
    this.chunks = {};
  }

  get(id: string, defaultIndex: number) {
    if (this.chunks[id] == null) return null;
    this.chunks[id].index ??= defaultIndex;

    return this.chunks[id];
  }
}

const toMessageDict = (chunk: BaseMessage): Message => {
  const { type, data } = chunk.toDict();
  return { ...data, type } as Message;
};

function unique<T>(array: T[]) {
  return [...new Set(array)] as T[];
}

function findLastIndex<T>(array: T[], predicate: (item: T) => boolean) {
  for (let i = array.length - 1; i >= 0; i -= 1) {
    if (predicate(array[i])) return i;
  }
  return -1;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Node<StateType = any> {
  type: "node";
  value: ThreadState<StateType>;
  path: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Fork<StateType = any> {
  type: "fork";
  items: Array<Sequence<StateType>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Sequence<StateType = any> {
  type: "sequence";
  items: Array<Node<StateType> | Fork<StateType>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ValidFork<StateType = any> {
  type: "fork";
  items: Array<ValidSequence<StateType>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ValidSequence<StateType = any> {
  type: "sequence";
  items: [Node<StateType>, ...(Node<StateType> | ValidFork<StateType>)[]];
}

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
};

function getBranchSequence<StateType extends Record<string, unknown>>(
  history: ThreadState<StateType>[]
) {
  const childrenMap: Record<string, ThreadState<StateType>[]> = {};

  // Short circuit if there's only a singular one state
  // TODO: I think we can make this more generalizable for all `fetchStateHistory` values.
  if (history.length <= 1) {
    return {
      rootSequence: {
        type: "sequence",
        items: history.map((value) => ({ type: "node", value, path: [] })),
      } satisfies Sequence<StateType>,
      paths: [],
    };
  }

  // First pass - collect nodes for each checkpoint
  history.forEach((state) => {
    const checkpointId = state.parent_checkpoint?.checkpoint_id ?? "$";
    childrenMap[checkpointId] ??= [];
    childrenMap[checkpointId].push(state);
  });

  // Second pass - create a tree of sequences
  type Task = { id: string; sequence: Sequence; path: string[] };
  const rootSequence: Sequence = { type: "sequence", items: [] };
  const queue: Task[] = [{ id: "$", sequence: rootSequence, path: [] }];

  const paths: string[][] = [];

  const visited = new Set<string>();
  while (queue.length > 0) {
    const task = queue.shift()!;
    if (visited.has(task.id)) continue;
    visited.add(task.id);

    const children = childrenMap[task.id];
    if (children == null || children.length === 0) continue;

    // If we've encountered a fork (2+ children), push the fork
    // to the sequence and add a new sequence for each child
    let fork: Fork | undefined;
    if (children.length > 1) {
      fork = { type: "fork", items: [] };
      task.sequence.items.push(fork);
    }

    for (const value of children) {
      const id = value.checkpoint?.checkpoint_id;
      if (id == null) continue;

      let { sequence } = task;
      let { path } = task;
      if (fork != null) {
        sequence = { type: "sequence", items: [] };
        fork.items.unshift(sequence);

        path = path.slice();
        path.push(id);
        paths.push(path);
      }

      sequence.items.push({ type: "node", value, path });
      queue.push({ id, sequence, path });
    }
  }

  return { rootSequence, paths };
}

const PATH_SEP = ">";
const ROOT_ID = "$";

// Get flat view
function getBranchView<StateType extends Record<string, unknown>>(
  sequence: Sequence<StateType>,
  paths: string[][],
  branch: string
) {
  const path = branch.split(PATH_SEP);
  const pathMap: Record<string, string[][]> = {};

  for (const path of paths) {
    const parent = path.at(-2) ?? ROOT_ID;
    pathMap[parent] ??= [];
    pathMap[parent].unshift(path);
  }

  const history: ThreadState<StateType>[] = [];
  const branchByCheckpoint: Record<
    string,
    { branch: string | undefined; branchOptions: string[] | undefined }
  > = {};

  const forkStack = path.slice();
  const queue: (Node<StateType> | Fork<StateType>)[] = [...sequence.items];

  while (queue.length > 0) {
    const item = queue.shift()!;

    if (item.type === "node") {
      history.push(item.value);
      const checkpointId = item.value.checkpoint?.checkpoint_id;
      if (checkpointId == null) continue;

      branchByCheckpoint[checkpointId] = {
        branch: item.path.join(PATH_SEP),
        branchOptions: (item.path.length > 0
          ? pathMap[item.path.at(-2) ?? ROOT_ID] ?? []
          : []
        ).map((p) => p.join(PATH_SEP)),
      };
    }
    if (item.type === "fork") {
      const forkId = forkStack.shift();
      const index =
        forkId != null
          ? item.items.findIndex((value) => {
              const firstItem = value.items.at(0);
              if (!firstItem || firstItem.type !== "node") return false;
              return firstItem.value.checkpoint?.checkpoint_id === forkId;
            })
          : -1;

      const nextItems = item.items.at(index)?.items ?? [];
      queue.push(...nextItems);
    }
  }

  return { history, branchByCheckpoint };
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
  const [isLoading, setIsLoading] = useState(false);
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
  }, [fetcher, clientHash, limit, submittingRef, threadId]);

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
    data: UpdatesStreamEvent<GetUpdateType<Bag, StateType>>["data"]
  ) => void;

  /**
   * Callback that is called when a custom event is received.
   */
  onCustomEvent?: (
    data: CustomStreamEvent<GetCustomEventType<Bag>>["data"],
    options: {
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
  onDebugEvent?: (data: DebugStreamEvent["data"]) => void;

  /**
   * Callback that is called when a checkpoints event is received.
   */
  onCheckpointEvent?: (data: CheckpointsStreamEvent<StateType>["data"]) => void;

  /**
   * Callback that is called when a tasks event is received.
   */
  onTaskEvent?: (
    data: TasksStreamEvent<StateType, GetUpdateType<Bag, StateType>>["data"]
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
  stop: () => void;

  /**
   * Create and stream a run to the thread.
   */
  submit: (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    options?: SubmitOptions<StateType, GetConfigurableType<Bag>>
  ) => void;

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
  streamResumable?: boolean;
  /**
   * The ID to use when creating a new thread. When provided, this ID will be used
   * for thread creation when threadId is `null` or `undefined`.
   * This enables optimistic UI updates where you know the thread ID
   * before the thread is actually created.
   */
  threadId?: string;
}

function useStreamValuesState<StateType extends Record<string, unknown>>() {
  type Kind = "stream" | "stop";
  type Values = StateType | null;
  type Update = Values | ((prev: Values, kind?: Kind) => Values);
  type Mutate = Partial<StateType> | ((prev: StateType) => Partial<StateType>);

  const [values, setValues] = useState<[values: StateType, kind: Kind] | null>(
    null
  );

  const setStreamValues = useCallback(
    (values: Update, kind: Kind = "stream") => {
      if (typeof values === "function") {
        setValues((prevTuple) => {
          const [prevValues, prevKind] = prevTuple ?? [null, "stream"];
          const next = values(prevValues, prevKind);

          if (next == null) return null;
          return [next, kind] as [StateType, Kind];
        });

        return;
      }

      if (values == null) setValues(null);
      setValues([values, kind] as [StateType, Kind]);
    },
    []
  );

  const mutate = useCallback(
    (kind: Kind, serverValues: StateType) => (update: Mutate) => {
      setStreamValues((clientValues) => {
        const prev = { ...serverValues, ...clientValues };
        const next = typeof update === "function" ? update(prev) : update;
        return { ...prev, ...next };
      }, kind);
    },
    [setStreamValues]
  );

  return [values?.[0] ?? null, setStreamValues, mutate] as [
    Values,
    (update: Update, kind?: Kind) => void,
    (kind: Kind, serverValues: StateType) => (update: Mutate) => void
  ];
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

  type EventStreamEvent =
    | ValuesStreamEvent<StateType>
    | UpdatesStreamEvent<UpdateType>
    | CustomStreamEvent<CustomType>
    | DebugStreamEvent
    | MessagesStreamEvent
    | MessagesTupleStreamEvent
    | EventsStreamEvent
    | MetadataStreamEvent
    | CheckpointsStreamEvent<StateType>
    | TasksStreamEvent<StateType, UpdateType>
    | ErrorStreamEvent
    | FeedbackStreamEvent;

  let { messagesKey } = options;
  const { assistantId, fetchStateHistory } = options;
  const { onCreated, onError, onFinish } = options;

  const reconnectOnMountRef = useRef(options.reconnectOnMount);
  const runMetadataStorage = useMemo(() => {
    if (typeof window === "undefined") return null;
    const storage = reconnectOnMountRef.current;
    if (storage === true) return window.sessionStorage;
    if (typeof storage === "function") return storage();
    return null;
  }, []);

  messagesKey ??= "messages";

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

  const [threadId, onThreadId] = useControllableThreadId(options);

  const [branch, setBranch] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);

  const [streamError, setStreamError] = useState<unknown>(undefined);
  const [streamValues, setStreamValues, getMutateFn] =
    useStreamValuesState<StateType>();

  const messageManagerRef = useRef(new MessageTupleManager());
  const submittingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

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
  clearCallbackRef.current = () => {
    setStreamError(undefined);
    setStreamValues(null);
    messageManagerRef.current.clear();
  };

  const onErrorRef = useRef<
    ((error: unknown, run?: RunCallbackMeta) => void) | undefined
  >(undefined);
  onErrorRef.current = options.onError;

  const historyLimit =
    typeof fetchStateHistory === "object" && fetchStateHistory != null
      ? fetchStateHistory.limit ?? true
      : fetchStateHistory ?? true;

  const history = useThreadHistory<StateType>(
    threadId,
    client,
    historyLimit,
    clearCallbackRef,
    submittingRef,
    onErrorRef
  );

  const getMessages = useMemo(() => {
    return (value: StateType) =>
      Array.isArray(value[messagesKey])
        ? (value[messagesKey] as Message[])
        : [];
  }, [messagesKey]);

  const { rootSequence, paths } = getBranchSequence(history.data ?? []);
  const { history: flatHistory, branchByCheckpoint } = getBranchView(
    rootSequence,
    paths,
    branch
  );

  const threadHead: ThreadState<StateType> | undefined = flatHistory.at(-1);
  const historyValues =
    threadHead?.values ?? options.initialValues ?? ({} as StateType);

  const historyValueError = (() => {
    const error = threadHead?.tasks?.at(-1)?.error;
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
        const firstSeenIdx = findLastIndex(history.data ?? [], (state) =>
          getMessages(state.values)
            .map((m, idx) => m.id ?? idx)
            .includes(messageId)
        );

        const firstSeen = history.data?.[firstSeenIdx] as
          | ThreadState<StateType>
          | undefined;

        const checkpointId = firstSeen?.checkpoint?.checkpoint_id;
        let branch =
          firstSeen && checkpointId != null
            ? branchByCheckpoint[checkpointId]
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
          firstSeenState: firstSeen,

          branch: branch?.branch,
          branchOptions: branch?.branchOptions,
        };
      }
    );
  })();

  const stop = () => {
    if (abortRef.current != null) abortRef.current.abort();
    abortRef.current = null;

    if (runMetadataStorage && threadId) {
      const runId = runMetadataStorage.getItem(`lg:stream:${threadId}`);
      if (runId) void client.runs.cancel(threadId, runId);
      runMetadataStorage.removeItem(`lg:stream:${threadId}`);
    }

    options?.onStop?.({ mutate: getMutateFn("stop", historyValues) });
  };

  async function consumeStream(
    action: (signal: AbortSignal) => Promise<{
      onSuccess: () => Promise<ThreadState<StateType>[]>;
      stream: AsyncGenerator<EventStreamEvent>;
      getCallbackMeta: () => { thread_id: string; run_id: string } | undefined;
    }>
  ) {
    let getCallbackMeta:
      | (() => { thread_id: string; run_id: string } | undefined)
      | undefined;
    try {
      setIsLoading(true);
      setStreamError(undefined);

      submittingRef.current = true;
      abortRef.current = new AbortController();

      const run = await action(abortRef.current.signal);
      getCallbackMeta = run.getCallbackMeta;

      let streamError: StreamError | undefined;
      for await (const { event, data } of run.stream) {
        if (event === "error") {
          streamError = new StreamError(data);
          break;
        }

        if (event === "updates") options.onUpdateEvent?.(data);
        if (
          event === "custom" ||
          // if `streamSubgraphs: true`, then we also want
          // to also receive custom events from subgraphs
          event.startsWith("custom|")
        )
          options.onCustomEvent?.(data as CustomType, {
            mutate: getMutateFn("stream", historyValues),
          });
        if (event === "metadata") options.onMetadataEvent?.(data);
        if (event === "events") options.onLangChainEvent?.(data);
        if (event === "debug") options.onDebugEvent?.(data);
        if (event === "checkpoints") options.onCheckpointEvent?.(data);
        if (event === "tasks") options.onTaskEvent?.(data);

        if (event === "values") {
          if ("__interrupt__" in data) {
            // don't update values on interrupt values event
            continue;
          }
          setStreamValues(data);
        }
        if (
          event === "messages" ||
          // if `streamSubgraphs: true`, then we also want
          // to also receive messages from subgraphs
          event.startsWith("messages|")
        ) {
          const [serialized] = data as MessagesTupleStreamEvent["data"];

          const messageId = messageManagerRef.current.add(serialized);
          if (!messageId) {
            console.warn(
              "Failed to add message to manager, no message ID found"
            );
            continue;
          }

          setStreamValues((streamValues) => {
            const values = { ...historyValues, ...streamValues };

            // Assumption: we're concatenating the message
            const messages = getMessages(values).slice();
            const { chunk, index } =
              messageManagerRef.current.get(messageId, messages.length) ?? {};

            if (!chunk || index == null) return values;
            messages[index] = toMessageDict(chunk);

            return { ...values, [messagesKey!]: messages };
          });
        }
      }

      // TODO: stream created checkpoints to avoid an unnecessary network request
      const result = await run.onSuccess();
      setStreamValues((values, kind) => {
        // Do not clear out the user values set on `stop`.
        if (kind === "stop") return values;
        return null;
      });
      if (streamError != null) throw streamError;

      const lastHead = result.at(0);
      if (lastHead) onFinish?.(lastHead, getCallbackMeta?.());
    } catch (error) {
      if (
        !(
          error instanceof Error && // eslint-disable-line no-instanceof/no-instanceof
          (error.name === "AbortError" || error.name === "TimeoutError")
        )
      ) {
        console.error(error);
        setStreamError(error);
        onError?.(error, getCallbackMeta?.());
      }
    } finally {
      setIsLoading(false);
      submittingRef.current = false;
      abortRef.current = null;
    }
  }

  const joinStream = async (
    runId: string,
    lastEventId?: string,
    options?: { streamMode?: StreamMode | StreamMode[] }
  ) => {
    // eslint-disable-next-line no-param-reassign
    lastEventId ??= "-1";
    if (!threadId) return;
    await consumeStream(async (signal: AbortSignal) => {
      const stream = client.runs.joinStream(threadId, runId, {
        signal,
        lastEventId,
        streamMode: options?.streamMode,
      }) as AsyncGenerator<EventStreamEvent>;

      return {
        onSuccess: () => {
          runMetadataStorage?.removeItem(`lg:stream:${threadId}`);
          return history.mutate(threadId);
        },
        stream,
        getCallbackMeta: () => ({ thread_id: threadId, run_id: runId }),
      };
    });
  };

  const submit = async (
    values: UpdateType | null | undefined,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>
  ) => {
    await consumeStream(async (signal: AbortSignal) => {
      // Unbranch things
      const newPath = submitOptions?.checkpoint?.checkpoint_id
        ? branchByCheckpoint[submitOptions?.checkpoint?.checkpoint_id]?.branch
        : undefined;

      if (newPath != null) setBranch(newPath ?? "");

      setStreamValues(() => {
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

      let usableThreadId = threadId;
      if (!usableThreadId) {
        const thread = await client.threads.create({
          threadId: submitOptions?.threadId,
          metadata: submitOptions?.metadata,
        });
        onThreadId(thread.thread_id);
        usableThreadId = thread.thread_id;
      }
      if (!usableThreadId) throw new Error("Failed to obtain valid thread ID.");

      const streamMode = unique([
        ...(submitOptions?.streamMode ?? []),
        ...trackStreamModeRef.current,
        ...callbackStreamMode,
      ]);

      let checkpoint =
        submitOptions?.checkpoint ?? threadHead?.checkpoint ?? undefined;

      // Avoid specifying a checkpoint if user explicitly set it to null
      if (submitOptions?.checkpoint === null) {
        checkpoint = undefined;
      }

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
      }) as AsyncGenerator<EventStreamEvent>;

      return {
        stream,
        getCallbackMeta: () => callbackMeta,
        onSuccess: () => {
          if (rejoinKey) runMetadataStorage?.removeItem(rejoinKey);
          return history.mutate(usableThreadId);
        },
      };
    });
  };

  const reconnectKey = useMemo(() => {
    if (!runMetadataStorage || isLoading) return undefined;
    if (typeof window === "undefined") return undefined;
    const runId = runMetadataStorage?.getItem(`lg:stream:${threadId}`);
    if (!runId) return undefined;
    return { runId, threadId };
  }, [runMetadataStorage, isLoading, threadId]);

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

  const error = streamError ?? historyValueError ?? history.error;
  const values = streamValues ?? historyValues;

  return {
    get values() {
      trackStreamMode("values");
      return values;
    },

    client,
    assistantId,

    error,
    isLoading,

    stop,
    submit, // eslint-disable-line @typescript-eslint/no-misused-promises

    joinStream,

    branch,
    setBranch,

    history: flatHistory,
    isThreadLoading: history.isLoading && history.data == null,

    get experimental_branchTree() {
      if (historyLimit === false) {
        throw new Error(
          "`experimental_branchTree` is not available when `fetchStateHistory` is set to `false`"
        );
      }

      return rootSequence;
    },

    get interrupt() {
      // Don't show the interrupt if the stream is loading
      if (isLoading) return undefined;

      const interrupts = threadHead?.tasks?.at(-1)?.interrupts;
      if (interrupts == null || interrupts.length === 0) {
        // check if there's a next task present
        const next = threadHead?.next ?? [];
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
      trackStreamMode("messages-tuple", "values");
      return messageMetadata?.find(
        (m) => m.messageId === (message.id ?? index)
      );
    },
  };
}
