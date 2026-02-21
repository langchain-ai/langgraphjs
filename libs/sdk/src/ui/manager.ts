import type { BaseMessage } from "@langchain/core/messages";

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
import {
  SubagentManager,
  extractToolCallIdFromNamespace,
  isSubagentNamespace,
} from "./subagents.js";
import type { SubagentStreamInterface } from "./types.js";

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

/**
 * Options for StreamManager constructor.
 */
export interface StreamManagerOptions {
  /**
   * Throttle the stream updates.
   * If a number is provided, updates are throttled to the given milliseconds.
   * If `true`, updates are batched in a single macrotask.
   * If `false`, updates are not throttled.
   */
  throttle: number | boolean;

  /**
   * Tool names that indicate subagent invocation.
   *
   * When an AI message contains tool calls with these names, they are
   * automatically tracked as subagent executions. This enables the
   * `subagents`, `activeSubagents`, `getSubagent()`, and `getSubagentsByType()`
   * properties on the stream.
   *
   * @default ["task"]
   *
   * @example
   * ```typescript
   * // Track both "task" and "delegate" as subagent tools
   * subagentToolNames: ["task", "delegate", "spawn_agent"]
   * ```
   */
  subagentToolNames?: string[];

  /**
   * Filter out messages from subagent streams in the main messages array.
   *
   * When enabled, messages from subagraph executions (those with a `tools:` namespace)
   * are excluded from `stream.messages`. Instead, these messages are tracked
   * per-subagent and accessible via `stream.subagents.get(id).messages`.
   *
   * This is useful for deep agent architectures where you want to display
   * the main conversation separately from subagent activity.
   *
   * @default false
   *
   * @example
   * ```typescript
   * const stream = useStream({
   *   assistantId: "my-agent",
   *   filterSubagentMessages: true,
   * });
   *
   * // Main thread messages only (no subagent messages)
   * stream.messages
   *
   * // Access subagent messages individually
   * stream.subagents.get("call_xyz").messages
   * ```
   */
  filterSubagentMessages?: boolean;

  /**
   * Converts a @langchain/core BaseMessage to the desired output format.
   *
   * Defaults to `toMessageDict` which produces plain Message objects.
   * Framework SDKs pass `toMessageClass` (identity) to keep class instances.
   */
  toMessage?: (chunk: BaseMessage) => Message | BaseMessage;
}

export class StreamManager<
  StateType extends Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  private abortRef = new AbortController();

  private messages: MessageTupleManager;

  private subagentManager: SubagentManager;

  private listeners = new Set<() => void>();

  private throttle: number | boolean;

  private filterSubagentMessages: boolean;

  private toMessage: (chunk: BaseMessage) => Message | BaseMessage;

  private queue: Promise<unknown> = Promise.resolve();

  private queueSize: number = 0;

  private state: {
    isLoading: boolean;
    values: [values: StateType, kind: "stream" | "stop"] | null;
    error: unknown;
    /** Version counter to force React re-renders on subagent changes */
    version: number;
  };

  constructor(messages: MessageTupleManager, options: StreamManagerOptions) {
    this.messages = messages;
    this.state = {
      isLoading: false,
      values: null,
      error: undefined,
      version: 0,
    };
    this.throttle = options.throttle;
    this.filterSubagentMessages = options.filterSubagentMessages ?? false;
    this.toMessage = options.toMessage ?? toMessageDict;
    this.subagentManager = new SubagentManager({
      subagentToolNames: options.subagentToolNames,
      onSubagentChange: () => this.bumpVersion(),
      toMessage: this.toMessage,
    });
  }

  /**
   * Increment version counter to trigger React re-renders.
   * Called when subagent state changes.
   */
  private bumpVersion = () => {
    this.state = { ...this.state, version: this.state.version + 1 };
    this.notifyListeners();
  };

  /**
   * Get all subagents as a Map.
   */
  getSubagents(): Map<string, SubagentStreamInterface> {
    return this.subagentManager.getSubagents();
  }

  /**
   * Get all currently running subagents.
   */
  getActiveSubagents(): SubagentStreamInterface[] {
    return this.subagentManager.getActiveSubagents();
  }

  /**
   * Get a specific subagent by tool call ID.
   */
  getSubagent(toolCallId: string): SubagentStreamInterface | undefined {
    return this.subagentManager.getSubagent(toolCallId);
  }

  /**
   * Get all subagents of a specific type.
   */
  getSubagentsByType(type: string): SubagentStreamInterface[] {
    return this.subagentManager.getSubagentsByType(type);
  }

  /**
   * Get all subagents triggered by a specific AI message.
   */
  getSubagentsByMessage(messageId: string): SubagentStreamInterface[] {
    return this.subagentManager.getSubagentsByMessage(messageId);
  }

  /**
   * Reconstruct subagent state from historical messages.
   *
   * This method should be called when loading thread history to restore
   * subagent visualization after:
   * - Page refresh (when stream has already completed)
   * - Loading thread history
   * - Navigating between threads
   *
   * @param messages - Array of messages from thread history
   * @param options - Optional configuration
   * @param options.skipIfPopulated - If true, skip reconstruction if subagents already exist
   */
  reconstructSubagents(
    messages: Message[],
    options?: { skipIfPopulated?: boolean }
  ): void {
    this.subagentManager.reconstructFromMessages(messages, options);
  }

  /**
   * Check if any subagents are currently tracked.
   */
  hasSubagents(): boolean {
    return this.subagentManager.hasSubagents();
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
        ...stateValues,
      };
      const next = typeof update === "function" ? update(prev) : update;
      this.setStreamValues({ ...prev, ...next }, kind);
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

          // Track subagent streaming updates from subgraph namespaces
          // Mark the subagent as running when we receive updates
          // The actual message content is handled via addMessageToSubagent
          if (namespace && isSubagentNamespace(namespace)) {
            const namespaceId = extractToolCallIdFromNamespace(namespace);
            if (namespaceId && this.filterSubagentMessages) {
              this.subagentManager.markRunningFromNamespace(
                namespaceId,
                namespace
              );
            }
          }

          // Also register subagents from main agent updates (tool_calls in messages)
          // AND process tool results to complete subagents
          // This is needed because tool_calls often appear complete in updates
          // before they appear in the messages stream
          if (!namespace || !isSubagentNamespace(namespace)) {
            const updateData = data as Record<string, unknown>;
            for (const nodeData of Object.values(updateData)) {
              if (
                nodeData &&
                typeof nodeData === "object" &&
                "messages" in nodeData
              ) {
                const { messages } = nodeData as { messages: unknown[] };
                if (Array.isArray(messages)) {
                  for (const msg of messages) {
                    if (!msg || typeof msg !== "object") continue;
                    const msgObj = msg as Record<string, unknown>;

                    // Register subagents from AI messages with tool_calls
                    if (
                      msgObj.type === "ai" &&
                      "tool_calls" in msgObj &&
                      Array.isArray(msgObj.tool_calls)
                    ) {
                      this.subagentManager.registerFromToolCalls(
                        msgObj.tool_calls as Array<{
                          id?: string;
                          name: string;
                          args: Record<string, unknown> | string;
                        }>,
                        msgObj.id as string | undefined
                      );
                    }

                    // Complete subagents from tool messages (task results)
                    if (
                      msgObj.type === "tool" &&
                      "tool_call_id" in msgObj &&
                      typeof msgObj.tool_call_id === "string"
                    ) {
                      const content =
                        typeof msgObj.content === "string"
                          ? msgObj.content
                          : JSON.stringify(msgObj.content);
                      const status =
                        "status" in msgObj && msgObj.status === "error"
                          ? "error"
                          : "success";
                      this.subagentManager.processToolMessage(
                        msgObj.tool_call_id,
                        content,
                        status
                      );
                    }
                  }
                }
              }
            }
          }
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

        // Handle values events - use startsWith to match both "values" and "values|tools:xxx"
        if (event === "values" || event.startsWith("values|")) {
          // Check if this is a subgraph values event (for namespace mapping and values)
          if (namespace && isSubagentNamespace(namespace)) {
            const namespaceId = extractToolCallIdFromNamespace(namespace);
            if (namespaceId && this.filterSubagentMessages) {
              const valuesData = data as Record<string, unknown>;

              // Try to establish namespace mapping from the initial human message
              const messages = valuesData.messages as unknown[];
              if (Array.isArray(messages) && messages.length > 0) {
                const firstMsg = messages[0] as Record<string, unknown>;
                if (
                  firstMsg?.type === "human" &&
                  typeof firstMsg?.content === "string"
                ) {
                  this.subagentManager.matchSubgraphToSubagent(
                    namespaceId,
                    firstMsg.content
                  );
                }
              }

              // Update the subagent's values with the full state
              this.subagentManager.updateSubagentValues(
                namespaceId,
                valuesData
              );
            }
          } else if (
            data &&
            typeof data === "object" &&
            "__interrupt__" in data
          ) {
            const interruptData = data as Partial<StateType>;
            this.setStreamValues(
              (prev) => ({ ...prev, ...interruptData } as StateType)
            );
          } else {
            this.setStreamValues(data as StateType);
          }
        }

        if (this.matchEventType("messages", event, data)) {
          const [serialized, metadata] = data;

          // Check if this message is from a subagent namespace
          const rawCheckpointNs =
            (metadata?.langgraph_checkpoint_ns as string | undefined) ||
            (metadata?.checkpoint_ns as string | undefined);
          const checkpointNs: string | undefined =
            typeof rawCheckpointNs === "string" ? rawCheckpointNs : undefined;
          const isFromSubagent = isSubagentNamespace(checkpointNs);
          const toolCallId = isFromSubagent
            ? extractToolCallIdFromNamespace(checkpointNs?.split("|"))
            : undefined;

          // If filtering is enabled and this is a subagent message,
          // add it to the subagent's messages instead of the main stream
          if (this.filterSubagentMessages && isFromSubagent && toolCallId) {
            // Add to subagent's message list
            this.subagentManager.addMessageToSubagent(
              toolCallId,
              serialized,
              metadata
            );
            continue;
          }

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
              ...streamValues,
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
              const msgDict = this.toMessage(chunk) as Message;
              messages[index] = msgDict;

              // Track subagents from AI messages with tool calls (main agent only)
              if (
                !isFromSubagent &&
                msgDict.type === "ai" &&
                "tool_calls" in msgDict &&
                Array.isArray(msgDict.tool_calls)
              ) {
                this.subagentManager.registerFromToolCalls(
                  msgDict.tool_calls,
                  msgDict.id as string | undefined
                );
              }

              // Complete subagents when tool messages arrive (main agent only)
              if (
                !isFromSubagent &&
                msgDict.type === "tool" &&
                "tool_call_id" in msgDict
              ) {
                const tcId = msgDict.tool_call_id as string;
                const content =
                  typeof msgDict.content === "string"
                    ? msgDict.content
                    : JSON.stringify(msgDict.content);
                const status =
                  "status" in msgDict && msgDict.status === "error"
                    ? "error"
                    : "success";
                this.subagentManager.processToolMessage(tcId, content, status);
              }
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

    // Clear subagent state
    this.subagentManager.clear();
  };
}
