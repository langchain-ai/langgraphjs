import type { BaseMessage } from "@langchain/core/messages";

import { DEFAULT_MESSAGES_KEY } from "./constants.js";
import {
  DISCOVERY_HISTORY_SELECT,
  mapSubagentNamespaces,
} from "./namespace-from-history.js";
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
  ToolsStreamEvent,
  UpdatesStreamEvent,
  ValuesStreamEvent,
} from "../types.stream.js";
import { MessageTupleManager, toMessageDict } from "./messages.js";
import { StreamError } from "./errors.js";
import type { Message } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";
import type { ThreadStateSelectField } from "../schema.js";
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

const TOOL_EVENT_KINDS = new Set<string>([
  "on_tool_start",
  "on_tool_event",
  "on_tool_end",
  "on_tool_error",
]);

type GetUpdateType<
  Bag extends BagTemplate,
  StateType extends Record<string, unknown>,
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
  tools: ToolsStreamEvent;
};

export type EventStreamEvent<StateType, UpdateType, CustomType> =
  EventStreamMap<StateType, UpdateType, CustomType>[keyof EventStreamMap<
    StateType,
    UpdateType,
    CustomType
  >];

interface StreamManagerEventCallbacks<
  StateType extends Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
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
  onToolEvent?: (
    data: ToolsStreamEvent["data"],
    options: {
      namespace: string[] | undefined;
      mutate: (
        update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
      ) => void;
    }
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
   * Subagent messages stream as they are generated only when the run streams
   * subgraphs, so submit with `streamSubgraphs: true`. Without it, a subagent
   * shows only its final result.
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
   * stream.submit(input, { streamSubgraphs: true });
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
  Bag extends BagTemplate = BagTemplate,
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

  #epoch = 0;

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
   * Fetch and restore internal messages for reconstructed subagents from their
   * subgraph checkpoints. Should be called after `reconstructSubagents` to
   * restore the full subagent conversation after a page refresh.
   *
   * Subagent messages are persisted in the LangGraph checkpointer under a
   * subgraph-specific `checkpoint_ns` (e.g. `tools:<uuid>`). This method
   * matches each subagent tool call to its namespace from one page of the
   * main thread's history, requested with `select: ["checkpoint", "tasks"]`:
   * by the ToolMessage a finished Send task wrote, else by the Send index
   * (`task.path[1]`) into the tool calls that were still unanswered when the
   * Sends went out. It shares this matching with `useStream` from
   * `@langchain/react`, and needs no deepagents-specific metadata.
   *
   * @param threads - Client with a `getHistory` method (e.g. `client.threads`)
   * @param threadId - The parent thread ID
   * @param options - Optional configuration
   * @param options.messagesKey - Key in state values containing messages (default: "messages")
   * @param options.signal - AbortSignal to cancel in-flight requests on effect cleanup
   */
  async fetchSubagentHistory(
    threads: {
      getHistory<V extends Record<string, unknown>>(
        threadId: string,
        options?: {
          limit?: number;
          checkpoint?: { checkpoint_ns?: string };
          select?: ThreadStateSelectField[];
          signal?: AbortSignal;
        }
      ): Promise<
        Array<{
          /** Absent from the discovery page, which selects no `values`. */
          values?: V;
          tasks?: Array<{
            id: string;
            name: string;
            path?: unknown[];
            result?: unknown;
            checkpoint?: { checkpoint_ns?: string } | null;
          }>;
        }>
      >;
    },
    threadId: string,
    options?: {
      messagesKey?: string;
      historyLimit?: number;
      signal?: AbortSignal;
    }
  ): Promise<void> {
    const messagesKey = options?.messagesKey ?? DEFAULT_MESSAGES_KEY;
    const signal = options?.signal;

    /**
     * Bail immediately if already cancelled (React Strict Mode cleanup)
     */
    if (signal?.aborted) {
      return;
    }

    /**
     * Only fetch for subagents that have no messages (reconstructed from history)
     */
    const toFetch = [...this.subagentManager.getSubagents().entries()].filter(
      ([, s]) => s.messages.length === 0
    );

    /**
     * Bail immediately if there are no subagents to fetch
     */
    if (toFetch.length === 0) {
      return;
    }

    /**
     * Step 1: Match each subagent tool call to its subagent namespace from
     * one discovery page of root-thread history. Only `checkpoint` and
     * `tasks` are requested: matching never reads `values`.
     */
    let toolCallIdToNamespace = new Map<string, string>();

    try {
      const mainHistory = await threads.getHistory<Record<string, unknown>>(
        threadId,
        {
          limit: options?.historyLimit ?? 20,
          select: DISCOVERY_HISTORY_SELECT,
          signal,
        }
      );
      toolCallIdToNamespace = mapSubagentNamespaces(
        mainHistory,
        toFetch.map(([id]) => id),
        {
          messagesKey,
          isSubagentToolCall: (name) =>
            this.subagentManager.isSubagentToolCall(name),
        }
      );
    } catch {
      /**
       * Non-fatal: fall back to subagent.namespace below
       */
    }

    /**
     * Step 2: Fetch each subagent's conversation from its subgraph checkpoint
     */
    await Promise.all(
      toFetch.map(async ([toolCallId, subagent]) => {
        /**
         * Priority order for the subgraph checkpoint_ns:
         *   1. Derived from main thread's intermediate task list (preferred, no coupling)
         *   2. Already on the subagent's namespace (e.g. populated during streaming)
         *   3. Skip — we cannot reliably identify the namespace
         */
        const checkpointNs =
          toolCallIdToNamespace.get(toolCallId) ??
          (subagent.namespace.length > 0
            ? subagent.namespace.join("|")
            : undefined);

        if (!checkpointNs) return;

        try {
          const history = await threads.getHistory<Record<string, unknown>>(
            threadId,
            {
              checkpoint: { checkpoint_ns: checkpointNs },
              limit: 1,
              signal,
            }
          );

          /**
           * If the HTTP request was cancelled mid-flight the getHistory call
           * would have thrown an AbortError (caught below). If we reach here the
           * fetch completed successfully, so always process the result.
           */
          const latestState = history[0];
          if (!latestState?.values) return;

          const messages = latestState.values[messagesKey];
          if (!Array.isArray(messages) || messages.length === 0) return;

          /**
           * Normalize messages: promote tool_calls from additional_kwargs to top
           * level when the checkpointer serialized them in the legacy format.
           */
          const normalizedMessages = messages.map((msg) => {
            const m = msg as Record<string, unknown>;
            if (
              m.type === "ai" &&
              (!m.tool_calls || (m.tool_calls as unknown[]).length === 0)
            ) {
              const ak = m.additional_kwargs as
                | Record<string, unknown>
                | undefined;
              const legacy = ak?.tool_calls;
              if (Array.isArray(legacy) && legacy.length > 0) {
                return { ...m, tool_calls: legacy };
              }
            }
            return m;
          });

          this.subagentManager.updateSubagentFromSubgraphState(
            toolCallId,
            normalizedMessages as Message[],
            latestState.values
          );
        } catch {
          /**
           * Ignore AbortError and other transient errors
           */
        }
      })
    );
  }

  /**
   * Check if any subagents are currently tracked.
   */
  hasSubagents(): boolean {
    return this.subagentManager.hasSubagents();
  }

  /** See `SubagentManager.hasOpenSubagents`. */
  hasOpenSubagents(): boolean {
    return this.subagentManager.hasOpenSubagents();
  }

  /** See `SubagentManager.bindNamespace`. */
  bindSubagentNamespace(toolCallId: string, namespace: string[]): void {
    this.subagentManager.bindNamespace(toolCallId, namespace);
  }

  /** See `SubagentManager.closeOpenSubagents`. */
  closeOpenSubagents(error: string): void {
    this.subagentManager.closeOpenSubagents(error);
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
      if (timeoutId !== undefined) return;
      timeoutId = setTimeout(() => {
        timeoutId = undefined;
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

  /**
   * Bumped when a stream begins (not when it is queued) and on `clear()`, so
   * a read that resolves after either is stale.
   */
  get epoch() {
    return this.#epoch;
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
      // Publish any pending re-parse first, so it can't later overwrite this
      // update
      this.messages.flush();

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
    >,
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

      /**
       * Called when the stream ends without an error or an abort. Return the
       * values to show, `null` to clear the stream values so the history
       * values show instead, or `undefined` to keep the stream's values. The
       * result is ignored while another stream is queued.
       */
      onSuccess: () =>
        | StateType
        | null
        | undefined
        | void
        | Promise<StateType | null | undefined | void>;

      onError: (error: unknown) => void | Promise<void>;

      onFinish?: () => void;

      /** The stream replays the run from its first event. */
      isReplaying?: boolean;

      /** Called with each event, before it is applied. */
      onEvent?: (event: string, data: unknown) => void;
    }
  ) => {
    try {
      this.queueSize = Math.max(0, this.queueSize - 1);
      this.#epoch += 1;
      this.setState({ isLoading: true, error: undefined });
      // clear() and stop() replace abortRef, so the run keeps its own.
      const abort = new AbortController();
      this.abortRef = abort;
      if (options.isReplaying) {
        this.messages.startReplay();
        this.subagentManager.startReplay();
      }

      const run = await action(abort.signal);
      let clearedPreviousInterrupts = false;
      // A run sends `metadata` once per attempt, so one after other events
      // starts a new attempt: what the cut one streamed since its last root
      // `values` goes, and messages it sends again start over.
      let attemptValues = this.values;
      let sawEvent = false;

      // Subagent messages kept in the main stream (`filterSubagentMessages` off)
      const subagentMessageIds = new Set<string>();

      const applyMessage = (messageId: string, { updateOnly = false } = {}) => {
        const isFromSubagent = subagentMessageIds.has(messageId);

        this.setStreamValues((streamValues) => {
          const values = {
            ...options.initialValues,
            ...streamValues,
          };

          // Assumption: we're concatenating the message
          let messages = options.getMessages(values).slice();
          const chunk = this.messages.get(messageId)?.chunk;
          if (!chunk) return values;

          // Placed by id, since later events can move or remove a message and
          // a join from a checkpoint resends ones the loaded state holds. The
          // search starts at the end, where a streamed message usually is.
          let index = messages.length - 1;
          while (index >= 0 && messages[index].id !== messageId) index -= 1;

          if (chunk.getType() === "remove") {
            // Check for special REMOVE_ALL_MESSAGES sentinel
            if (chunk.id === REMOVE_ALL_MESSAGES) {
              // Clear all messages when __remove_all__ is received
              messages = [];
            } else if (index !== -1) {
              messages.splice(index, 1);
            }
          } else {
            // A refresh never brings back a message removed since.
            if (index === -1 && updateOnly) return values;
            const msgDict = this.toMessage(chunk) as Message;
            messages[index === -1 ? messages.length : index] = msgDict;

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
      };

      // Re-publish messages whose tool calls were re-parsed on the timer
      this.messages.onRefresh = (ids) =>
        ids.forEach((id) => applyMessage(id, { updateOnly: true }));

      let streamError: StreamError | undefined;
      // A stop ends the wait for the first event at once, also when the
      // request stays open to learn the run's id.
      const events = run[Symbol.asyncIterator]();
      const stopped = new Promise<undefined>((resolve) => {
        if (abort.signal.aborted) resolve(undefined);
        else abort.signal.addEventListener("abort", () => resolve(undefined));
      });
      for (
        let result = await Promise.race([events.next(), stopped]);
        result !== undefined && !result.done;
        result = await events.next()
      ) {
        const { event, data } = result.value;
        options.onEvent?.(event, data);
        if (event === "error") {
          streamError = new StreamError(data);
          break;
        }

        if (event === "metadata" && sawEvent) {
          this.messages.startReplay();
          this.subagentManager.startReplay();
          this.setStreamValues(attemptValues);
          this.subagentManager.dropPendingOutside(
            new Set(
              options
                .getMessages(attemptValues ?? options.initialValues)
                .flatMap((message) => message.id ?? [])
            )
          );
        }
        sawEvent = true;

        const namespace = event.includes("|")
          ? event.split("|").slice(1)
          : undefined;

        const mutate = this.getMutateFn("stream", options.initialValues);

        if (event === "metadata") options.callbacks.onMetadataEvent?.(data);
        if (event === "events") options.callbacks.onLangChainEvent?.(data);
        if (event.startsWith("lifecycle|")) {
          this.subagentManager.applyLifecycle(data);
        }

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

        // Older queue workers forward langgraph's own `tool-*` payloads.
        if (
          this.matchEventType("tools", event, data) &&
          TOOL_EVENT_KINDS.has(data?.event)
        ) {
          options.callbacks.onToolEvent?.(data, { namespace, mutate });
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
          } else if (namespace == null) {
            // Publish any pending re-parse first, so it can't later overwrite
            // the messages in these values
            this.messages.flush();

            if (!clearedPreviousInterrupts) {
              // Clear stale __interrupt__ from the previous run once the new
              // stream starts delivering main values. This avoids carrying
              // resumed interrupts forward while still preserving the previous
              // interrupt state if the new stream fails before any values
              // arrive.
              this.setStreamValues((prev) => {
                if (prev && "__interrupt__" in prev) {
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  const { __interrupt__, ...rest } = prev;
                  return rest as StateType;
                }
                return prev;
              });
              clearedPreviousInterrupts = true;
            }

            if (data && typeof data === "object" && "__interrupt__" in data) {
              // When parallel branches each raise an interrupt, the backend
              // may stream separate values events per branch. We accumulate
              // the __interrupt__ arrays so none are lost, but still honor an
              // explicit empty array as "clear interrupts".
              const interruptData = data as Partial<StateType> & {
                __interrupt__?: Array<{ id?: string }>;
              };
              this.setStreamValues((prev) => {
                const prevInterrupts = (
                  prev as
                    | (StateType & { __interrupt__?: Array<{ id?: string }> })
                    | null
                )?.__interrupt__;

                let interrupts = interruptData.__interrupt__;
                if (Array.isArray(interrupts)) {
                  if (interrupts.length === 0) {
                    interrupts = [];
                  } else if (Array.isArray(prevInterrupts)) {
                    const mergedInterrupts = [...prevInterrupts];
                    const existingIds = new Set(
                      prevInterrupts.map((i) => i.id).filter((id) => id != null)
                    );
                    for (const interrupt of interrupts) {
                      if (interrupt.id != null) {
                        if (existingIds.has(interrupt.id)) continue;
                        existingIds.add(interrupt.id);
                      }
                      mergedInterrupts.push(interrupt);
                    }
                    interrupts = mergedInterrupts;
                  }
                }

                return {
                  ...prev,
                  __interrupt__: interrupts,
                } as unknown as StateType;
              });
            } else {
              // Non-interrupt values events must not wipe accumulated
              // __interrupt__ state. Preserve it when the incoming data
              // does not carry its own __interrupt__ field.
              this.setStreamValues((prev) => {
                if (
                  prev &&
                  "__interrupt__" in prev &&
                  Array.isArray((prev as Record<string, unknown>).__interrupt__)
                ) {
                  return {
                    ...(data as StateType),
                    __interrupt__: (prev as Record<string, unknown>)
                      .__interrupt__,
                  } as StateType;
                }
                return data as StateType;
              });
            }
            attemptValues = this.values;
          }
        }

        if (this.matchEventType("messages", event, data)) {
          const [serialized, metadata] = data;

          // Check if this message is from a subagent namespace
          const eventCheckpointNs =
            namespace && isSubagentNamespace(namespace) ? namespace : undefined;
          const rawCheckpointNs =
            (metadata?.langgraph_checkpoint_ns as string | undefined) ||
            (metadata?.checkpoint_ns as string | undefined);
          const checkpointNs: string[] | undefined =
            eventCheckpointNs ??
            (typeof rawCheckpointNs === "string"
              ? rawCheckpointNs.split("|")
              : undefined);
          const isFromSubagent = isSubagentNamespace(checkpointNs);
          const toolCallId = isFromSubagent
            ? extractToolCallIdFromNamespace(checkpointNs)
            : undefined;

          // If filtering is enabled and this is a subagent message,
          // add it to the subagent's messages instead of the main stream
          if (this.filterSubagentMessages && isFromSubagent && toolCallId) {
            // deepagents names the subagent's `task` call on its tokens, and
            // on those of every graph that runs inside it, so it names a
            // top-level subagent, whose namespace ends at the first `tools:`.
            const taskCallId = metadata?.lc_subagent_tool_call_id;
            if (
              typeof taskCallId === "string" &&
              checkpointNs != null &&
              this.subagentManager.hasSubagent(taskCallId)
            ) {
              this.subagentManager.bindNamespace(
                taskCallId,
                checkpointNs.slice(
                  0,
                  checkpointNs.findIndex((s) => s.startsWith("tools:")) + 1
                )
              );
            }
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

          if (isFromSubagent) subagentMessageIds.add(messageId);
          applyMessage(messageId);
        }
      }
      void events.return?.(undefined)?.catch(() => undefined);

      this.messages.flush();
      if (streamError != null) throw streamError;

      // Skip onSuccess when the stream was aborted (e.g., by multitask interrupt).
      // This avoids unnecessary HTTP calls (like history fetching) that would
      // delay the next queued stream from starting.
      if (!abort.signal.aborted) {
        const values = await options.onSuccess?.();
        if (typeof values !== "undefined" && this.queueSize === 0) {
          this.setStreamValues(values);
        }
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
      // Publish any pending refresh for this run (e.g. after an abort), then
      // detach so it can't publish into a later run's state
      this.messages.flush();
      this.messages.onRefresh = undefined;
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

      /**
       * Called when the stream ends without an error or an abort. Return the
       * values to show, `null` to clear the stream values so the history
       * values show instead, or `undefined` to keep the stream's values. The
       * result is ignored while another stream is queued.
       */
      onSuccess: () =>
        | StateType
        | null
        | undefined
        | void
        | Promise<StateType | null | undefined | void>;

      onError: (error: unknown) => void | Promise<void>;

      onFinish?: () => void;

      /** The stream replays the run from its first event. */
      isReplaying?: boolean;

      /** Called with each event, before it is applied. */
      onEvent?: (event: string, data: unknown) => void;
    },
    startOptions?: {
      /**
       * If true, abort any currently running stream before starting this one.
       * Used for multitask_strategy: "interrupt" and "rollback" to unblock
       * the queue so the new run request can proceed immediately.
       */
      abortPrevious?: boolean;
    }
  ): Promise<void> => {
    if (startOptions?.abortPrevious) {
      this.abortRef.abort();
    }
    this.queueSize += 1;
    const queued = this.queue.then(() => this.enqueue(action, options));
    this.queue = queued;
    await queued;
  };

  stop = async (
    historyValues: StateType,
    options: {
      onStop?: (options: {
        mutate: (
          update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)
        ) => void;
      }) => void;
      /**
       * Reads what the server kept after the stop cut a stream off. Resolve
       * to its head's values to show them, `null` to clear the stream values
       * so the history values show, or `undefined` to keep the stopped
       * stream's values, as a rejection does. `onStop`'s updates are applied
       * again on top, and the result is dropped if a stream began or
       * `clear()` ran in the meantime.
       */
      read?: () => Promise<StateType | null | undefined>;
    }
  ): Promise<void> => {
    const wasLoading = this.isLoading;
    const epoch = this.#epoch;
    this.abortRef.abort();
    this.abortRef = new AbortController();

    const updates: Array<
      Partial<StateType> | ((prev: StateType) => Partial<StateType>)
    > = [];
    const mutate = this.getMutateFn("stop", historyValues);
    options.onStop?.({
      mutate: (update) => {
        updates.push(update);
        mutate(update);
      },
    });

    if (!wasLoading || options.read == null) return;
    let head: StateType | null | undefined;
    try {
      head = await options.read();
    } catch {
      return;
    }
    if (head === undefined || this.#epoch !== epoch) return;
    // Without a head the history takes over. Null keeps it live; only
    // onStop's updates need a copy of it to sit on.
    this.setStreamValues(
      head == null && updates.length === 0
        ? null
        : updates.reduce<StateType>(
            (prev, update) => ({
              ...prev,
              ...(typeof update === "function" ? update(prev) : update),
            }),
            head ?? historyValues
          )
    );
  };

  clear = () => {
    this.#epoch += 1;

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
