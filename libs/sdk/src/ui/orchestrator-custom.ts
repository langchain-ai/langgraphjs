import type { BaseMessage } from "@langchain/core/messages";
import { v7 as uuidv7 } from "@langchain/core/utils/uuid";

import { DEFAULT_MESSAGES_KEY } from "./constants.js";
import type { ThreadState, Interrupt } from "../schema.js";
import type { StreamMode } from "../types.stream.js";
import type { Message } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";
import { StreamManager, type EventStreamEvent } from "./manager.js";
import { ChannelListeners, type ChannelEvent } from "./channels.js";
import {
  MessageTupleManager,
  toMessageClass,
  ensureMessageInstances,
} from "./messages.js";
import {
  resumeCommand,
  userFacingInterruptsFromValuesArray,
  valuesInterrupts,
} from "./interrupts.js";
import type { MessageMetadataMap } from "./message-metadata-tracker.js";
import { prepareSubmitInput, runStartValues } from "./optimistic-input.js";
import type { StreamEngine } from "./engine.js";
import type { RespondOptions, RunEndReason } from "./orchestrator.js";
import { PendingRunsTracker } from "./queue.js";
import type { Scope, ScopeSnapshot } from "./scoped.js";
import { StreamStore } from "./store.js";
import { getToolCallsWithResults } from "../utils/tools.js";
import { flushPendingHeadlessToolInterrupts } from "../headless-tools.js";
import type {
  AnyStreamCustomOptions,
  CustomSubmitOptions,
  MessageMetadata,
  GetUpdateType,
  GetCustomEventType,
  GetInterruptType,
  GetConfigurableType,
  SubagentStreamInterface,
} from "./types.js";

const EMPTY_SCOPE_SNAPSHOT: ScopeSnapshot = { messages: [], values: undefined };

const EMPTY_SCOPE: Scope = {
  getSnapshot: () => EMPTY_SCOPE_SNAPSHOT,
  subscribe: () => () => {},
  release() {},
};

/**
 * Create a custom transport thread state.
 * @param values - The values to use.
 * @param threadId - The ID of the thread to use.
 * @returns The custom transport thread state.
 */
function createCustomTransportThreadState<
  StateType extends Record<string, unknown>,
>(values: StateType, threadId: string): ThreadState<StateType> {
  return {
    values,
    next: [],
    tasks: [],
    metadata: undefined,
    created_at: null,
    checkpoint: {
      thread_id: threadId,
      checkpoint_id: null,
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    parent_checkpoint: null,
  };
}

/**
 * Framework-agnostic orchestrator for custom transport streams.
 *
 * Encapsulates all business logic shared across React, Vue, Svelte, and Angular
 * for custom transport (non-LGP) streaming.
 */
export class CustomStreamOrchestrator<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> implements StreamEngine<StateType, Bag> {
  readonly stream: StreamManager<StateType, Bag>;

  readonly messageManager: MessageTupleManager;

  readonly #options: AnyStreamCustomOptions<StateType, Bag>;

  readonly #channels = new ChannelListeners();

  /**
   * What a run's values start from: `initialValues` on the first thread, and
   * nothing after a switch, since a custom transport reads no thread.
   */
  #baseValues: StateType;

  #threadId: string | null;

  #branch: string = "";

  #listeners = new Set<() => void>();

  #version = 0;

  #streamUnsub: (() => void) | null = null;

  #disposed = false;

  #pendingDispose: ReturnType<typeof setTimeout> | undefined;

  #handledHeadlessToolInterruptIds = new Set<string>();

  readonly #answered = new Set<string>();

  readonly #queue = new PendingRunsTracker<
    StateType,
    CustomSubmitOptions<StateType, GetConfigurableType<Bag>>
  >();

  #tail: Promise<void> = Promise.resolve();

  #turns = 0;

  /** Always `false`: a custom transport has no route to read a thread. */
  readonly isThreadLoading = false;

  /** Settled: there is no thread to load. */
  readonly hydrationPromise: Promise<void> = Promise.resolve();

  /** Holds no error: there is no thread to load. */
  readonly historyData = { error: undefined as unknown };

  /**
   * Empty: a subagent's or subgraph's own view needs the Agent Server's
   * filtered streams. Their events still reach {@link onChannelEvent}.
   */
  readonly scopes = {
    acquire: (_namespace: readonly string[]): Scope => EMPTY_SCOPE,
  };

  /** Empty: fork points come from the Agent Server's thread history. */
  readonly messageMetadataStore = new StreamStore<MessageMetadataMap>(
    new Map()
  );

  /**
   * Create a new {@link CustomStreamOrchestrator} instance.
   *
   * @param options - Configuration options for the custom transport stream,
   *   including thread ID, transport, callbacks, and subagent settings.
   */
  constructor(options: AnyStreamCustomOptions<StateType, Bag>) {
    this.#options = options;

    this.#threadId = options.threadId ?? null;

    this.messageManager = new MessageTupleManager();
    this.stream = new StreamManager<StateType, Bag>(this.messageManager, {
      throttle: options.throttle ?? false,
      subagentToolNames: options.subagentToolNames,
      filterSubagentMessages: options.filterSubagentMessages,
      toMessage: options.toMessage ?? toMessageClass,
    });

    this.#baseValues = options.initialValues ?? ({} as StateType);

    this.#streamUnsub = this.stream.subscribe(() => {
      this.#flushPendingHeadlessToolInterrupts();
      this.#notify();
    });
    this.#queue.subscribe(() => this.#notify());

    const initialMessages = this.#getMessages(this.#baseValues);
    if (
      options.filterSubagentMessages &&
      !this.stream.isLoading &&
      initialMessages.length > 0
    ) {
      this.stream.reconstructSubagents(initialMessages, {
        skipIfPopulated: true,
      });
    }
  }

  /**
   * Register a listener that is called whenever the orchestrator state changes.
   *
   * @param listener - Callback invoked on each state change.
   * @returns An unsubscribe function that removes the listener.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Return the current version number, incremented on each state change.
   * Useful as a cache key for external sync (e.g. `useSyncExternalStore`).
   *
   * @returns The current version counter.
   */
  getSnapshot = (): number => this.#version;

  /**
   * Custom transports do not negotiate stream modes with the server the way
   * LangGraph Platform streams do, but framework adapters call this method on
   * both orchestrator variants. Keep the API surface aligned as a no-op.
   */
  trackStreamMode(..._modes: StreamMode[]): void {}

  /**
   * Call `listener` with every event of this orchestrator's streams, in
   * `@langchain/react` 1.x's channel shape.
   *
   * @returns A function that removes the listener.
   */
  onChannelEvent(listener: (event: ChannelEvent) => void): () => void {
    return this.#channels.add(listener);
  }

  #notify(): void {
    if (this.#disposed) return;
    this.#version += 1;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  /**
   * Synchronize the external thread ID with the orchestrator, as
   * {@link switchThread} does.
   *
   * @param newId - The new thread ID, or `null` to clear.
   */
  syncThreadId(newId: string | null): void {
    this.switchThread(newId);
  }

  /**
   * The thread shown: the one passed in or switched to, or the one the first
   * submit created.
   */
  get threadId(): string | undefined {
    return this.#threadId ?? undefined;
  }

  /**
   * Show a thread before any run, with `initialValues`. Nothing is read: a
   * custom transport has no thread routes.
   */
  initThreadId(threadId: string | undefined): void {
    this.#threadId = threadId ?? null;
  }

  /**
   * Switch to `threadId` when it's another thread. Nothing is read: a custom
   * transport has no thread routes, so the thread shows empty until a run
   * streams.
   */
  hydrate(threadId: string | null = this.#threadId): Promise<void> {
    this.switchThread(threadId);
    return Promise.resolve();
  }

  /**
   * Mark the orchestrator in use. The returned function disposes it a tick
   * later, unless `activate()` runs again first, as when React's StrictMode
   * mounts a component twice.
   */
  activate(): () => void {
    clearTimeout(this.#pendingDispose);
    return () => {
      if (this.#disposed) return;
      this.#pendingDispose = setTimeout(() => this.dispose(), 0);
    };
  }

  /** Resolves to `undefined`: subagents get no view of their own here. */
  resolveSubagentNamespace(_toolCallId: string): Promise<string[] | undefined> {
    return Promise.resolve(undefined);
  }

  /** A no-op: fork points come from the Agent Server's thread history. */
  trackMessageMetadata(): () => void {
    return () => {};
  }

  /** The submits made during a run, waiting for their turn, oldest first. */
  get queueEntries() {
    return this.#queue.entries;
  }

  /** Drop a waiting submit. Resolves to whether it was still waiting. */
  async cancelQueueItem(id: string): Promise<boolean> {
    return this.#queue.remove(id);
  }

  /** Drop every waiting submit. */
  async clearQueue(): Promise<void> {
    this.#queue.removeAll();
  }

  #getMessages = (value: StateType): Message[] => {
    const messagesKey = this.#options.messagesKey ?? DEFAULT_MESSAGES_KEY;
    return Array.isArray(value[messagesKey])
      ? (value[messagesKey] as Message[])
      : [];
  };

  #setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = this.#options.messagesKey ?? DEFAULT_MESSAGES_KEY;
    return { ...current, [messagesKey]: messages };
  };

  /** The latest run's values, or `initialValues` until a run streams. */
  get values(): StateType {
    return this.stream.values ?? this.#baseValues;
  }

  /**
   * The raw stream state values, or `null` if no stream has been started
   * or values have not yet been received.
   */
  get streamValues(): StateType | null {
    return this.stream.values;
  }

  /** The most recent stream error, or `undefined` if no error occurred. */
  get error(): unknown {
    return this.stream.error;
  }

  /** Whether a stream is currently in progress. */
  get isLoading(): boolean {
    return this.stream.isLoading;
  }

  /** The current branch identifier. */
  get branch(): string {
    return this.#branch;
  }

  /**
   * Update the current branch and notify listeners.
   *
   * @param value - The new branch identifier.
   */
  setBranch(value: string): void {
    this.#branch = value;
    this.#notify();
  }

  /** The messages of {@link values}, as {@link BaseMessage} instances. */
  get messages(): BaseMessage[] {
    return ensureMessageInstances(
      this.#getMessages(this.values)
    ) as BaseMessage[];
  }

  /** The tool calls of {@link messages}, paired with their results. */
  get toolCalls() {
    return getToolCallsWithResults(this.#getMessages(this.values));
  }

  /**
   * Get tool calls (with results) that belong to a specific AI message.
   *
   * @param message - The AI message whose tool calls to retrieve.
   * @returns Tool calls associated with the given message.
   */
  getToolCalls(message: Message) {
    const allToolCalls = getToolCallsWithResults(
      this.#getMessages(this.values)
    );
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  }

  /**
   * The interrupts of {@link values}, without those a run in flight
   * answers.
   */
  get interrupts(): Interrupt<GetInterruptType<Bag>>[] {
    const fromValues = valuesInterrupts<GetInterruptType<Bag>>(this.values);
    if (fromValues == null) return [];
    return userFacingInterruptsFromValuesArray(fromValues).filter(
      ({ id }) => id == null || !this.#answered.has(id)
    );
  }

  /** The first of {@link interrupts}. */
  get interrupt(): Interrupt<GetInterruptType<Bag>> | undefined {
    return this.interrupts[0];
  }

  /**
   * Retrieve stream-level metadata for a given message.
   *
   * @param message - The message to look up metadata for.
   * @param index - Optional positional index used as fallback message ID.
   * @returns The metadata associated with the message, or `undefined`
   *   if no stream metadata is available.
   */
  getMessagesMetadata(
    message: Message,
    index?: number
  ): MessageMetadata<StateType> | undefined {
    const streamMetadata = this.messageManager.get(message.id)?.metadata;
    if (streamMetadata != null) {
      return {
        messageId: message.id ?? String(index),
        firstSeenState: undefined,
        branch: undefined,
        branchOptions: undefined,
        streamMetadata,
      } as MessageMetadata<StateType>;
    }
    return undefined;
  }

  /** A map of all tracked subagent streams, keyed by tool call ID. */
  get subagents(): Map<string, SubagentStreamInterface> {
    return this.stream.getSubagents();
  }

  /** The subset of subagent streams that are currently active (loading). */
  get activeSubagents(): SubagentStreamInterface[] {
    return this.stream.getActiveSubagents();
  }

  /**
   * Look up a single subagent stream by its tool call ID.
   *
   * @param toolCallId - The tool call ID that initiated the subagent.
   * @returns The subagent stream, or `undefined` if not found.
   */
  getSubagent(toolCallId: string) {
    return this.stream.getSubagent(toolCallId);
  }

  /**
   * Retrieve all subagent streams matching a given tool name / type.
   *
   * @param type - The subagent type (tool name) to filter by.
   * @returns An array of matching subagent streams.
   */
  getSubagentsByType(type: string) {
    return this.stream.getSubagentsByType(type);
  }

  /**
   * Retrieve all subagent streams associated with a specific AI message.
   *
   * @param messageId - The ID of the parent AI message.
   * @returns An array of subagent streams linked to the message.
   */
  getSubagentsByMessage(messageId: string) {
    return this.stream.getSubagentsByMessage(messageId);
  }

  /**
   * Reconstruct subagent streams from history values when subagent
   * filtering is enabled and the stream is not currently loading.
   * This is a no-op if subagents are already populated.
   */
  reconstructSubagentsIfNeeded(): void {
    const baseMessages = this.#getMessages(this.#baseValues);
    if (
      this.#options.filterSubagentMessages &&
      !this.stream.isLoading &&
      baseMessages.length > 0
    ) {
      this.stream.reconstructSubagents(baseMessages, { skipIfPopulated: true });
    }
  }

  /**
   * Abort the current stream and invoke the `onStop` callback
   * if one was provided in the options, and drop the submits waiting behind
   * it. `cancel` is ignored: a custom transport has no route to cancel a run,
   * and its server sees the request aborted.
   */
  stop(_options?: { cancel?: boolean }): Promise<void> {
    this.#queue.removeAll();
    return this.stream.stop(this.#baseValues, {
      onStop: this.#options.onStop,
    });
  }

  /**
   * Switch to a different thread. If the thread ID actually changed,
   * the current stream is cleared, the submits waiting behind it are
   * dropped, `onThreadId` is called unless the new ID is `null`, and
   * listeners are notified. The new thread starts empty: `initialValues`
   * were the first thread's.
   *
   * @param newThreadId - The thread ID to switch to, or `null` to clear.
   */
  switchThread(newThreadId: string | null): void {
    if (newThreadId !== this.#threadId) {
      this.#threadId = newThreadId;
      this.#baseValues = {} as StateType;
      this.#queue.removeAll();
      this.#handledHeadlessToolInterruptIds.clear();
      this.stream.clear();
      if (newThreadId != null) this.#options.onThreadId?.(newThreadId);
      this.#notify();
    }
  }

  /**
   * Start a new stream run against the custom transport.
   *
   * This is the low-level submit entry point that handles thread ID
   * resolution, optimistic value merging, and transport invocation.
   * Prefer {@link submit} unless you need to bypass higher-level wrappers.
   *
   * @param values - The input values to send, or `null`/`undefined` for
   *   a resume-style invocation.
   * @param submitOptions - Optional per-call overrides such as
   *   `optimisticValues`, `config`, `command`, and error callbacks.
   */
  async submitDirect(
    values: GetUpdateType<Bag, StateType> | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, GetConfigurableType<Bag>>
  ): Promise<void> {
    await this.#submit(values, submitOptions);
  }

  #submit(
    values: GetUpdateType<Bag, StateType> | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, GetConfigurableType<Bag>>,
    started?: () => void
  ): Promise<void> {
    // Submits run one at a time. One made before the others finish is listed
    // until its turn, so an app can show or cancel it.
    const waiting =
      this.#turns > 0
        ? {
            id: uuidv7(),
            values: values as Partial<StateType> | null | undefined,
            options: submitOptions,
            createdAt: new Date(),
          }
        : undefined;
    if (waiting != null) this.#queue.add(waiting);
    this.#turns += 1;
    const turn = this.#tail.then(() =>
      waiting == null || this.#queue.remove(waiting.id)
        ? this.#run(values, submitOptions, started)
        : undefined
    );
    const done = () => {
      this.#turns -= 1;
    };
    this.#tail = turn.then(done, done);
    return turn;
  }

  async #run(
    values: GetUpdateType<Bag, StateType> | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, GetConfigurableType<Bag>>,
    started?: () => void
  ): Promise<void> {
    type UpdateType = GetUpdateType<Bag, StateType>;
    type CustomType = GetCustomEventType<Bag>;

    // Only input shown at once gets ids, so the server's copy replaces it.
    const shown =
      this.#options.optimistic !== false &&
      submitOptions?.optimisticValues == null
        ? prepareSubmitInput(
            values,
            this.#options.messagesKey ?? DEFAULT_MESSAGES_KEY
          )
        : undefined;
    let usableThreadId: string | undefined;
    let runId: string | undefined;
    // An aborted stream calls neither onSuccess nor onError.
    let reason: RunEndReason = "stopped";

    await this.stream.start(
      async (signal: AbortSignal) => {
        // Set as the run starts, so a submit waiting behind a run doesn't
        // change what that run shows.
        this.stream.setStreamValues(() =>
          runStartValues(
            { ...this.#baseValues, ...this.stream.values },
            shown,
            submitOptions?.optimisticValues,
            { get: this.#getMessages, set: this.#setMessages }
          )
        );

        usableThreadId =
          this.#threadId ?? submitOptions?.threadId ?? crypto.randomUUID();
        if (usableThreadId !== this.#threadId) {
          this.#threadId = usableThreadId;
          this.#options.onThreadId?.(usableThreadId);
        }

        const run = await this.#options.transport.stream({
          input: (shown?.dispatchInput ?? values) as UpdateType,
          context: submitOptions?.context,
          command: submitOptions?.command,
          streamSubgraphs: submitOptions?.streamSubgraphs,
          signal,
          config: {
            ...submitOptions?.config,
            configurable: {
              thread_id: usableThreadId,
              ...submitOptions?.config?.configurable,
            } as unknown as GetConfigurableType<Bag>,
          },
        });
        started?.();
        return run as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;
      },
      {
        getMessages: this.#getMessages,
        setMessages: this.#setMessages,
        initialValues: {} as StateType,
        callbacks: this.#options,
        onSuccess: () => {
          reason = valuesInterrupts(this.values)?.length
            ? "interrupt"
            : "success";
          if (!usableThreadId) return undefined;

          this.#options.onFinish?.(
            createCustomTransportThreadState(this.values, usableThreadId),
            undefined
          );

          return undefined;
        },
        onError: (error) => {
          reason = "error";
          this.#options.onError?.(error, undefined);
          submitOptions?.onError?.(error, undefined);
        },
        onFinish: () => {
          // As on an Agent Server: a subagent can't finish once its run has.
          if (reason === "error" || reason === "stopped") {
            this.stream.closeOpenSubagents(`The run ended: ${reason}`);
          }
          if (!this.#disposed) this.#options.onRunEnd?.({ runId, reason });
        },
        onEvent: (event, data) => {
          // A run sends `metadata` once per attempt, with the same id.
          if (event === "metadata" && runId == null) {
            const { run_id: id } = (data ?? {}) as { run_id?: unknown };
            if (typeof id === "string") {
              runId = id;
              this.#options.onCreated?.({
                run_id: id,
                thread_id: usableThreadId!,
              });
            }
          }
          this.#channels.emit(event, data);
        },
      }
    );
  }

  /**
   * Submit input values and start a new stream run.
   *
   * Delegates to {@link submitDirect}. Override or wrap this method
   * in framework adapters to add queuing or other middleware.
   *
   * @param values - The input values to send, or `null`/`undefined` for
   *   a resume-style invocation.
   * @param submitOptions - Optional per-call overrides.
   */
  async submit(
    values: GetUpdateType<Bag, StateType> | null | undefined,
    submitOptions?: CustomSubmitOptions<StateType, GetConfigurableType<Bag>>
  ): Promise<void> {
    await this.submitDirect(values, submitOptions);
  }

  /**
   * Answer an interrupt: `options.interruptId`, or the first one not
   * answered yet, which {@link interrupt} shows. See {@link respondAll}.
   */
  respond(
    value: unknown,
    options: RespondOptions<GetConfigurableType<Bag>> & {
      interruptId?: string;
    } = {}
  ): Promise<void> {
    const interruptId =
      options.interruptId ??
      this.interrupts.find((interrupt) => interrupt.id != null)?.id;
    if (interruptId == null) {
      return Promise.reject(new Error("No pending interrupt to respond to."));
    }
    return this.respondAll({ [interruptId]: value }, options);
  }

  /**
   * Answer interrupts by id in one run, sent through the transport as a
   * resume command. It starts at once or waits behind the run in flight, and
   * the answered interrupts are hidden until it ends. Resolves once the run
   * starts, and rejects when it can't be sent. `strictResume` needs the Agent
   * Server, which checks it.
   */
  async respondAll(
    responses: Record<string, unknown>,
    options: RespondOptions<GetConfigurableType<Bag>> = {}
  ): Promise<void> {
    if (this.#threadId == null) {
      throw new Error("No active thread to respond to.");
    }
    const ids = Object.keys(responses);
    if (ids.length === 0) {
      throw new Error("respondAll() requires at least one response.");
    }
    for (const id of ids) this.#answered.add(id);
    this.#notify();

    let failed: { error: unknown } | undefined;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const ended = this.#submit(
      null,
      {
        config: options.config,
        command: resumeCommand(
          responses,
          options,
          this.#options.messagesKey ?? DEFAULT_MESSAGES_KEY
        ),
        onError: (error) => {
          failed ??= { error };
        },
      },
      started
    ).finally(() => {
      for (const id of ids) this.#answered.delete(id);
      this.#notify();
    });
    await Promise.race([running, ended]);
    if (failed != null) throw failed.error;
  }

  /**
   * Tear down the orchestrator. Marks the instance as disposed,
   * unsubscribes from the stream, and aborts any in-progress stream.
   * After calling this method, no further notifications will be emitted.
   */
  dispose(): void {
    this.#disposed = true;
    this.#streamUnsub?.();
    this.#streamUnsub = null;
    this.#queue.removeAll();
    void this.stream.stop(this.#baseValues, {
      onStop: this.#options.onStop,
    });
  }

  #flushPendingHeadlessToolInterrupts(): void {
    flushPendingHeadlessToolInterrupts(
      this.stream.values as Record<string, unknown> | null,
      this.#options.tools,
      this.#handledHeadlessToolInterruptIds,
      {
        onTool: this.#options.onTool,
        defer: (run) => {
          void Promise.resolve().then(run);
        },
        resumeSubmit: (command) =>
          this.submit(null, {
            command,
          }),
      }
    );
  }
}
