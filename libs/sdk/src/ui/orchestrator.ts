import type { BaseMessage } from "@langchain/core/messages";

import { Client } from "../client.js";
import type { ThreadState, Interrupt } from "../schema.js";
import type { StreamMode } from "../types.stream.js";
import type { StreamEvent } from "../types.js";
import type { Message } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";
import { StreamManager, type EventStreamEvent } from "./manager.js";
import {
  MessageTupleManager,
  toMessageClass,
  ensureMessageInstances,
  ensureHistoryMessageInstances,
} from "./messages.js";
import { PendingRunsTracker } from "./queue.js";
import { getBranchContext, getMessagesMetadataMap } from "./branching.js";
import { StreamError } from "./errors.js";
import {
  extractInterrupts,
  userFacingInterruptsFromThreadTasks,
  userFacingInterruptsFromValuesArray,
} from "./interrupts.js";
import { unique, filterStream, onFinishRequiresThreadState } from "./utils.js";
import { getToolCallsWithResults } from "../utils/tools.js";
import { flushPendingHeadlessToolInterrupts } from "../headless-tools.js";
import type {
  UseStreamThread,
  AnyStreamOptions,
  SubmitOptions,
  RunCallbackMeta,
  MessageMetadata,
  GetUpdateType,
  GetCustomEventType,
  GetInterruptType,
  GetConfigurableType,
  SubagentStreamInterface,
} from "./types.js";

interface RunMetadataStorage {
  getItem(key: `lg:stream:${string}`): string | null;
  setItem(key: `lg:stream:${string}`, value: string): void;
  removeItem(key: `lg:stream:${string}`): void;
}

/**
 * Fetch the history of a thread.
 * @param client - The client to use.
 * @param threadId - The ID of the thread to fetch the history of.
 * @param options - The options to use.
 * @returns The history of the thread.
 */
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

/**
 * Resolve the run metadata storage.
 * @param reconnectOnMount - The reconnect on mount option.
 * @returns The run metadata storage.
 */
function resolveRunMetadataStorage(
  reconnectOnMount: boolean | (() => RunMetadataStorage) | undefined
): RunMetadataStorage | null {
  if (typeof globalThis.window === "undefined") return null;
  if (reconnectOnMount === true) return globalThis.window.sessionStorage;
  if (typeof reconnectOnMount === "function") return reconnectOnMount();
  return null;
}

/**
 * Resolve the callback stream modes.
 * @param options - The options to use.
 * @returns The callback stream modes.
 */
function resolveCallbackStreamModes<
  S extends Record<string, unknown>,
  B extends BagTemplate,
>(options: AnyStreamOptions<S, B>): StreamMode[] {
  const modes: StreamMode[] = [];
  if (options.onUpdateEvent) modes.push("updates");
  if (options.onCustomEvent) modes.push("custom");
  if (options.onCheckpointEvent) modes.push("checkpoints");
  if (options.onTaskEvent) modes.push("tasks");
  if ("onDebugEvent" in options && options.onDebugEvent) modes.push("debug");
  if ("onLangChainEvent" in options && options.onLangChainEvent)
    modes.push("events");
  return modes;
}

/**
 * Callbacks for resolving dynamic/reactive option values.
 * Framework adapters provide implementations that unwrap reactive primitives.
 */
export interface OrchestratorAccessors {
  getClient(): Client;
  getAssistantId(): string;
  getMessagesKey(): string;
}

/**
 * Framework-agnostic orchestrator for LangGraph Platform streams.
 *
 * Encapsulates all business logic shared across React, Vue, Svelte, and Angular:
 * thread management, history fetching, stream lifecycle, queue management,
 * branching, subagent management, and auto-reconnect.
 *
 * Framework adapters subscribe to state changes via {@link subscribe} and
 * map the orchestrator's getters to framework-specific reactive primitives.
 */
export class StreamOrchestrator<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> {
  readonly stream: StreamManager<StateType, Bag>;

  readonly messageManager: MessageTupleManager;

  readonly pendingRuns: PendingRunsTracker<
    StateType,
    SubmitOptions<StateType, GetConfigurableType<Bag>>
  >;

  readonly #options: AnyStreamOptions<StateType, Bag>;

  readonly #accessors: OrchestratorAccessors;

  readonly historyLimit: boolean | number;

  readonly #runMetadataStorage: RunMetadataStorage | null;

  readonly #callbackStreamModes: StreamMode[];

  readonly #trackedStreamModes: StreamMode[] = [];

  #threadId: string | undefined;

  #threadIdPromise: Promise<string> | null = null;

  #threadIdStreaming: string | null = null;

  #history: UseStreamThread<StateType>;

  #branch: string = "";

  #submitting = false;

  #listeners = new Set<() => void>();

  #version = 0;

  #streamUnsub: (() => void) | null = null;

  #queueUnsub: (() => void) | null = null;

  #disposed = false;

  #handledHeadlessToolInterruptIds = new Set<string>();

  /**
   * Create a new StreamOrchestrator.
   *
   * @param options - Configuration options for the stream, including callbacks,
   *   throttle settings, reconnect behaviour, and subagent filters.
   * @param accessors - Framework-specific accessors that resolve reactive
   *   primitives (client, assistant ID, messages key) at call time.
   */
  constructor(
    options: AnyStreamOptions<StateType, Bag>,
    accessors: OrchestratorAccessors
  ) {
    this.#options = options;
    this.#accessors = accessors;

    this.#runMetadataStorage = resolveRunMetadataStorage(
      options.reconnectOnMount
    );
    this.#callbackStreamModes = resolveCallbackStreamModes(options);

    this.historyLimit =
      typeof options.fetchStateHistory === "object" &&
      options.fetchStateHistory != null
        ? (options.fetchStateHistory.limit ?? false)
        : (options.fetchStateHistory ?? false);

    this.messageManager = new MessageTupleManager();
    this.stream = new StreamManager<StateType, Bag>(this.messageManager, {
      throttle: options.throttle ?? false,
      subagentToolNames: options.subagentToolNames,
      filterSubagentMessages: options.filterSubagentMessages,
      toMessage: options.toMessage ?? toMessageClass,
    });

    this.pendingRuns = new PendingRunsTracker<
      StateType,
      SubmitOptions<StateType, GetConfigurableType<Bag>>
    >();

    this.#threadId = undefined;
    this.#history = {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: this.#mutate,
    };

    this.#streamUnsub = this.stream.subscribe(() => {
      this.#flushPendingHeadlessToolInterrupts(
        this.stream.values as Record<string, unknown> | null
      );
      this.#notify();
    });

    this.#queueUnsub = this.pendingRuns.subscribe(() => {
      this.#notify();
    });
  }

  /**
   * Register a listener that is called whenever the orchestrator's internal
   * state changes (stream updates, queue changes, history mutations, etc.).
   *
   * @param listener - Callback invoked on every state change.
   * @returns An unsubscribe function that removes the listener.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Return the current version number, incremented on every state change.
   * Useful as a React `useSyncExternalStore` snapshot.
   *
   * @returns The current monotonically increasing version counter.
   */
  getSnapshot(): number {
    return this.#version;
  }

  /**
   * Increment the version counter and invoke all registered listeners.
   * No-op if the orchestrator has been disposed.
   */
  #notify(): void {
    if (this.#disposed) return;
    this.#version += 1;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  /**
   * The current thread ID, or `undefined` if no thread is active.
   */
  get threadId(): string | undefined {
    return this.#threadId;
  }

  /**
   * Update thread ID from an external source (e.g. reactive prop change).
   * Clears the current stream and triggers a history fetch.
   * @param newId - The new thread ID to set.
   * @returns The new thread ID.
   */
  setThreadId(newId: string | undefined): void {
    if (newId === this.#threadId) return;
    this.#threadId = newId;
    this.#handledHeadlessToolInterruptIds.clear();
    this.stream.clear();
    this.#fetchHistoryForThread(newId);
    this.#notify();
  }

  /**
   * Update the thread ID from within a submit flow. Sets both the
   * streaming and canonical thread IDs, fires the `onThreadId` callback,
   * and notifies listeners.
   *
   * @param newId - The newly created or resolved thread ID.
   */
  #setThreadIdFromSubmit(newId: string): void {
    this.#threadIdStreaming = newId;
    this.#threadId = newId;
    this.#handledHeadlessToolInterruptIds.clear();
    this.#options.onThreadId?.(newId);
    this.#notify();
  }

  #fetchHistoryForThread(threadId: string | undefined): void {
    if (
      this.#threadIdStreaming != null &&
      this.#threadIdStreaming === threadId
    ) {
      return;
    }

    if (threadId != null) {
      this.#history = {
        ...this.#history,
        isLoading: true,
        mutate: this.#mutate,
      };
      this.#notify();
      void this.#mutate(threadId);
    } else {
      this.#history = {
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: this.#mutate,
      };
      this.#notify();
    }
  }

  /**
   * The current thread history fetch state, including data, loading status,
   * error, and a {@link UseStreamThread.mutate | mutate} function to
   * manually re-fetch.
   */
  get historyData(): UseStreamThread<StateType> {
    return this.#history;
  }

  async #mutate(
    mutateId?: string
  ): Promise<ThreadState<StateType>[] | undefined> {
    const tid = mutateId ?? this.#threadId;
    if (!tid) return undefined;
    try {
      const data = await fetchHistory<StateType>(
        this.#accessors.getClient(),
        tid,
        { limit: this.historyLimit }
      );
      this.#history = {
        data,
        error: undefined,
        isLoading: false,
        mutate: this.#mutate,
      };
      this.#flushPendingHeadlessToolInterrupts(
        data?.at(0)?.values as Record<string, unknown> | null | undefined
      );
      this.#notify();
      return data;
    } catch (err) {
      this.#history = {
        ...this.#history,
        error: err,
        isLoading: false,
      };
      this.#notify();
      this.#options.onError?.(err, undefined);
      return undefined;
    }
  }

  /**
   * Trigger initial history fetch for the current thread ID.
   * Should be called once after construction when the initial threadId is known.
   */
  initThreadId(threadId: string | undefined): void {
    this.#threadId = threadId;
    this.#handledHeadlessToolInterruptIds.clear();
    this.#fetchHistoryForThread(threadId);
  }

  /**
   * The currently active branch identifier. An empty string represents
   * the main (default) branch.
   */
  get branch(): string {
    return this.#branch;
  }

  /**
   * Set the active branch and notify listeners if the value changed.
   *
   * @param value - The branch identifier to switch to.
   */
  setBranch(value: string): void {
    if (value === this.#branch) return;
    this.#branch = value;
    this.#notify();
  }

  /**
   * Derived branch context computed from the current branch and thread
   * history. Contains the thread head, branch tree, and checkpoint-to-branch
   * mapping for the active branch.
   */
  get branchContext() {
    return getBranchContext(this.#branch, this.#history.data ?? undefined);
  }

  #getMessages(value: StateType): Message[] {
    const messagesKey = this.#accessors.getMessagesKey();
    return Array.isArray(value[messagesKey]) ? value[messagesKey] : [];
  }

  #setMessages(current: StateType, messages: Message[]): StateType {
    const messagesKey = this.#accessors.getMessagesKey();
    return { ...current, [messagesKey]: messages };
  }

  /**
   * The state values from the thread head of the current branch history,
   * falling back to {@link AnyStreamOptions.initialValues | initialValues}
   * or an empty object.
   */
  get historyValues(): StateType {
    return (
      this.branchContext.threadHead?.values ??
      this.#options.initialValues ??
      ({} as StateType)
    );
  }

  /**
   * The error from the last task in the thread head, if any.
   * Attempts to parse structured {@link StreamError} instances from JSON.
   */
  get historyError(): unknown {
    const error = this.branchContext.threadHead?.tasks?.at(-1)?.error;
    if (error == null) return undefined;
    try {
      const parsed = JSON.parse(error) as unknown;
      if (StreamError.isStructuredError(parsed)) return new StreamError(parsed);
      return parsed;
    } catch {
      // do nothing
    }
    return error;
  }

  /**
   * The latest state values received from the active stream, or `null` if
   * no stream is running or no values have been received yet.
   */
  get streamValues(): StateType | null {
    return this.stream.values;
  }

  /**
   * The error from the active stream, if one occurred during streaming.
   */
  get streamError(): unknown {
    return this.stream.error;
  }

  /**
   * The merged state values, preferring live stream values over history.
   * This is the primary way to read the current thread state.
   */
  get values(): StateType {
    return this.stream.values ?? this.historyValues;
  }

  /**
   * The first available error from the stream, history, or thread fetch.
   * Returns `undefined` when no error is present.
   */
  get error(): unknown {
    return this.stream.error ?? this.historyError ?? this.#history.error;
  }

  /**
   * Whether the stream is currently active and receiving events.
   */
  get isLoading(): boolean {
    return this.stream.isLoading;
  }

  /**
   * The messages array extracted from the current {@link values} using the
   * configured messages key.
   */
  get messages(): Message[] {
    return this.#getMessages(this.values);
  }

  /**
   * The current messages converted to LangChain {@link BaseMessage} instances.
   * Automatically tracks the `"messages-tuple"` stream mode.
   */
  get messageInstances(): BaseMessage[] {
    this.trackStreamMode("messages-tuple");
    return ensureMessageInstances(this.messages) as BaseMessage[];
  }

  /**
   * All tool calls with their corresponding results extracted from
   * the current messages. Automatically tracks the `"messages-tuple"`
   * stream mode.
   */
  get toolCalls() {
    this.trackStreamMode("messages-tuple");
    return getToolCallsWithResults(this.#getMessages(this.values));
  }

  /**
   * Get tool calls with results for a specific AI message.
   * Automatically tracks the `"messages-tuple"` stream mode.
   *
   * @param message - The AI message to extract tool calls from.
   * @returns Tool calls whose AI message ID matches the given message.
   */
  getToolCalls(message: Message) {
    this.trackStreamMode("messages-tuple");
    const allToolCalls = getToolCallsWithResults(
      this.#getMessages(this.values)
    );
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  }

  /**
   * All active interrupts for the current thread state.
   * Returns an empty array when the stream is loading or no interrupts
   * are present. Falls back to a `{ when: "breakpoint" }` sentinel when
   * there are pending next nodes but no explicit interrupt data.
   */
  get interrupts(): Interrupt<GetInterruptType<Bag>>[] {
    const v = this.values;
    if (v != null && "__interrupt__" in v && Array.isArray(v.__interrupt__)) {
      return userFacingInterruptsFromValuesArray<GetInterruptType<Bag>>(
        v.__interrupt__ as Interrupt<GetInterruptType<Bag>>[]
      );
    }

    if (this.isLoading) return [];

    const allTasks = this.branchContext.threadHead?.tasks ?? [];
    const allInterrupts = allTasks.flatMap((t) => t.interrupts ?? []);

    const taskInterrupts = userFacingInterruptsFromThreadTasks<
      GetInterruptType<Bag>
    >(allInterrupts as Interrupt<GetInterruptType<Bag>>[]);
    if (taskInterrupts != null) return taskInterrupts;

    const next = this.branchContext.threadHead?.next ?? [];
    if (!next.length || this.error != null) return [];
    return [{ when: "breakpoint" }];
  }

  /**
   * The single most relevant interrupt for the current thread state,
   * or `undefined` if no interrupt is active. Convenience accessor that
   * delegates to {@link extractInterrupts}.
   */
  get interrupt(): Interrupt<GetInterruptType<Bag>> | undefined {
    return extractInterrupts<GetInterruptType<Bag>>(this.values, {
      isLoading: this.isLoading,
      threadState: this.branchContext.threadHead,
      error: this.error,
    });
  }

  /**
   * Flattened history messages as LangChain {@link BaseMessage} instances,
   * ordered chronologically across all branch checkpoints.
   *
   * @throws If `fetchStateHistory` was not enabled in the options.
   */
  get flatHistory() {
    if (this.historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `history`"
      );
    }
    return ensureHistoryMessageInstances(
      this.branchContext.flatHistory,
      this.#accessors.getMessagesKey()
    );
  }

  /**
   * Whether the initial thread history is still being loaded and no data
   * is available yet. Returns `false` once the first fetch completes.
   */
  get isThreadLoading(): boolean {
    return this.#history.isLoading && this.#history.data == null;
  }

  /**
   * The full branch tree structure for the current thread history.
   *
   * @experimental This API may change in future releases.
   * @throws If `fetchStateHistory` was not enabled in the options.
   */
  get experimental_branchTree() {
    if (this.historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `experimental_branchTree`"
      );
    }
    return this.branchContext.branchTree;
  }

  /**
   * A map of metadata entries for all messages, derived from history
   * and branch context. Used internally by {@link getMessagesMetadata}.
   */
  get messageMetadata() {
    return getMessagesMetadataMap({
      initialValues: this.#options.initialValues,
      history: this.#history.data,
      getMessages: (value: StateType) => this.#getMessages(value),
      branchContext: this.branchContext,
    });
  }

  /**
   * Look up metadata for a specific message, merging stream-time metadata
   * with history-derived metadata.
   *
   * @param message - The message to look up metadata for.
   * @param index - Optional positional index used as a fallback identifier.
   * @returns The merged metadata, or `undefined` if none is available.
   */
  getMessagesMetadata(
    message: Message,
    index?: number
  ): MessageMetadata<StateType> | undefined {
    const streamMetadata = this.messageManager.get(message.id)?.metadata;
    const historyMetadata = this.messageMetadata?.find(
      (m) => m.messageId === (message.id ?? index)
    );

    if (streamMetadata != null || historyMetadata != null) {
      return {
        ...historyMetadata,
        streamMetadata,
      } as MessageMetadata<StateType>;
    }

    return undefined;
  }

  /**
   * The list of pending run entries currently waiting in the queue.
   */
  get queueEntries() {
    return this.pendingRuns.entries;
  }

  /**
   * The number of pending runs in the queue.
   */
  get queueSize() {
    return this.pendingRuns.size;
  }

  /**
   * Cancel and remove a specific pending run from the queue.
   * If the run exists and a thread is active, the run is also cancelled
   * on the server.
   *
   * @param id - The run ID to cancel.
   * @returns `true` if the run was found and removed, `false` otherwise.
   */
  async cancelQueueItem(id: string): Promise<boolean> {
    const tid = this.#threadId;
    const removed = this.pendingRuns.remove(id);
    if (removed && tid) {
      await this.#accessors.getClient().runs.cancel(tid, id);
    }
    return removed;
  }

  /**
   * Remove all pending runs from the queue and cancel them on the server.
   */
  async clearQueue(): Promise<void> {
    const tid = this.#threadId;
    const removed = this.pendingRuns.removeAll();
    if (tid && removed.length > 0) {
      await Promise.all(
        removed.map((e) => this.#accessors.getClient().runs.cancel(tid, e.id))
      );
    }
  }

  /**
   * A map of all known subagent stream interfaces, keyed by tool call ID.
   */
  get subagents(): Map<string, SubagentStreamInterface> {
    return this.stream.getSubagents();
  }

  /**
   * The subset of subagents that are currently active (streaming).
   */
  get activeSubagents(): SubagentStreamInterface[] {
    return this.stream.getActiveSubagents();
  }

  /**
   * Retrieve a specific subagent stream interface by its tool call ID.
   *
   * @param toolCallId - The tool call ID that spawned the subagent.
   * @returns The subagent interface, or `undefined` if not found.
   */
  getSubagent(toolCallId: string) {
    return this.stream.getSubagent(toolCallId);
  }

  /**
   * Retrieve all subagent stream interfaces that match a given agent type.
   *
   * @param type - The agent type name to filter by.
   * @returns An array of matching subagent interfaces.
   */
  getSubagentsByType(type: string) {
    return this.stream.getSubagentsByType(type);
  }

  /**
   * Retrieve all subagent stream interfaces associated with a specific
   * AI message.
   *
   * @param messageId - The ID of the parent AI message.
   * @returns An array of subagent interfaces spawned by that message.
   */
  getSubagentsByMessage(messageId: string) {
    return this.stream.getSubagentsByMessage(messageId);
  }

  /**
   * Reconstruct subagents from history messages if applicable.
   * Call this when history finishes loading and the stream isn't active.
   * Returns an AbortController for cancelling the subagent history fetch,
   * or null if no reconstruction was needed.
   */
  reconstructSubagentsIfNeeded(): AbortController | null {
    const hvMessages = this.#getMessages(this.historyValues);
    const should =
      this.#options.filterSubagentMessages &&
      !this.isLoading &&
      !this.#history.isLoading &&
      hvMessages.length > 0;

    if (!should) return null;

    this.stream.reconstructSubagents(hvMessages, { skipIfPopulated: true });

    const tid = this.#threadId;
    if (tid) {
      const controller = new AbortController();
      void this.stream.fetchSubagentHistory(
        this.#accessors.getClient().threads,
        tid,
        {
          messagesKey: this.#accessors.getMessagesKey(),
          signal: controller.signal,
        }
      );
      return controller;
    }

    return null;
  }

  /**
   * Register additional stream modes that should be included in future
   * stream requests. Modes are deduplicated automatically.
   *
   * @param modes - One or more stream modes to track.
   */
  trackStreamMode(...modes: StreamMode[]): void {
    for (const mode of modes) {
      if (!this.#trackedStreamModes.includes(mode)) {
        this.#trackedStreamModes.push(mode);
      }
    }
  }

  /**
   * Stop the currently active stream. If reconnect metadata storage is
   * configured, also cancels the run on the server and cleans up stored
   * run metadata.
   */
  stop(): void {
    void this.stream.stop(this.historyValues, {
      onStop: (args) => {
        if (this.#runMetadataStorage && this.#threadId) {
          const runId = this.#runMetadataStorage.getItem(
            `lg:stream:${this.#threadId}`
          );
          if (runId) {
            void this.#accessors.getClient().runs.cancel(this.#threadId, runId);
          }
          this.#runMetadataStorage.removeItem(`lg:stream:${this.#threadId}`);
        }
        this.#options.onStop?.(args);
      },
    });
  }

  /**
   * Join an existing run's event stream by run ID. Used for reconnecting
   * to in-progress runs or consuming queued runs.
   *
   * @param runId - The ID of the run to join.
   * @param lastEventId - The last event ID received, for resuming mid-stream.
   *   Defaults to `"-1"` (start from the beginning).
   * @param joinOptions - Additional options for stream mode and event filtering.
   */
  async joinStream(
    runId: string,
    lastEventId?: string,
    joinOptions?: {
      streamMode?: StreamMode | StreamMode[];
      filter?: (event: {
        id?: string;
        event: StreamEvent;
        data: unknown;
      }) => boolean;
    }
  ): Promise<void> {
    type UpdateType = GetUpdateType<Bag, StateType>;
    type CustomType = GetCustomEventType<Bag>;

    // eslint-disable-next-line no-param-reassign
    lastEventId ??= "-1";
    const tid = this.#threadId;
    if (!tid) return;
    this.#threadIdStreaming = tid;

    const callbackMeta: RunCallbackMeta = {
      thread_id: tid,
      run_id: runId,
    };

    const includeImplicitBranch =
      this.historyLimit === true || typeof this.historyLimit === "number";
    const shouldRefetchJoin =
      includeImplicitBranch ||
      onFinishRequiresThreadState(this.#options.onFinish);

    const client = this.#accessors.getClient();

    await this.stream.start(
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
        getMessages: (value: StateType) => this.#getMessages(value),
        setMessages: (current: StateType, messages: Message[]) =>
          this.#setMessages(current, messages),
        initialValues: this.historyValues,
        callbacks: this.#options,
        onSuccess: async () => {
          this.#runMetadataStorage?.removeItem(`lg:stream:${tid}`);
          if (!shouldRefetchJoin) {
            if (
              this.#options.onFinish != null &&
              !onFinishRequiresThreadState(this.#options.onFinish)
            ) {
              this.#options.onFinish(
                undefined as unknown as ThreadState<StateType>,
                callbackMeta
              );
            }
            return;
          }
          const newHistory = await this.#mutate(tid);
          const lastHead = newHistory?.at(0);
          if (lastHead) this.#options.onFinish?.(lastHead, callbackMeta);
        },
        onError: (error) => {
          this.#options.onError?.(error, callbackMeta);
        },
        onFinish: () => {
          this.#threadIdStreaming = null;
        },
      }
    );
  }

  /**
   * Submit input values directly to the LangGraph Platform, creating a new
   * thread if necessary. Starts a streaming run and processes events until
   * completion. Unlike {@link submit}, this does not handle queueing — if
   * a stream is already active, a concurrent run will be started.
   *
   * @param values - The state values to send as run input.
   * @param submitOptions - Optional configuration for the run (config,
   *   checkpoint, multitask strategy, optimistic values, etc.).
   */
  submitDirect(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, GetConfigurableType<Bag>>
  ) {
    type UpdateType = GetUpdateType<Bag, StateType>;
    type CustomType = GetCustomEventType<Bag>;

    const currentBranchContext = this.branchContext;

    const checkpointId = submitOptions?.checkpoint?.checkpoint_id;
    this.#branch =
      checkpointId != null
        ? (currentBranchContext.branchByCheckpoint[checkpointId]?.branch ?? "")
        : "";

    const includeImplicitBranch =
      this.historyLimit === true || typeof this.historyLimit === "number";

    const shouldRefetch =
      includeImplicitBranch ||
      onFinishRequiresThreadState(this.#options.onFinish);

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

    const client = this.#accessors.getClient();
    const assistantId = this.#accessors.getAssistantId();

    return this.stream.start(
      async (signal) => {
        usableThreadId = this.#threadId;
        if (usableThreadId) {
          this.#threadIdStreaming = usableThreadId;
        }
        if (!usableThreadId) {
          const threadPromise = client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          this.#threadIdPromise = threadPromise.then((t) => t.thread_id);

          const thread = await threadPromise;

          usableThreadId = thread.thread_id;
          this.#setThreadIdFromSubmit(usableThreadId);
        }

        const streamMode = unique([
          "values" as StreamMode,
          "updates" as StreamMode,
          ...(submitOptions?.streamMode ?? []),
          ...this.#trackedStreamModes,
          ...this.#callbackStreamModes,
        ]);

        this.stream.setStreamValues(() => {
          const prev = { ...this.historyValues, ...this.stream.values };

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
          submitOptions?.streamResumable ?? !!this.#runMetadataStorage;

        return client.runs.stream(usableThreadId!, assistantId, {
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
          onRunCreated: (params) => {
            callbackMeta = {
              run_id: params.run_id,
              thread_id: params.thread_id ?? usableThreadId!,
            };

            if (this.#runMetadataStorage) {
              rejoinKey = `lg:stream:${usableThreadId}`;
              this.#runMetadataStorage.setItem(rejoinKey, callbackMeta.run_id);
            }

            this.#options.onCreated?.(callbackMeta);
          },
        }) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;
      },
      {
        getMessages: (value: StateType) => this.#getMessages(value),
        setMessages: (current: StateType, messages: Message[]) =>
          this.#setMessages(current, messages),
        initialValues: this.historyValues,
        callbacks: this.#options,

        onSuccess: async () => {
          if (rejoinKey) this.#runMetadataStorage?.removeItem(rejoinKey);

          if (shouldRefetch && usableThreadId) {
            const newHistory = await this.#mutate(usableThreadId);
            const lastHead = newHistory?.at(0);
            if (lastHead) {
              this.#options.onFinish?.(lastHead, callbackMeta);
              return null;
            }
          } else if (
            this.#options.onFinish != null &&
            !onFinishRequiresThreadState(this.#options.onFinish)
          ) {
            this.#options.onFinish(
              undefined as unknown as ThreadState<StateType>,
              callbackMeta
            );
          }
          return undefined;
        },
        onError: (error) => {
          this.#options.onError?.(error, callbackMeta);
          submitOptions?.onError?.(error, callbackMeta);
        },
        onFinish: () => {
          this.#threadIdStreaming = null;
        },
      }
    );
  }

  #drainQueue(): void {
    if (!this.isLoading && !this.#submitting && this.pendingRuns.size > 0) {
      const next = this.pendingRuns.shift();
      if (next) {
        this.#submitting = true;
        void this.joinStream(next.id).finally(() => {
          this.#submitting = false;
          this.#drainQueue();
        });
      }
    }
  }

  /**
   * Trigger queue draining. Framework adapters should call this
   * when isLoading or queue size changes.
   */
  drainQueue(): void {
    this.#drainQueue();
  }

  /**
   * Submit input values with automatic queue management. If a stream is
   * already active, the run is enqueued (unless the multitask strategy
   * is `"interrupt"` or `"rollback"`, in which case the current run is
   * replaced). Queued runs are drained sequentially via {@link drainQueue}.
   *
   * @param values - The state values to send as run input.
   * @param submitOptions - Optional configuration for the run.
   * @returns The result of {@link submitDirect} if the run was started
   *   immediately, or `void` if the run was enqueued.
   */
  async submit(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, GetConfigurableType<Bag>>
  ): Promise<ReturnType<typeof this.submitDirect> | void> {
    if (this.stream.isLoading || this.#submitting) {
      const shouldAbort =
        submitOptions?.multitaskStrategy === "interrupt" ||
        submitOptions?.multitaskStrategy === "rollback";

      if (shouldAbort) {
        this.#submitting = true;
        try {
          await this.submitDirect(values, submitOptions);
        } finally {
          this.#submitting = false;
        }
        return;
      }

      let usableThreadId: string | undefined = this.#threadId;
      if (!usableThreadId && this.#threadIdPromise) {
        usableThreadId = await this.#threadIdPromise;
      }
      if (usableThreadId) {
        const client = this.#accessors.getClient();
        const assistantId = this.#accessors.getAssistantId();
        try {
          const run = await client.runs.create(usableThreadId, assistantId, {
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
          });

          this.pendingRuns.add({
            id: run.run_id,
            values: values as Partial<StateType> | null | undefined,
            options: submitOptions,
            createdAt: new Date(run.created_at),
          });
        } catch (error) {
          this.#options.onError?.(error, undefined);
          submitOptions?.onError?.(error, undefined);
        }
        return;
      }
    }

    this.#submitting = true;
    const result = this.submitDirect(values, submitOptions);
    void Promise.resolve(result).finally(() => {
      this.#submitting = false;
      this.#drainQueue();
    });
    return result;
  }

  /**
   * Switch to a different thread (or clear the current thread).
   * Clears the active stream, cancels all queued runs on the previous
   * thread, fetches history for the new thread, and notifies the
   * {@link AnyStreamOptions.onThreadId | onThreadId} callback.
   *
   * @param newThreadId - The thread ID to switch to, or `null` to clear.
   */
  switchThread(newThreadId: string | null): void {
    const current = this.#threadId ?? null;
    if (newThreadId !== current) {
      const prevThreadId = this.#threadId;
      this.#threadId = newThreadId ?? undefined;
      this.#handledHeadlessToolInterruptIds.clear();
      this.stream.clear();

      const removed = this.pendingRuns.removeAll();
      if (prevThreadId && removed.length > 0) {
        const client = this.#accessors.getClient();
        void Promise.all(
          removed.map((e) => client.runs.cancel(prevThreadId, e.id))
        );
      }

      this.#fetchHistoryForThread(this.#threadId);

      if (newThreadId != null) {
        this.#options.onThreadId?.(newThreadId);
      }

      this.#notify();
    }
  }

  /**
   * Attempt to reconnect to a previously running stream.
   * Returns true if a reconnection was initiated.
   */
  tryReconnect(): boolean {
    if (this.#runMetadataStorage && this.#threadId) {
      const runId = this.#runMetadataStorage.getItem(
        `lg:stream:${this.#threadId}`
      );
      if (runId) {
        void this.joinStream(runId);
        return true;
      }
    }
    return false;
  }

  /**
   * Whether reconnect-on-mount behaviour is enabled (i.e. run metadata
   * storage is available).
   */
  get shouldReconnect(): boolean {
    return !!this.#runMetadataStorage;
  }

  /**
   * Tear down the orchestrator: stop the active stream, remove all
   * internal subscriptions, and mark the instance as disposed.
   * After calling this method, the orchestrator should not be reused.
   */
  dispose(): void {
    this.#disposed = true;
    this.#streamUnsub?.();
    this.#queueUnsub?.();
    this.#streamUnsub = null;
    this.#queueUnsub = null;
    void this.stop();
  }

  #flushPendingHeadlessToolInterrupts(
    values: Record<string, unknown> | null | undefined
  ): void {
    flushPendingHeadlessToolInterrupts(
      values,
      this.#options.tools,
      this.#handledHeadlessToolInterruptIds,
      {
        onTool: this.#options.onTool,
        defer: (run) => {
          void Promise.resolve().then(run);
        },
        resumeSubmit: (command) =>
          void this.submit(null as unknown as StateType, {
            multitaskStrategy: "interrupt",
            command,
          }),
      }
    );
  }
}
