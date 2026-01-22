import type {
  CheckpointsStreamEvent,
  CustomStreamEvent,
  DebugStreamEvent,
  ErrorStreamEvent,
  EventsStreamEvent,
  FeedbackStreamEvent,
  MessagesTupleStreamEvent,
  MetadataStreamEvent,
  TasksStreamEvent,
  UpdatesStreamEvent,
  ValuesStreamEvent,
} from "../types.stream.js";
import { MessageTupleManager, toMessageDict } from "./messages.js";
import { StreamError } from "./errors.js";
import type { Message } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";

/**
 * Special ID used by LangGraph's messagesStateReducer to signal
 * that all messages should be removed from the state.
 */
export const REMOVE_ALL_MESSAGES = "__remove_all__";

type GetUpdateType<
  Bag extends BagTemplate,
  StateType extends Record<string, unknown>
> = Bag extends { UpdateType: unknown }
  ? Bag["UpdateType"]
  : Partial<StateType>;

type GetCustomEventType<Bag extends BagTemplate> = Bag extends {
  CustomEventType: unknown;
}
  ? Bag["CustomEventType"]
  : unknown;

type EventStreamMap<StateType, UpdateType, CustomType> = {
  values: ValuesStreamEvent<StateType>;
  updates: UpdatesStreamEvent<UpdateType>;
  custom: CustomStreamEvent<CustomType>;
  debug: DebugStreamEvent;
  messages: MessagesTupleStreamEvent;
  events: EventsStreamEvent;
  metadata: MetadataStreamEvent;
  checkpoints: CheckpointsStreamEvent<StateType>;
  tasks: TasksStreamEvent<StateType, UpdateType>;
  error: ErrorStreamEvent;
  feedback: FeedbackStreamEvent;
};

export type EventStreamEvent<StateType, UpdateType, CustomType> =
  EventStreamMap<StateType, UpdateType, CustomType>[keyof EventStreamMap<
    StateType,
    UpdateType,
    CustomType
  >];

interface StreamManagerEventCallbacks<
  StateType extends Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  onUpdateEvent?: (
    data: UpdatesStreamEvent<GetUpdateType<Bag, StateType>>["data"],
    options: {
      namespace: string[] | undefined;
      mutate: (
        update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
      ) => void;
    }
  ) => void;
  onCustomEvent?: (
    data: GetCustomEventType<Bag>,
    options: {
      namespace: string[] | undefined;
      mutate: (
        update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
      ) => void;
    }
  ) => void;
  onMetadataEvent?: (data: MetadataStreamEvent["data"]) => void;
  onLangChainEvent?: (data: EventsStreamEvent["data"]) => void;
  onDebugEvent?: (
    data: DebugStreamEvent["data"],
    options: { namespace: string[] | undefined }
  ) => void;
  onCheckpointEvent?: (
    data: CheckpointsStreamEvent<StateType>["data"],
    options: { namespace: string[] | undefined }
  ) => void;
  onTaskEvent?: (
    data: TasksStreamEvent<StateType, GetUpdateType<Bag, StateType>>["data"],
    options: { namespace: string[] | undefined }
  ) => void;
}

export class StreamManager<
  StateType extends Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  private abortRef = new AbortController();

  private messages: MessageTupleManager;

  private listeners = new Set<() => void>();

  private throttle: number | boolean;

  private queue: Promise<unknown> = Promise.resolve();

  private queueSize: number = 0;

  private state: {
    isLoading: boolean;
    values: [values: StateType, kind: "stream" | "stop"] | null;
    error: unknown;
  };

  constructor(
    messages: MessageTupleManager,
    options: { throttle: number | boolean }
  ) {
    this.messages = messages;
    this.state = { isLoading: false, values: null, error: undefined };
    this.throttle = options.throttle;
  }

  private setState = (newState: Partial<typeof this.state>) => {
    this.state = { ...this.state, ...newState };
    this.notifyListeners();
  };

  private notifyListeners = () => {
    this.listeners.forEach((listener) => listener());
  };

  subscribe = (listener: () => void): (() => void) => {
    if (this.throttle === false) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    const timeoutMs = this.throttle === true ? 0 : this.throttle;
    let timeoutId: NodeJS.Timeout | number | undefined;

    const throttledListener = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        clearTimeout(timeoutId);
        listener();
      }, timeoutMs);
    };

    this.listeners.add(throttledListener);
    return () => {
      clearTimeout(timeoutId);
      this.listeners.delete(throttledListener);
    };
  };

  getSnapshot = () => this.state;

  get isLoading() {
    return this.state.isLoading;
  }

  get values() {
    return this.state.values?.[0] ?? null;
  }

  get error() {
    return this.state.error;
  }

  setStreamValues = (
    values:
      | (StateType | null)
      | ((prev: StateType | null, kind: "stream" | "stop") => StateType | null),
    kind: "stream" | "stop" = "stream"
  ) => {
    if (typeof values === "function") {
      const [prevValues, prevKind] = this.state.values ?? [null, "stream"];
      const nextValues = values(prevValues, prevKind);
      this.setState({ values: nextValues != null ? [nextValues, kind] : null });
    } else {
      const nextValues = values != null ? [values, kind] : null;
      this.setState({ values: nextValues as [StateType, "stream" | "stop"] });
    }
  };

  private getMutateFn = (kind: "stream" | "stop", historyValues: StateType) => {
    return (
      update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
    ) => {
      const stateValues = (this.state.values ?? [null, "stream"])[0];
      const prev = {
        ...historyValues,
        ...(stateValues ?? {}),
      };
      const next = typeof update === "function" ? update(prev) : update;
      this.setStreamValues({ ...prev, ...(next ?? {}) }, kind);
    };
  };

  private matchEventType = <
    T extends keyof EventStreamMap<
      StateType,
      GetUpdateType<Bag, StateType>,
      GetCustomEventType<Bag>
    >
  >(
    expected: T,
    actual: EventStreamEvent<
      StateType,
      GetUpdateType<Bag, StateType>,
      GetCustomEventType<Bag>
    >["event"],
    _data: EventStreamEvent<
      StateType,
      GetUpdateType<Bag, StateType>,
      GetCustomEventType<Bag>
    >["data"]
  ): _data is EventStreamMap<
    StateType,
    GetUpdateType<Bag, StateType>,
    GetCustomEventType<Bag>
  >[T]["data"] => {
    return expected === actual || actual.startsWith(`${expected}|`);
  };

  protected enqueue = async (
    action: (
      signal: AbortSignal
    ) => Promise<
      AsyncGenerator<
        EventStreamEvent<
          StateType,
          GetUpdateType<Bag, StateType>,
          GetCustomEventType<Bag>
        >
      >
    >,
    options: {
      getMessages: (values: StateType) => Message[];

      setMessages: (current: StateType, messages: Message[]) => StateType;

      initialValues: StateType;

      callbacks: StreamManagerEventCallbacks<StateType, Bag>;

      onSuccess: () =>
        | StateType
        | null
        | undefined
        | void
        | Promise<StateType | null | undefined | void>;

      onError: (error: unknown) => void | Promise<void>;

      onFinish?: () => void;
    }
  ) => {
    try {
      this.queueSize = Math.max(0, this.queueSize - 1);
      this.setState({ isLoading: true, error: undefined });
      this.abortRef = new AbortController();

      const run = await action(this.abortRef.signal);

      let streamError: StreamError | undefined;
      for await (const { event, data } of run) {
        if (event === "error") {
          streamError = new StreamError(data);
          break;
        }

        const namespace = event.includes("|")
          ? event.split("|").slice(1)
          : undefined;

        const mutate = this.getMutateFn("stream", options.initialValues);

        if (event === "metadata") options.callbacks.onMetadataEvent?.(data);
        if (event === "events") options.callbacks.onLangChainEvent?.(data);

        if (this.matchEventType("updates", event, data)) {
          options.callbacks.onUpdateEvent?.(data, { namespace, mutate });
        }

        if (this.matchEventType("custom", event, data)) {
          options.callbacks.onCustomEvent?.(data, { namespace, mutate });
        }

        if (this.matchEventType("checkpoints", event, data)) {
          options.callbacks.onCheckpointEvent?.(data, { namespace });
        }

        if (this.matchEventType("tasks", event, data)) {
          options.callbacks.onTaskEvent?.(data, { namespace });
        }

        if (this.matchEventType("debug", event, data)) {
          options.callbacks.onDebugEvent?.(data, { namespace });
        }

        if (event === "values") {
          if (
            data != null &&
            typeof data === "object" &&
            "__interrupt__" in data
          ) {
            this.setStreamValues((prev) => ({ ...(prev ?? {}), ...data }));
          } else {
            this.setStreamValues(data);
          }
        }

        if (this.matchEventType("messages", event, data)) {
          const [serialized, metadata] = data;

          const messageId = this.messages.add(serialized, metadata);
          if (!messageId) {
            console.warn(
              "Failed to add message to manager, no message ID found"
            );
            continue;
          }

          this.setStreamValues((streamValues) => {
            const values = {
              ...options.initialValues,
              ...(streamValues ?? {}),
            };

            // Assumption: we're concatenating the message
            let messages = options.getMessages(values).slice();
            const { chunk, index } =
              this.messages.get(messageId, messages.length) ?? {};

            if (!chunk || index == null) return values;
            if (chunk.getType() === "remove") {
              // Check for special REMOVE_ALL_MESSAGES sentinel
              if (chunk.id === REMOVE_ALL_MESSAGES) {
                // Clear all messages when __remove_all__ is received
                messages = [];
              } else {
                messages.splice(index, 1);
              }
            } else {
              messages[index] = toMessageDict(chunk);
            }

            return options.setMessages(values, messages);
          });
        }
      }

      if (streamError != null) throw streamError;

      const values = await options.onSuccess?.();
      if (typeof values !== "undefined" && this.queueSize === 0) {
        this.setStreamValues(values);
      }
    } catch (error) {
      if (
        !(
          error instanceof Error && // eslint-disable-line no-instanceof/no-instanceof
          (error.name === "AbortError" || error.name === "TimeoutError")
        )
      ) {
        console.error(error);
        this.setState({ error });
        await options.onError?.(error);
      }
    } finally {
      this.setState({ isLoading: false });
      this.abortRef = new AbortController();
      options.onFinish?.();
    }
  };

  start = async (
    action: (
      signal: AbortSignal
    ) => Promise<
      AsyncGenerator<
        EventStreamEvent<
          StateType,
          GetUpdateType<Bag, StateType>,
          GetCustomEventType<Bag>
        >
      >
    >,
    options: {
      getMessages: (values: StateType) => Message[];

      setMessages: (current: StateType, messages: Message[]) => StateType;

      initialValues: StateType;

      callbacks: StreamManagerEventCallbacks<StateType, Bag>;

      onSuccess: () =>
        | StateType
        | null
        | undefined
        | void
        | Promise<StateType | null | undefined | void>;

      onError: (error: unknown) => void | Promise<void>;

      onFinish?: () => void;
    }
  ): Promise<void> => {
    this.queueSize += 1;
    this.queue = this.queue.then(() => this.enqueue(action, options));
  };

  stop = async (
    historyValues: StateType,
    options: {
      onStop?: (options: {
        mutate: (
          update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
        ) => void;
      }) => void;
    }
  ): Promise<void> => {
    this.abortRef.abort();
    this.abortRef = new AbortController();

    options.onStop?.({ mutate: this.getMutateFn("stop", historyValues) });
  };

  clear = () => {
    // Cancel any running streams
    this.abortRef.abort();
    this.abortRef = new AbortController();

    // Set the stream state to null
    this.setState({ error: undefined, values: null, isLoading: false });

    // Clear any pending messages
    this.messages.clear();
  };
}
