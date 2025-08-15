import type { ThreadState } from "../schema.js";
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

export type EventStreamEvent<StateType, UpdateType, CustomType> = EventStreamMap<
  StateType,
  UpdateType,
  CustomType
>[keyof EventStreamMap<StateType, UpdateType, CustomType>];

export interface StreamManagerContext<
  StateType extends Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  messagesKey: string;
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
  onFinish?: (
    state: ThreadState<StateType>,
    callbackMeta: { thread_id: string; run_id: string } | undefined
  ) => void;
  onError?: (
    error: unknown,
    callbackMeta: { thread_id: string; run_id: string } | undefined
  ) => void;
  onStop?: (options: {
    mutate: (
      update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
    ) => void;
  }) => void;
}

export class StreamManager<
  StateType extends Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  private abortRef = new AbortController();

  private messageManager = new MessageTupleManager();

  private listeners = new Set<() => void>();

  private state: {
    isLoading: boolean;
    values: [values: StateType, kind: "stream" | "stop"] | null;
    error: unknown;
  };

  constructor() {
    this.state = { isLoading: false, values: null, error: undefined };
  }

  private setState = (newState: Partial<typeof this.state>) => {
    this.state = { ...this.state, ...newState };
    this.notifyListeners();
  };

  private notifyListeners = () => {
    this.listeners.forEach((listener) => listener());
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  getMessageMetadata = (messageId: string | null | undefined) => {
    return messageId != null
      ? this.messageManager.get(messageId)?.metadata
      : undefined;
  };

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
      const prev = { ...historyValues, ...this.state.values };
      const next = typeof update === "function" ? update(prev) : update;
      this.setStreamValues({ ...prev, ...next }, kind);
    };
  };

  private getMessages = (
    values: StateType,
    options: StreamManagerContext<StateType, Bag>
  ): Message[] => {
    const messagesKey = options.messagesKey ?? "messages";
    return Array.isArray(values[messagesKey])
      ? (values[messagesKey] as Message[])
      : [];
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
    data: EventStreamEvent<
      StateType,
      GetUpdateType<Bag, StateType>,
      GetCustomEventType<Bag>
    >["data"]
  ): data is EventStreamMap<
    StateType,
    GetUpdateType<Bag, StateType>,
    GetCustomEventType<Bag>
  >[T]["data"] => {
    return expected === actual || actual.startsWith(`${expected}|`);
  };

  start = async (
    action: (signal: AbortSignal) => Promise<{
      stream: AsyncGenerator<
        EventStreamEvent<
          StateType,
          GetUpdateType<Bag, StateType>,
          GetCustomEventType<Bag>
        >
      >;
      onSuccess: () => Promise<ThreadState<StateType>[]>;
      getCallbackMeta: () => { thread_id: string; run_id: string } | undefined;
    }>,
    historyValues: StateType,
    options: StreamManagerContext<StateType, Bag>
  ) => {
    if (this.state.isLoading) return;

    let getCallbackMeta:
      | (() => { thread_id: string; run_id: string } | undefined)
      | undefined;

    try {
      this.setState({ isLoading: true, error: undefined });
      this.abortRef = new AbortController();

      const run = await action(this.abortRef.signal);
      getCallbackMeta = run.getCallbackMeta;

      let streamError: StreamError | undefined;
      for await (const { event, data } of run.stream) {
        if (event === "error") {
          streamError = new StreamError(data);
          break;
        }

        const namespace = event.includes("|")
          ? event.split("|").slice(1)
          : undefined;

        const mutate = this.getMutateFn("stream", historyValues);

        if (event === "metadata") options.onMetadataEvent?.(data);
        if (event === "events") options.onLangChainEvent?.(data);

        if (this.matchEventType("updates", event, data)) {
          options.onUpdateEvent?.(data, { namespace, mutate });
        }

        if (this.matchEventType("custom", event, data)) {
          options.onCustomEvent?.(data, { namespace, mutate });
        }

        if (this.matchEventType("checkpoints", event, data)) {
          options.onCheckpointEvent?.(data, { namespace });
        }

        if (this.matchEventType("tasks", event, data)) {
          options.onTaskEvent?.(data, { namespace });
        }

        if (this.matchEventType("debug", event, data)) {
          options.onDebugEvent?.(data, { namespace });
        }

        if (event === "values") {
          // don't update values on interrupt values event
          if ("__interrupt__" in data) continue;
          this.setStreamValues(data);
        }

        if (this.matchEventType("messages", event, data)) {
          const [serialized, metadata] = data;

          const messageId = this.messageManager.add(serialized, metadata);
          if (!messageId) {
            console.warn(
              "Failed to add message to manager, no message ID found"
            );
            continue;
          }

          this.setStreamValues((streamValues) => {
            const values = { ...historyValues, ...streamValues };

            // Assumption: we're concatenating the message
            const messages = this.getMessages(values, options).slice();
            const { chunk, index } =
              this.messageManager.get(messageId, messages.length) ?? {};

            if (!chunk || index == null) return values;
            messages[index] = toMessageDict(chunk);

            const messagesKey = options.messagesKey ?? "messages";
            return { ...values, [messagesKey]: messages };
          });
        }
      }

      // TODO: stream created checkpoints to avoid an unnecessary network request
      const result = await run.onSuccess();
      this.setStreamValues((values, kind) => {
        // Do not clear out the user values set on `stop`.
        if (kind === "stop") return values;
        return null;
      });

      if (streamError != null) throw streamError;

      const lastHead = result.at(0);
      if (lastHead) options.onFinish?.(lastHead, getCallbackMeta?.());
    } catch (error) {
      if (
        !(
          error instanceof Error && // eslint-disable-line no-instanceof/no-instanceof
          (error.name === "AbortError" || error.name === "TimeoutError")
        )
      ) {
        console.error(error);
        this.setState({ error });
        options.onError?.(error, getCallbackMeta?.());
      }
    } finally {
      this.setState({ isLoading: false });
      this.abortRef = new AbortController();
    }
  };

  stop = async (
    historyValues: StateType,
    options: StreamManagerContext<StateType, Bag>
  ) => {
    if (this.abortRef) {
      this.abortRef.abort();
      this.abortRef = new AbortController();
    }

    options.onStop?.({ mutate: this.getMutateFn("stop", historyValues) });
  };

  clear = () => {
    this.setState({ error: undefined, values: null });
    this.messageManager.clear();
  };
}
