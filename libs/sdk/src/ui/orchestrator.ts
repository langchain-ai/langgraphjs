import type { BaseMessage } from "@langchain/core/messages";

import { Client } from "../client.js";
import type { ThreadState, Interrupt } from "../schema.js";
import type { StreamMode } from "../types.stream.js";
import type { StreamEvent } from "../types.js";
import type { Message } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";
import {
  StreamManager,
  type EventStreamEvent,
} from "./manager.js";
import { MessageTupleManager, toMessageClass } from "./messages.js";
import { PendingRunsTracker } from "./queue.js";
import { getBranchContext, getMessagesMetadataMap } from "./branching.js";
import { StreamError } from "./errors.js";
import { extractInterrupts } from "./interrupts.js";
import { unique, filterStream } from "./utils.js";
import { getToolCallsWithResults } from "../utils/tools.js";
import { ensureMessageInstances, ensureHistoryMessageInstances } from "./messages.js";
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

function fetchHistory<StateType extends Record<string, unknown>>(
  client: Client,
  threadId: string,
  options?: { limit?: boolean | number },
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

function resolveRunMetadataStorage(
  reconnectOnMount:
    | boolean
    | (() => RunMetadataStorage)
    | undefined,
): RunMetadataStorage | null {
  if (typeof globalThis.window === "undefined") return null;
  if (reconnectOnMount === true) return globalThis.window.sessionStorage;
  if (typeof reconnectOnMount === "function") return reconnectOnMount();
  return null;
}

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
  // --- Type aliases for internal use ---
  private declare _updateType: GetUpdateType<Bag, StateType>;
  private declare _customType: GetCustomEventType<Bag>;
  private declare _interruptType: GetInterruptType<Bag>;
  private declare _configurableType: GetConfigurableType<Bag>;

  // --- Managers ---
  readonly stream: StreamManager<StateType, Bag>;
  readonly messageManager: MessageTupleManager;
  readonly pendingRuns: PendingRunsTracker<
    StateType,
    SubmitOptions<StateType, GetConfigurableType<Bag>>
  >;

  // --- Internal state ---
  private _threadId: string | undefined;
  private _threadIdPromise: Promise<string> | null = null;
  private _threadIdStreaming: string | null = null;
  private _history: UseStreamThread<StateType>;
  private _branch: string = "";
  private _submitting = false;

  // --- Config ---
  private readonly options: AnyStreamOptions<StateType, Bag>;
  private readonly accessors: OrchestratorAccessors;
  readonly historyLimit: boolean | number;
  private readonly runMetadataStorage: RunMetadataStorage | null;
  private readonly callbackStreamModes: StreamMode[];
  private readonly trackedStreamModes: StreamMode[] = [];

  // --- Subscription ---
  private listeners = new Set<() => void>();
  private _version = 0;
  private _streamUnsub: (() => void) | null = null;
  private _queueUnsub: (() => void) | null = null;
  private _disposed = false;

  constructor(
    options: AnyStreamOptions<StateType, Bag>,
    accessors: OrchestratorAccessors,
  ) {
    this.options = options;
    this.accessors = accessors;

    this.runMetadataStorage = resolveRunMetadataStorage(
      options.reconnectOnMount,
    );
    this.callbackStreamModes = resolveCallbackStreamModes(options);

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

    this._threadId = undefined;
    this._history = {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: this._mutate,
    };

    this._streamUnsub = this.stream.subscribe(() => {
      this._notify();
    });

    this._queueUnsub = this.pendingRuns.subscribe(() => {
      this._notify();
    });
  }

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): number => this._version;

  private _notify(): void {
    if (this._disposed) return;
    this._version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  // ---------------------------------------------------------------------------
  // Thread ID management
  // ---------------------------------------------------------------------------

  get threadId(): string | undefined {
    return this._threadId;
  }

  /**
   * Update thread ID from an external source (e.g. reactive prop change).
   * Clears the current stream and triggers a history fetch.
   */
  setThreadId(newId: string | undefined): void {
    if (newId === this._threadId) return;
    this._threadId = newId;
    this.stream.clear();
    this._fetchHistoryForThread(newId);
    this._notify();
  }

  /**
   * Internal thread ID update when a new thread is created during submit.
   * Does NOT clear the stream (we're mid-stream).
   */
  private _setThreadIdFromSubmit(newId: string): void {
    this._threadIdStreaming = newId;
    this._threadId = newId;
    this.options.onThreadId?.(newId);
    this._notify();
  }

  private _fetchHistoryForThread(threadId: string | undefined): void {
    if (
      this._threadIdStreaming != null &&
      this._threadIdStreaming === threadId
    ) {
      return;
    }

    if (threadId != null) {
      this._history = { ...this._history, isLoading: true, mutate: this._mutate };
      this._notify();
      void this._mutate(threadId);
    } else {
      this._history = {
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: this._mutate,
      };
      this._notify();
    }
  }

  // ---------------------------------------------------------------------------
  // History management
  // ---------------------------------------------------------------------------

  get historyData(): UseStreamThread<StateType> {
    return this._history;
  }

  private _mutate = async (
    mutateId?: string,
  ): Promise<ThreadState<StateType>[] | undefined> => {
    const tid = mutateId ?? this._threadId;
    if (!tid) return undefined;
    try {
      const data = await fetchHistory<StateType>(
        this.accessors.getClient(),
        tid,
        { limit: this.historyLimit },
      );
      this._history = {
        data,
        error: undefined,
        isLoading: false,
        mutate: this._mutate,
      };
      this._notify();
      return data;
    } catch (err) {
      this._history = {
        ...this._history,
        error: err,
        isLoading: false,
      };
      this._notify();
      this.options.onError?.(err, undefined);
      return undefined;
    }
  };

  /**
   * Trigger initial history fetch for the current thread ID.
   * Should be called once after construction when the initial threadId is known.
   */
  initThreadId(threadId: string | undefined): void {
    this._threadId = threadId;
    this._fetchHistoryForThread(threadId);
  }

  // ---------------------------------------------------------------------------
  // Branch management
  // ---------------------------------------------------------------------------

  get branch(): string {
    return this._branch;
  }

  setBranch = (value: string): void => {
    if (value === this._branch) return;
    this._branch = value;
    this._notify();
  };

  get branchContext() {
    return getBranchContext(this._branch, this._history.data ?? undefined);
  }

  // ---------------------------------------------------------------------------
  // Computed values
  // ---------------------------------------------------------------------------

  private _getMessages = (value: StateType): Message[] => {
    const messagesKey = this.accessors.getMessagesKey();
    return Array.isArray(value[messagesKey]) ? value[messagesKey] : [];
  };

  private _setMessages = (
    current: StateType,
    messages: Message[],
  ): StateType => {
    const messagesKey = this.accessors.getMessagesKey();
    return { ...current, [messagesKey]: messages };
  };

  get historyValues(): StateType {
    return (
      this.branchContext.threadHead?.values ??
      this.options.initialValues ??
      ({} as StateType)
    );
  }

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

  get streamValues(): StateType | null {
    return this.stream.values;
  }

  get streamError(): unknown {
    return this.stream.error;
  }

  get values(): StateType {
    return this.stream.values ?? this.historyValues;
  }

  get error(): unknown {
    return this.stream.error ?? this.historyError ?? this._history.error;
  }

  get isLoading(): boolean {
    return this.stream.isLoading;
  }

  get messages(): Message[] {
    return this._getMessages(this.values);
  }

  get messageInstances(): BaseMessage[] {
    this.trackStreamMode("messages-tuple");
    return ensureMessageInstances(this.messages) as BaseMessage[];
  }

  get toolCalls() {
    this.trackStreamMode("messages-tuple");
    return getToolCallsWithResults(this._getMessages(this.values));
  }

  getToolCalls = (message: Message) => {
    this.trackStreamMode("messages-tuple");
    const allToolCalls = getToolCallsWithResults(
      this._getMessages(this.values),
    );
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  };

  get interrupts(): Interrupt<GetInterruptType<Bag>>[] {
    const v = this.values;
    if (v != null && "__interrupt__" in v && Array.isArray(v.__interrupt__)) {
      const valueInterrupts = v.__interrupt__;
      if (valueInterrupts.length === 0) return [{ when: "breakpoint" }];
      return valueInterrupts;
    }

    if (this.isLoading) return [];

    const allTasks = this.branchContext.threadHead?.tasks ?? [];
    const allInterrupts = allTasks.flatMap((t) => t.interrupts ?? []);

    if (allInterrupts.length > 0) {
      return allInterrupts as Interrupt<GetInterruptType<Bag>>[];
    }

    const next = this.branchContext.threadHead?.next ?? [];
    if (!next.length || this.error != null) return [];
    return [{ when: "breakpoint" }];
  }

  get interrupt(): Interrupt<GetInterruptType<Bag>> | undefined {
    return extractInterrupts<GetInterruptType<Bag>>(this.values, {
      isLoading: this.isLoading,
      threadState: this.branchContext.threadHead,
      error: this.error,
    });
  }

  get flatHistory() {
    if (this.historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `history`",
      );
    }
    return ensureHistoryMessageInstances(
      this.branchContext.flatHistory,
      this.accessors.getMessagesKey(),
    );
  }

  get isThreadLoading(): boolean {
    return this._history.isLoading && this._history.data == null;
  }

  get experimental_branchTree() {
    if (this.historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `experimental_branchTree`",
      );
    }
    return this.branchContext.branchTree;
  }

  get messageMetadata() {
    return getMessagesMetadataMap({
      initialValues: this.options.initialValues,
      history: this._history.data,
      getMessages: this._getMessages,
      branchContext: this.branchContext,
    });
  }

  getMessagesMetadata = (
    message: Message,
    index?: number,
  ): MessageMetadata<StateType> | undefined => {
    const streamMetadata = this.messageManager.get(message.id)?.metadata;
    const historyMetadata = this.messageMetadata?.find(
      (m) => m.messageId === (message.id ?? index),
    );

    if (streamMetadata != null || historyMetadata != null) {
      return {
        ...historyMetadata,
        streamMetadata,
      } as MessageMetadata<StateType>;
    }

    return undefined;
  };

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------

  get queueEntries() {
    return this.pendingRuns.entries;
  }

  get queueSize() {
    return this.pendingRuns.size;
  }

  cancelQueueItem = async (id: string): Promise<boolean> => {
    const tid = this._threadId;
    const removed = this.pendingRuns.remove(id);
    if (removed && tid) {
      await this.accessors.getClient().runs.cancel(tid, id);
    }
    return removed;
  };

  clearQueue = async (): Promise<void> => {
    const tid = this._threadId;
    const removed = this.pendingRuns.removeAll();
    if (tid && removed.length > 0) {
      await Promise.all(
        removed.map((e) => this.accessors.getClient().runs.cancel(tid, e.id)),
      );
    }
  };

  // ---------------------------------------------------------------------------
  // Subagents
  // ---------------------------------------------------------------------------

  get subagents(): Map<string, SubagentStreamInterface> {
    return this.stream.getSubagents();
  }

  get activeSubagents(): SubagentStreamInterface[] {
    return this.stream.getActiveSubagents();
  }

  getSubagent = (toolCallId: string) => {
    return this.stream.getSubagent(toolCallId);
  };

  getSubagentsByType = (type: string) => {
    return this.stream.getSubagentsByType(type);
  };

  getSubagentsByMessage = (messageId: string) => {
    return this.stream.getSubagentsByMessage(messageId);
  };

  /**
   * Reconstruct subagents from history messages if applicable.
   * Call this when history finishes loading and the stream isn't active.
   * Returns an AbortController for cancelling the subagent history fetch,
   * or null if no reconstruction was needed.
   */
  reconstructSubagentsIfNeeded(): AbortController | null {
    const hvMessages = this._getMessages(this.historyValues);
    const should =
      this.options.filterSubagentMessages &&
      !this.isLoading &&
      !this._history.isLoading &&
      hvMessages.length > 0;

    if (!should) return null;

    this.stream.reconstructSubagents(hvMessages, { skipIfPopulated: true });

    const tid = this._threadId;
    if (tid) {
      const controller = new AbortController();
      void this.stream.fetchSubagentHistory(
        this.accessors.getClient().threads,
        tid,
        {
          messagesKey: this.accessors.getMessagesKey(),
          signal: controller.signal,
        },
      );
      return controller;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Stream mode tracking
  // ---------------------------------------------------------------------------

  trackStreamMode = (...modes: StreamMode[]): void => {
    for (const mode of modes) {
      if (!this.trackedStreamModes.includes(mode)) {
        this.trackedStreamModes.push(mode);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Stop
  // ---------------------------------------------------------------------------

  stop = (): void => {
    this.stream.stop(this.historyValues, {
      onStop: (args) => {
        if (this.runMetadataStorage && this._threadId) {
          const runId = this.runMetadataStorage.getItem(
            `lg:stream:${this._threadId}`,
          );
          if (runId) {
            void this.accessors
              .getClient()
              .runs.cancel(this._threadId, runId);
          }
          this.runMetadataStorage.removeItem(
            `lg:stream:${this._threadId}`,
          );
        }
        this.options.onStop?.(args);
      },
    });
  };

  // ---------------------------------------------------------------------------
  // Join stream
  // ---------------------------------------------------------------------------

  joinStream = async (
    runId: string,
    lastEventId?: string,
    joinOptions?: {
      streamMode?: StreamMode | StreamMode[];
      filter?: (event: {
        id?: string;
        event: StreamEvent;
        data: unknown;
      }) => boolean;
    },
  ): Promise<void> => {
    type UpdateType = GetUpdateType<Bag, StateType>;
    type CustomType = GetCustomEventType<Bag>;

    // eslint-disable-next-line no-param-reassign
    lastEventId ??= "-1";
    const tid = this._threadId;
    if (!tid) return;
    this._threadIdStreaming = tid;

    const callbackMeta: RunCallbackMeta = {
      thread_id: tid,
      run_id: runId,
    };

    const client = this.accessors.getClient();

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
        getMessages: this._getMessages,
        setMessages: this._setMessages,
        initialValues: this.historyValues,
        callbacks: this.options,
        onSuccess: async () => {
          this.runMetadataStorage?.removeItem(`lg:stream:${tid}`);
          const newHistory = await this._mutate(tid);
          const lastHead = newHistory?.at(0);
          if (lastHead) this.options.onFinish?.(lastHead, callbackMeta);
        },
        onError: (error) => {
          this.options.onError?.(error, callbackMeta);
        },
        onFinish: () => {
          this._threadIdStreaming = null;
        },
      },
    );
  };

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  submitDirect = (
    values: StateType,
    submitOptions?: SubmitOptions<StateType, GetConfigurableType<Bag>>,
  ) => {
    type UpdateType = GetUpdateType<Bag, StateType>;
    type CustomType = GetCustomEventType<Bag>;

    const currentBranchContext = this.branchContext;

    const checkpointId = submitOptions?.checkpoint?.checkpoint_id;
    this._branch =
      checkpointId != null
        ? (currentBranchContext.branchByCheckpoint[checkpointId]?.branch ?? "")
        : "";

    const includeImplicitBranch =
      this.historyLimit === true || typeof this.historyLimit === "number";

    const shouldRefetch =
      this.options.onFinish != null || includeImplicitBranch;

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

    const client = this.accessors.getClient();
    const assistantId = this.accessors.getAssistantId();

    return this.stream.start(
      async (signal) => {
        usableThreadId = this._threadId;
        if (usableThreadId) {
          this._threadIdStreaming = usableThreadId;
        }
        if (!usableThreadId) {
          const threadPromise = client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          this._threadIdPromise = threadPromise.then((t) => t.thread_id);

          const thread = await threadPromise;

          usableThreadId = thread.thread_id;
          this._setThreadIdFromSubmit(usableThreadId);
        }

        const streamMode = unique([
          "values" as StreamMode,
          "updates" as StreamMode,
          ...(submitOptions?.streamMode ?? []),
          ...this.trackedStreamModes,
          ...this.callbackStreamModes,
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
          submitOptions?.streamResumable ?? !!this.runMetadataStorage;

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

            if (this.runMetadataStorage) {
              rejoinKey = `lg:stream:${usableThreadId}`;
              this.runMetadataStorage.setItem(rejoinKey, callbackMeta.run_id);
            }

            this.options.onCreated?.(callbackMeta);
          },
        }) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;
      },
      {
        getMessages: this._getMessages,
        setMessages: this._setMessages,
        initialValues: this.historyValues,
        callbacks: this.options,

        onSuccess: async () => {
          if (rejoinKey) this.runMetadataStorage?.removeItem(rejoinKey);

          if (shouldRefetch && usableThreadId) {
            const newHistory = await this._mutate(usableThreadId);
            const lastHead = newHistory?.at(0);
            if (lastHead) {
              this.options.onFinish?.(lastHead, callbackMeta);
              return null;
            }
          }
          return undefined;
        },
        onError: (error) => {
          this.options.onError?.(error, callbackMeta);
          submitOptions?.onError?.(error, callbackMeta);
        },
        onFinish: () => {
          this._threadIdStreaming = null;
        },
      },
    );
  };

  private _drainQueue = (): void => {
    if (!this.isLoading && !this._submitting && this.pendingRuns.size > 0) {
      const next = this.pendingRuns.shift();
      if (next) {
        this._submitting = true;
        void this.joinStream(next.id).finally(() => {
          this._submitting = false;
          this._drainQueue();
        });
      }
    }
  };

  /**
   * Trigger queue draining. Framework adapters should call this
   * when isLoading or queue size changes.
   */
  drainQueue = (): void => {
    this._drainQueue();
  };

  submit = async (
    values: StateType,
    submitOptions?: SubmitOptions<StateType, GetConfigurableType<Bag>>,
  ): Promise<ReturnType<typeof this.submitDirect> | void> => {
    if (this.stream.isLoading || this._submitting) {
      const shouldAbort =
        submitOptions?.multitaskStrategy === "interrupt" ||
        submitOptions?.multitaskStrategy === "rollback";

      if (shouldAbort) {
        this._submitting = true;
        try {
          await this.submitDirect(values, submitOptions);
        } finally {
          this._submitting = false;
        }
        return;
      }

      let usableThreadId: string | undefined = this._threadId;
      if (!usableThreadId && this._threadIdPromise) {
        usableThreadId = await this._threadIdPromise;
      }
      if (usableThreadId) {
        const client = this.accessors.getClient();
        const assistantId = this.accessors.getAssistantId();
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
          this.options.onError?.(error, undefined);
          submitOptions?.onError?.(error, undefined);
        }
        return;
      }
    }

    this._submitting = true;
    const result = this.submitDirect(values, submitOptions);
    void Promise.resolve(result).finally(() => {
      this._submitting = false;
      this._drainQueue();
    });
    return result;
  };

  // ---------------------------------------------------------------------------
  // Switch thread
  // ---------------------------------------------------------------------------

  switchThread = (newThreadId: string | null): void => {
    const current = this._threadId ?? null;
    if (newThreadId !== current) {
      const prevThreadId = this._threadId;
      this._threadId = newThreadId ?? undefined;
      this.stream.clear();

      const removed = this.pendingRuns.removeAll();
      if (prevThreadId && removed.length > 0) {
        const client = this.accessors.getClient();
        void Promise.all(
          removed.map((e) => client.runs.cancel(prevThreadId, e.id)),
        );
      }

      this._fetchHistoryForThread(this._threadId);

      if (newThreadId != null) {
        this.options.onThreadId?.(newThreadId);
      }

      this._notify();
    }
  };

  // ---------------------------------------------------------------------------
  // Auto-reconnect
  // ---------------------------------------------------------------------------

  /**
   * Attempt to reconnect to a previously running stream.
   * Returns true if a reconnection was initiated.
   */
  tryReconnect = (): boolean => {
    if (this.runMetadataStorage && this._threadId) {
      const runId = this.runMetadataStorage.getItem(
        `lg:stream:${this._threadId}`,
      );
      if (runId) {
        void this.joinStream(runId);
        return true;
      }
    }
    return false;
  };

  get shouldReconnect(): boolean {
    return !!this.runMetadataStorage;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  dispose = (): void => {
    this._disposed = true;
    this._streamUnsub?.();
    this._queueUnsub?.();
    this._streamUnsub = null;
    this._queueUnsub = null;
    void this.stop();
  };
}
