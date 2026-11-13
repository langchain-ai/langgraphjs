import type { BaseMessage } from "@langchain/core/messages";
import { v7 as uuidv7 } from "@langchain/core/utils/uuid";

import { Client } from "../client.js";
import type {
  ThreadState,
  ThreadTask,
  Interrupt,
  Config,
  Metadata,
  Run,
  ServerInfo,
} from "../schema.js";
import type { StreamMode } from "../types.stream.js";
import type { Command, RunsStreamPayload, StreamEvent } from "../types.js";
import type { Message, ToolMessage } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";
import type {
  IdleReconnectMode,
  StreamReconnectOptions,
} from "../utils/stream.js";
import { StreamManager, type EventStreamEvent } from "./manager.js";
import {
  MessageTupleManager,
  toMessageClass,
  ensureMessageInstances,
  ensureHistoryMessageInstances,
} from "./messages.js";
import { PendingRunsTracker, type QueueEntry } from "./queue.js";
import { getBranchContext, getMessagesMetadataMap } from "./branching.js";
import { StreamError } from "./errors.js";
import { ChannelListeners, type ChannelEvent } from "./channels.js";
import { ScopeRegistry, holdStream } from "./scoped.js";
import { resolveSubagentNamespaces } from "./namespace-from-history.js";
import {
  extractInterrupts,
  resumeCommand,
  userFacingInterruptsFromThreadTasks,
  userFacingInterruptsFromValuesArray,
  valuesInterrupts,
} from "./interrupts.js";
import type { StreamEngine } from "./engine.js";
import { unique, filterStream, onFinishRequiresThreadState } from "./utils.js";
import { STOP_RUN_ID_WAIT_MS } from "./constants.js";
import {
  applyStopRead,
  hasPendingNodes,
  hasTaskInterrupts,
  type HistoryReadOptions,
  planReadAfterRun,
  planStopRead,
} from "./thread-reads.js";
import { getToolCallsWithResults } from "../utils/tools.js";
import {
  prepareSubmitInput,
  restoreKeys,
  runStartValues,
  snapshotKeys,
  type OptimisticKeySnapshot,
} from "./optimistic-input.js";
import {
  MessageMetadataTracker,
  findForkPoints,
  type MessageMetadataMap,
} from "./message-metadata-tracker.js";
import type { StreamStore } from "./store.js";
import { flushPendingHeadlessToolInterrupts } from "../headless-tools.js";
import { followThread } from "./thread-watcher.js";
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

interface LiveRun {
  promise: Promise<void>;
  /**
   * Set when the stream starts. Once `stop()`, a thread switch or an
   * interrupt aborts it, the run is no longer live and can be joined again.
   */
  signal?: AbortSignal;
}

type RunOutcome = "success" | "aborted" | { error: unknown };

export interface RunWatch {
  /** The status in the run's `end` event, from servers that send one. */
  status?: string;
  /** A root `values` or `updates` event carried `__interrupt__`. */
  paused?: boolean;
}

export function watchRunEvent(watch: RunWatch, event: string, data: unknown) {
  if (event === "end") {
    watch.status = (data as { status?: string } | null)?.status;
  } else if (
    (event === "values" || event === "updates") &&
    typeof data === "object" &&
    data != null &&
    "__interrupt__" in data
  ) {
    watch.paused = true;
  }
}

/**
 * The state's interrupts don't say where they were raised, so a subgraph
 * task's checkpoint namespace stands in.
 */
function taskInterrupts(task: ThreadTask): Interrupt[] {
  const namespace = task.checkpoint?.checkpoint_ns;
  if (!namespace) return task.interrupts ?? [];
  return (task.interrupts ?? []).map((interrupt) =>
    interrupt.namespace != null
      ? interrupt
      : { ...interrupt, namespace: namespace.split("|") }
  );
}

/**
 * Turns off the v3 streaming marker a thread keeps once a v3 client used it,
 * so the run streams the shape this engine reads. The Agent Server refuses a
 * run with both `configurable` and `context`, and a `context` key would reach
 * the graph's context schema, so a run with `context` goes without it.
 */
function withV1Streaming(
  config: Config | undefined,
  context: Record<string, unknown> | undefined
): Config | undefined {
  if (context != null && Object.keys(context).length > 0) return config;
  return {
    ...config,
    configurable: { ...config?.configurable, __event_streaming_v2: false },
  };
}

/** Run events that only servers with `stream_lifecycle` send on run routes. */
const RUN_EVENT_MODES: readonly StreamMode[] = ["lifecycle", "tools"];

const withoutRunEventModes = (modes: StreamMode[]) =>
  modes.filter((mode) => !RUN_EVENT_MODES.includes(mode));

const serverInfoReads = new WeakMap<Client, Promise<ServerInfo | undefined>>();

/**
 * What the server supports, from `/info`, read once per client. A read that
 * fails or takes over 5 s counts as no support, and the next run that needs
 * it reads again, apart from a 404: that server has no `/info`.
 */
function serverInfo(client: Client): Promise<ServerInfo | undefined> {
  let read = serverInfoReads.get(client);
  if (read == null) {
    // Not AbortSignal.timeout, which React Native lacks.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 5_000);
    read = Promise.resolve()
      .then(() => client.info({ signal: timeout.signal }))
      .catch((error: unknown) => {
        if ((error as { status?: unknown } | null)?.status !== 404) {
          serverInfoReads.delete(client);
        }
        return undefined;
      })
      .finally(() => clearTimeout(timer));
    serverInfoReads.set(client, read);
  }
  return read;
}

const warnedClients = new WeakSet<Client>();

/** Says once per client why reading a subagent's messages streams every event of a run. */
function warnInterim(client: Client, info: ServerInfo | undefined): void {
  if (info?.flags?.stream_lifecycle === true || warnedClients.has(client)) {
    return;
  }
  warnedClients.add(client);
  console.warn(
    info == null
      ? "@langchain/langgraph-sdk: couldn't read the server's /info, so reading a subagent's messages streams every event of each run until a read succeeds. A proxy in front of the server may need to route /info."
      : "@langchain/langgraph-sdk: this server sends no subagent lifecycle events, so reading a subagent's messages streams every event of each run. A newer Agent Server sends only the subagents being read."
  );
}

const isUnprocessable = (error: unknown) =>
  (error as { status?: unknown } | null)?.status === 422;

/**
 * Streams `first`, or `retry` when `first` is refused with a 422 before any
 * event: an older pod during a rollout rejects `lifecycle` and `tools`.
 */
async function* retryUnprocessable<T>(
  first: AsyncIterable<T>,
  retry: () => AsyncIterable<T>
): AsyncGenerator<T> {
  const events = first[Symbol.asyncIterator]();
  let head: IteratorResult<T>;
  try {
    head = await events.next();
  } catch (error) {
    if (!isUnprocessable(error)) throw error;
    yield* retry();
    return;
  }
  if (head.done) return;
  yield head.value;
  yield* { [Symbol.asyncIterator]: () => events };
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

/** Why a run's stream ended, as {@link StreamOrchestratorOptions.onRunEnd} gets it. */
export type RunEndReason = "success" | "error" | "interrupt" | "stopped";

/**
 * Options of {@link StreamOrchestrator}: the stream options, plus the run
 * behavior that framework bindings can turn on.
 */
export type StreamOrchestratorOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> = AnyStreamOptions<StateType, Bag> &
  StreamReconnectOptions & {
    /**
     * Runs outlive their tab, unless this is `false`. They are created with
     * `streamResumable` and `onDisconnect: "continue"`, each thread load joins
     * the thread's running run from the checkpoint the load showed, whichever
     * tab started it, and {@link StreamOrchestrator.stop} cancels the run on
     * the server.
     */
    durableRuns?: boolean;

    /** Called when the stream of each run this orchestrator streams ends. */
    onRunEnd?: (run: { runId: string; reason: RunEndReason }) => void;

    /** Idle-reconnect policy for run streams, as `client.runs.stream` takes it. */
    streamIdleReconnect?: IdleReconnectMode;

    /**
     * Where a submit made during a run waits: `"server"` (the default)
     * creates the run in the server's queue, `"local"` keeps it here and
     * sends it once the engine is idle.
     */
    queue?: "server" | "local";

    /**
     * Stream each subagent only to the scopes acquired for it
     * ({@link StreamOrchestrator.scopes}), not with its run, and keep its
     * messages out of the main conversation, as `filterSubagentMessages`
     * does. Runs then stream subgraphs unless a submit says otherwise, and on
     * a server that filters by namespace (`/info` flags `stream_namespaces`
     * and `stream_lifecycle`) a run's stream carries the main conversation
     * and the subagents' lifecycle events. Read a subagent's messages from
     * its scope: on such a server `subagents` has its status and result only.
     */
    scopedSubagents?: boolean;

    /**
     * Show a submit's input at once, unless this is `false`: its messages,
     * with ids minted for the ones without, and its other keys. The run's
     * `values` then replace them. A submit with its own `optimisticValues`
     * shows only those.
     */
    optimistic?: boolean;

    /**
     * Follow the thread's `lifecycle` stream between
     * {@link StreamOrchestrator.activate} and dispose, unless this is
     * `false`: a run started elsewhere (another tab, a cron) is joined, a run
     * that ended elsewhere reads the state again, and interrupts answered
     * elsewhere are hidden. It pauses while a run streams here, while the
     * queue holds runs and while the page is hidden, and stays off on a
     * server without a thread stream.
     */
    watchThread?: boolean;
  };

/** Options of {@link StreamOrchestrator.respond} and {@link StreamOrchestrator.respondAll}. */
export interface RespondOptions<
  ConfigurableType extends Record<string, unknown> = Record<string, unknown>,
> extends Pick<
  SubmitOptions<Record<string, unknown>, ConfigurableType>,
  "config" | "metadata" | "strictResume"
> {
  /** A state update applied with the answer. */
  update?: Command["update"];
  /** The node to go to next. */
  goto?: Command["goto"];
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
> implements StreamEngine<StateType, Bag> {
  readonly stream: StreamManager<StateType, Bag>;

  readonly messageManager: MessageTupleManager;

  readonly pendingRuns: PendingRunsTracker<
    StateType,
    SubmitOptions<StateType, GetConfigurableType<Bag>>
  >;

  readonly #options: StreamOrchestratorOptions<StateType, Bag>;

  readonly #accessors: OrchestratorAccessors;

  readonly historyLimit: boolean | number;

  readonly #runMetadataStorage: RunMetadataStorage | null;

  readonly #durable: boolean;

  readonly #callbackStreamModes: StreamMode[];

  readonly #trackedStreamModes: StreamMode[] = [];

  #threadId: string | undefined;

  #threadIdPromise: Promise<string | undefined> | null = null;

  #threadIdStreaming: string | null = null;

  #history: UseStreamThread<StateType>;

  #branch: string = "";

  #submitting = false;

  #liveRuns = new Map<string, LiveRun>();

  /** The run being streamed, unless the app joined it: the run `stop()` cancels. */
  #streamingRunId: string | undefined;

  /** Pending while the create request of the run being submitted awaits its response. */
  #ownRun: Promise<string | undefined> | undefined;

  /** Aborted by `stop()` to cancel the own run being streamed once its id arrives. */
  #stopOwnRun: AbortController | undefined;

  #hydration: Promise<void> = Promise.resolve();

  /**
   * The thread load in flight: the head shown when it began, and the stream
   * epoch and whether a stream ran then.
   */
  #load:
    | { shownBefore: string | undefined; epoch: number; idle: boolean }
    | undefined;

  #pendingDispose: ReturnType<typeof setTimeout> | undefined;

  /** Threads a read found missing, which the next submit creates first. */
  #missingThreads = new Set<string>();

  /** Subagent namespace lookups in flight on the current thread, by tool call id. */
  #namespaceLookups = new Map<string, Promise<string[] | undefined>>();

  /** Interrupts answered by a run that hasn't ended yet. */
  #answered = new Set<string>();

  #interruptNamespaces = new Map<string, string[]>();

  #listeners = new Set<() => void>();

  #version = 0;

  #streamUnsub: (() => void) | null = null;

  #queueUnsub: (() => void) | null = null;

  #disposed = false;

  #handledHeadlessToolInterruptIds = new Set<string>();

  readonly #channels = new ChannelListeners();

  /** Subgraph scopes, such as subagent panels, that stream while held. */
  readonly scopes: ScopeRegistry;

  #active = false;

  /**
   * What a load found before the first {@link activate}, done when it comes:
   * bindings create engines during a render, and one from a render that
   * never commits must not join runs or run tools. The running run's join,
   * and the head whose tool calls to run. A stream the engine starts first
   * supersedes them.
   */
  #heldJoin: (() => void) | undefined;

  #heldTools: ThreadState<StateType> | undefined;

  #watch: { threadId: string; controller: AbortController } | undefined;

  /** Where the current thread's watcher resumes. */
  #watchCursor: { lastEventId?: string } = {};

  /** The server answered the watcher with a 404: it has no thread stream. */
  #watchOff = false;

  /** A thread whose watcher the server refused with another 4xx. */
  #watchRefused: string | undefined;

  /**
   * A thread a read found or this orchestrator created. A 404 on another
   * thread's stream may only mean that thread doesn't exist yet.
   */
  #threadExists: string | undefined;

  /** The runs seen on the current thread, so a replayed event is handled once. */
  #threadRuns = new Map<string, "running" | "ended">();

  /** Interrupt ids answered by runs started elsewhere, by run. */
  #answeredBy = new Map<string, string[]>();

  /**
   * Queued runs a thread load listed, which another client may have queued,
   * as the list returned them.
   */
  #listedRuns = new Map<string, Run>();

  #onVisibilityChange = () => this.#syncWatcher();

  readonly #metadata = new MessageMetadataTracker();

  #metadataUsers = 0;

  /** Messages a read-back placed or gave up on, so none is read for twice. */
  #forkDecided = new Set<string>();

  /** Checkpoints a read-back read the steps of, where the next one stops. */
  readonly #forkSeen = new Set<string>();

  #forkRead: AbortController | undefined;

  /**
   * Create a new StreamOrchestrator.
   *
   * @param options - Configuration options for the stream, including callbacks,
   *   throttle settings, reconnect behaviour, and subagent filters.
   * @param accessors - Framework-specific accessors that resolve reactive
   *   primitives (client, assistant ID, messages key) at call time.
   */
  constructor(
    options: StreamOrchestratorOptions<StateType, Bag>,
    accessors: OrchestratorAccessors
  ) {
    // Scoped subagents keep their messages out of the main conversation.
    this.#options = options.scopedSubagents
      ? { ...options, filterSubagentMessages: true }
      : options;
    this.#accessors = accessors;

    this.#runMetadataStorage = resolveRunMetadataStorage(
      options.reconnectOnMount
    );
    this.#durable = options.durableRuns !== false;
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
      filterSubagentMessages: this.#options.filterSubagentMessages,
      toMessage: options.toMessage ?? toMessageClass,
    });

    this.scopes = new ScopeRegistry({
      client: () => this.#accessors.getClient(),
      threadId: () => this.#threadId,
      messagesKey: () => this.#accessors.getMessagesKey(),
      reconnectOptions: () => this.#reconnectOptions(),
      canFilter: () => this.#canFilter(),
      rootMessageIds: () =>
        new Set(this.messages.flatMap((message) => message.id ?? [])),
      finished: (namespace) =>
        [...this.stream.getSubagents().values()].some(
          (subagent) =>
            subagent.namespace.join("|") === namespace &&
            (subagent.status === "complete" || subagent.status === "error")
        ),
      onEvent: (event, data) => this.#channels.emit(event, data),
      acquired: () => {
        if (!this.#options.scopedSubagents) return;
        const client = this.#accessors.getClient();
        void serverInfo(client).then((info) => warnInterim(client, info));
      },
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
    this.#syncWatcher();
    this.#placeForkPoints();
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
    this.#clearThreadState();
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
    this.#threadExists = newId;
    this.#handledHeadlessToolInterruptIds.clear();
    this.#options.onThreadId?.(newId);
    this.#notify();
  }

  #dropHeld(): void {
    this.#heldJoin = undefined;
    this.#heldTools = undefined;
  }

  #clearThreadState(): void {
    this.#dropHeld();
    this.#branch = "";
    this.#namespaceLookups.clear();
    this.scopes.clear();
    this.#handledHeadlessToolInterruptIds.clear();
    this.#answered.clear();
    this.#interruptNamespaces.clear();
    this.#threadRuns.clear();
    this.#answeredBy.clear();
    this.#watchCursor = {};
    this.#metadata.reset();
    this.#forkRead?.abort();
    this.#forkRead = undefined;
    this.#forkDecided.clear();
    this.#forkSeen.clear();
    this.stream.clear();
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
        data: undefined,
        error: undefined,
        isLoading: true,
        mutate: this.#mutate,
      };
      this.#notify();
      this.#startLoad(
        this.#mutate(threadId).then((states) =>
          this.#joinActiveRun(threadId, states)
        )
      );
    } else {
      this.#history = {
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: this.#mutate,
      };
      this.#startLoad(Promise.resolve());
      this.#notify();
    }
  }

  /** Makes `load` the thread's load: {@link hydrationPromise} until it settles. */
  #startLoad(load: Promise<void>): void {
    const current = {
      // The head on screen, unless an earlier load still has it in doubt.
      shownBefore: this.#unconfirmedHead()
        ? this.#load?.shownBefore
        : this.#headId(),
      epoch: this.stream.epoch,
      idle: !this.stream.isLoading,
    };
    this.#load = current;
    this.#hydration = load.finally(() => {
      if (this.#load !== current) return;
      this.#load = undefined;
      // No stream ran during the load, so no run has answered its calls since.
      if (current.idle && this.stream.epoch === current.epoch) {
        const head = this.#history.data?.at(0);
        if (this.#active) this.#flushHeadToolCalls(head);
        else this.#heldTools = head;
      }
      this.#notify();
    });
  }

  /**
   * The head shown came from a thread load that hasn't ruled out a run still
   * going on it, so its `next` and interrupts may be that run's. The head
   * shown when the load began stays trusted, and a stream begun since then
   * reads its own head.
   */
  #unconfirmedHead(): boolean {
    const load = this.#load;
    return (
      load != null &&
      load.epoch === this.stream.epoch &&
      this.#headId() !== load.shownBefore
    );
  }

  #headId(): string | undefined {
    return (
      this.branchContext.threadHead?.checkpoint?.checkpoint_id ?? undefined
    );
  }

  async #joinActiveRun(
    threadId: string,
    states: ThreadState<StateType>[] | undefined
  ): Promise<void> {
    if (
      !this.#durable ||
      states == null ||
      threadId !== this.#threadId ||
      this.#missingThreads.has(threadId)
    ) {
      return;
    }
    const client = this.#accessors.getClient();
    // A lookup that hangs would hold the load, and with it the head's
    // interrupts, for good. Not AbortSignal.timeout, which React Native lacks.
    const lookup = new AbortController();
    const timer = setTimeout(() => lookup.abort(), 10_000);
    const [runs, pending] = await Promise.all([
      client.runs
        .list(threadId, { status: "running", limit: 1, signal: lookup.signal })
        .catch(() => undefined),
      this.#options.queue === "local"
        ? undefined
        : client.runs
            .list(threadId, {
              status: "pending",
              limit: 100,
              select: ["run_id", "kwargs", "created_at"],
              signal: lookup.signal,
            })
            .catch(() => undefined),
    ]).finally(() => clearTimeout(timer));
    if (threadId !== this.#threadId) return;
    if (pending != null) this.#queueListedRuns(pending);
    if (runs == null) return;
    const head = states.at(0);
    const runId = runs.at(0)?.run_id;
    if (runId != null) {
      // The queue drains when this join ends.
      const join = () =>
        void this.#join(
          runId,
          "-1",
          { checkpointId: head?.checkpoint?.checkpoint_id ?? undefined },
          true,
          runs.at(0)
        );
      if (this.#active) join();
      else this.#heldJoin = join;
      return;
    }
    if (hasPendingNodes(head) && !hasTaskInterrupts(head)) {
      // The read caught a run mid-step that has ended since, so it misses
      // the run's last steps.
      await this.#mutate(threadId, { quiet: true });
    }
    if (this.#active) this.#drainQueue();
  }

  /** Adds the server's queued runs this queue doesn't hold yet, oldest first. */
  #queueListedRuns(runs: Run[]): void {
    const queued = new Set(this.pendingRuns.entries.map((entry) => entry.id));
    const listed = runs
      .filter((run) => !queued.has(run.run_id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const run of listed) {
      const command = run.kwargs?.command as Command | undefined;
      const resume = command?.resume;
      if (resume != null && typeof resume === "object") {
        for (const id of Object.keys(resume)) this.#answered.add(id);
      }
      this.#listedRuns.set(run.run_id, run);
      this.pendingRuns.add({
        id: run.run_id,
        values: run.kwargs?.input as Partial<StateType> | null | undefined,
        options: command == null ? undefined : { command },
        createdAt: new Date(run.created_at),
      });
    }
  }

  /**
   * Reads the thread again. When idle, drops the values left from earlier
   * streams, so the read shows.
   */
  async #reload(
    threadId: string,
    readOptions: HistoryReadOptions<StateType> = {},
    rejoin = false
  ): Promise<void> {
    const states = await this.#mutate(threadId, readOptions);
    if (states == null || threadId !== this.#threadId) return;
    if (!this.isLoading) {
      // A failed message the reload still shows was saved after all, so its
      // fork point is read again.
      const unsaved = this.#metadata.unpersistedOptimisticIds();
      this.#metadata.forget(unsaved);
      for (const id of unsaved) this.#forkDecided.delete(id);
      this.stream.setStreamValues(null);
    }
    if (rejoin) await this.#joinActiveRun(threadId, states);
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
    mutateId?: string,
    readOptions: HistoryReadOptions<StateType> = {}
  ): Promise<ThreadState<StateType>[] | undefined> {
    const tid = mutateId ?? this.#threadId;
    if (!tid) return undefined;
    const idle = !this.stream.isLoading;
    const epoch = this.stream.epoch;
    try {
      const fetched = await fetchHistory<StateType>(
        this.#accessors.getClient(),
        tid,
        { limit: this.historyLimit }
      );
      const data = readOptions.map?.(fetched) ?? fetched;
      // The thread switched during the read; its own fetch fills the history.
      if (tid !== this.#threadId) return data;
      this.#threadFound(tid);
      this.#history = {
        data,
        error: undefined,
        isLoading: false,
        mutate: this.#mutate,
      };
      // A read issued while a run streamed, or before one began, can show a
      // call that run answered, so `#finishRun` runs the calls in the head
      // read after a run. A load runs its head's calls when it ends, in
      // `#startLoad`, once it has ruled out such a run.
      if (idle && epoch === this.stream.epoch && !this.#unconfirmedHead()) {
        this.#flushHeadToolCalls(data?.at(0));
      }
      this.#notify();
      return data;
    } catch (err) {
      if (tid !== this.#threadId || readOptions.quiet) return undefined;
      // An id the app minted before its thread exists, or a deleted thread's.
      if ((err as { status?: unknown } | null)?.status === 404) {
        this.#missingThreads.add(tid);
        this.#history = {
          data: [],
          error: undefined,
          isLoading: false,
          mutate: this.#mutate,
        };
        this.#notify();
        return [];
      }
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
   * Called when a run succeeds. Returns null when the head was read, which
   * clears the run's streamed values so the head shows.
   */
  async #finishRun(
    threadId: string | undefined,
    refetch: boolean,
    callbackMeta: RunCallbackMeta | undefined
  ): Promise<null | undefined> {
    const read = planReadAfterRun(this.branchContext.threadHead, refetch);
    if (read && threadId) {
      const lastHead = (await this.#mutate(threadId, read))?.at(0);
      if (lastHead) {
        // The read can land after a thread switch, and a resume goes to the
        // current thread.
        if (threadId === this.#threadId) this.#flushHeadToolCalls(lastHead);
        this.#options.onFinish?.(lastHead, callbackMeta);
        return null;
      }
    }
    if (
      this.#options.onFinish != null &&
      !onFinishRequiresThreadState(this.#options.onFinish)
    ) {
      this.#options.onFinish(
        undefined as unknown as ThreadState<StateType>,
        callbackMeta
      );
    }
    return undefined;
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
   * Whether the stream is currently active and receiving events, or a load
   * found a running run that the first {@link activate} joins.
   */
  get isLoading(): boolean {
    return this.stream.isLoading || this.#heldJoin != null;
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
   * Returns an empty array when the stream is loading, while a thread load
   * looks for a run still going, or when no interrupts are present. Falls
   * back to a `{ when: "breakpoint" }` sentinel when
   * there are pending next nodes but no explicit interrupt data.
   */
  get interrupts(): Interrupt<GetInterruptType<Bag>>[] {
    const fromValues = valuesInterrupts<GetInterruptType<Bag>>(this.values);
    if (fromValues != null) {
      return this.#visible(userFacingInterruptsFromValuesArray(fromValues));
    }

    if (this.isLoading || this.#unconfirmedHead()) return [];

    const allTasks = this.branchContext.threadHead?.tasks ?? [];
    const allInterrupts = allTasks.flatMap(taskInterrupts);

    const userFacing = userFacingInterruptsFromThreadTasks<
      GetInterruptType<Bag>
    >(allInterrupts as Interrupt<GetInterruptType<Bag>>[]);
    if (userFacing != null) return this.#visible(userFacing);

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
    const interrupt = extractInterrupts<GetInterruptType<Bag>>(this.values, {
      isLoading: this.isLoading || this.#unconfirmedHead(),
      threadState: this.branchContext.threadHead,
      error: this.error,
    });
    return interrupt?.id != null && this.#answered.has(interrupt.id)
      ? undefined
      : interrupt;
  }

  #visible<T>(interrupts: Interrupt<T>[]): Interrupt<T>[] {
    if (this.#answered.size === 0 && this.#interruptNamespaces.size === 0) {
      return interrupts;
    }
    return interrupts.flatMap((interrupt) => {
      if (interrupt.id == null) return [interrupt];
      if (this.#answered.has(interrupt.id)) return [];
      const namespace = this.#interruptNamespaces.get(interrupt.id);
      return [
        namespace == null || interrupt.namespace != null
          ? interrupt
          : { ...interrupt, namespace },
      ];
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
   * Each shown message's `parentCheckpointId`, the checkpoint to fork from to
   * edit it, while {@link trackMessageMetadata} holds, and each optimistic
   * message's `optimisticStatus`.
   */
  get messageMetadataStore(): StreamStore<MessageMetadataMap> {
    return this.#metadata.store;
  }

  /**
   * Places fork points in {@link messageMetadataStore} until the returned
   * release is called, as a `useMessageMetadata` hook does while mounted.
   * Whenever the engine is idle with messages not placed yet, it reads the
   * thread's history from the newest checkpoint down to one it read before.
   */
  trackMessageMetadata(): () => void {
    this.#metadataUsers += 1;
    this.#placeForkPoints();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#metadataUsers -= 1;
    };
  }

  #placeForkPoints(): void {
    const threadId = this.#threadId;
    if (
      this.#metadataUsers === 0 ||
      this.#disposed ||
      this.#forkRead != null ||
      threadId == null ||
      this.isLoading ||
      this.#history.isLoading
    ) {
      return;
    }
    const targets = new Set(
      this.messages.flatMap(({ id }) =>
        id != null && !this.#forkDecided.has(id) ? [id] : []
      )
    );
    if (targets.size === 0) return;

    const client = this.#accessors.getClient();
    const read = new AbortController();
    this.#forkRead = read;
    void findForkPoints(
      ({ before, checkpoint, ...options }) =>
        client.threads.getHistory(threadId, {
          ...options,
          signal: read.signal,
          before:
            before == null
              ? undefined
              : { configurable: { checkpoint_id: before } },
          checkpoint:
            checkpoint == null ? undefined : { checkpoint_id: checkpoint },
        }),
      this.#accessors.getMessagesKey(),
      targets,
      {
        seen: this.#forkSeen,
        // The shown messages are a run's values, or else those of the shown
        // branch's head, which after `setBranch` isn't the newest checkpoint.
        head:
          this.stream.values == null
            ? (this.branchContext.threadHead?.checkpoint?.checkpoint_id ??
              undefined)
            : undefined,
      }
    ).then(
      ({ forkPoints, visited }) => {
        // A thread switch dropped the read.
        if (this.#forkRead !== read) return;
        this.#forkRead = undefined;
        for (const id of targets) this.#forkDecided.add(id);
        for (const id of visited) this.#forkSeen.add(id);
        this.#metadata.recordForkPoints(forkPoints);
        // Messages may have come while it read.
        this.#placeForkPoints();
      },
      () => {
        // A failed read waits for the next change instead of retrying at once.
        if (this.#forkRead === read) this.#forkRead = undefined;
      }
    );
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
    const entry = this.pendingRuns.entries.find((e) => e.id === id);
    if (entry == null || !this.pendingRuns.remove(id)) return false;
    await this.#dropQueued(this.#threadId, [entry]);
    return true;
  }

  /**
   * Remove all pending runs from the queue and cancel them on the server.
   */
  async clearQueue(): Promise<void> {
    await this.#dropQueued(this.#threadId, this.pendingRuns.removeAll());
  }

  #dropQueued(
    threadId: string | undefined,
    entries: QueueEntry<
      StateType,
      SubmitOptions<StateType, GetConfigurableType<Bag>>
    >[]
  ): Promise<unknown> {
    for (const entry of entries) this.#unhide(entry.options?.command);
    if (threadId == null || this.#options.queue === "local") {
      return Promise.resolve();
    }
    const client = this.#accessors.getClient();
    return Promise.all(
      entries.map((entry) => client.runs.cancel(threadId, entry.id))
    );
  }

  #unhide(command: Command | undefined): void {
    const resume = command?.resume;
    if (
      this.#answered.size === 0 ||
      resume == null ||
      typeof resume !== "object"
    ) {
      return;
    }
    let changed = false;
    for (const id of Object.keys(resume)) {
      changed = this.#answered.delete(id) || changed;
    }
    if (changed) this.#notify();
  }

  #watchEvent(watch: RunWatch, event: string, data: unknown): void {
    watchRunEvent(watch, event, data);
    if (!event.startsWith("updates|")) return;
    const interrupts = (data as { __interrupt__?: unknown } | null)
      ?.__interrupt__;
    if (!Array.isArray(interrupts)) return;
    const namespace = event.split("|").slice(1);
    for (const { id } of interrupts as Interrupt[]) {
      // Each graph above the one that raised it repeats the interrupt, so
      // the deepest namespace wins.
      const known = this.#interruptNamespaces.get(id ?? "")?.length ?? 0;
      if (id != null && known < namespace.length) {
        this.#interruptNamespaces.set(id, namespace);
      }
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
    // Scopes read a subagent's history when its panel opens.
    if (this.historyLimit !== false && tid && !this.#options.scopedSubagents) {
      const controller = new AbortController();
      void this.stream.fetchSubagentHistory(
        this.#accessors.getClient().threads,
        tid,
        {
          messagesKey: this.#accessors.getMessagesKey(),
          historyLimit:
            typeof this.historyLimit === "number"
              ? this.historyLimit
              : undefined,
          signal: controller.signal,
        }
      );
      return controller;
    }

    return null;
  }

  /**
   * Find a subagent's namespace, so its scope can be acquired after a reload:
   * the one bound while it streamed, else the one its `task` tool message
   * records (`artifact.checkpoint_ns`), else a match in the thread's lean
   * history. A subagent with no tool message yet is running or paused, so
   * the newest two history entries hold its call and its task. The subagent
   * keeps the namespace found. Callers that ask at the same time share one
   * lookup.
   *
   * @param toolCallId - The tool call ID that started the subagent.
   * @returns Its namespace, or `undefined` if none was found.
   */
  resolveSubagentNamespace(toolCallId: string): Promise<string[] | undefined> {
    const inFlight = this.#namespaceLookups.get(toolCallId);
    if (inFlight != null) return inFlight;
    const lookup = this.#lookUpSubagentNamespace(toolCallId).finally(() => {
      if (this.#namespaceLookups.get(toolCallId) === lookup) {
        this.#namespaceLookups.delete(toolCallId);
      }
    });
    this.#namespaceLookups.set(toolCallId, lookup);
    return lookup;
  }

  async #lookUpSubagentNamespace(
    toolCallId: string
  ): Promise<string[] | undefined> {
    const bound = this.getSubagent(toolCallId)?.namespace;
    if (bound != null && bound.length > 0) return bound;
    const threadId = this.#threadId;
    if (threadId == null) return undefined;
    const toolMessage = this.messages.find(
      (message): message is ToolMessage =>
        message.type === "tool" && message.tool_call_id === toolCallId
    );
    const stamped: unknown = toolMessage?.artifact?.checkpoint_ns;
    const namespace =
      typeof stamped === "string"
        ? stamped
        : (
            await resolveSubagentNamespaces(
              this.#accessors.getClient(),
              threadId,
              [toolCallId],
              {
                messagesKey: this.#accessors.getMessagesKey(),
                limit: toolMessage == null ? 2 : undefined,
              }
            ).catch(() => undefined)
          )?.get(toolCallId);
    if (namespace == null || threadId !== this.#threadId) return undefined;
    const segments = namespace.split("|");
    this.stream.bindSubagentNamespace(toolCallId, segments);
    return segments;
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
   * Call `listener` with every event of this orchestrator's streams, in
   * `@langchain/react` 1.x's channel shape.
   *
   * @returns A function that removes the listener.
   */
  onChannelEvent(listener: (event: ChannelEvent) => void): () => void {
    return this.#channels.add(listener);
  }

  /**
   * Stop the currently active stream at once and cancel its run on the
   * server, unless `cancel` is `false`. A run whose id is still on its way is
   * cancelled once it arrives. A run joined through {@link joinStream} keeps
   * going. With `durableRuns: false`, if reconnect metadata storage is
   * configured, cancel the run stored there instead, and clean up its entry.
   */
  async stop(options?: { cancel?: boolean }): Promise<void> {
    const threadId = this.#threadId;
    if (this.#durable && options?.cancel !== false && threadId) {
      if (this.#stopOwnRun != null || this.#streamingRunId != null) {
        this.stream.closeOpenSubagents("The run ended: stopped");
      }
      this.#stopOwnRun?.abort();
      if (this.#streamingRunId) {
        void this.#accessors
          .getClient()
          .runs.cancel(threadId, this.#streamingRunId)
          .catch(() => undefined);
      }
    }
    this.scopes.setRun(undefined);
    const shownHead = this.branchContext.threadHead;
    const read = planStopRead({
      history:
        this.historyLimit === true || typeof this.historyLimit === "number",
    });

    await this.stream.stop(this.historyValues, {
      onStop: (args) => {
        if (this.#runMetadataStorage && this.#threadId) {
          const runId = this.#runMetadataStorage.getItem(
            `lg:stream:${this.#threadId}`
          );
          if (runId && !this.#durable) {
            void this.#accessors.getClient().runs.cancel(this.#threadId, runId);
          }
          this.#runMetadataStorage.removeItem(`lg:stream:${this.#threadId}`);
        }
        this.#options.onStop?.(args);
      },
      // A cancelled run skips `onSuccess`, so the buffer still holds what it
      // streamed, including a message chunk the server never saved.
      read:
        threadId == null || this.#disposed
          ? undefined
          : async () => {
              const newHistory = await this.#mutate(threadId, {
                ...read,
                map: (states) => applyStopRead(states, shownHead),
              });
              if (newHistory == null) return undefined;
              return newHistory.at(0)?.values ?? null;
            },
    });
  }

  /**
   * Join an existing run's event stream by run ID. Used for reconnecting
   * to in-progress runs or consuming queued runs. A run this orchestrator
   * is already streaming or has queued is not joined again: the call
   * returns that stream's promise and ignores its own options.
   *
   * @param runId - The ID of the run to join.
   * @param lastEventId - The last event ID received, for resuming mid-stream.
   *   Defaults to `"-1"` (start from the beginning).
   * @param joinOptions - Additional options for stream mode and event filtering.
   */
  joinStream(
    runId: string,
    lastEventId?: string,
    joinOptions?: {
      streamMode?: StreamMode | StreamMode[];
      filter?: (event: {
        id?: string;
        event: StreamEvent;
        data: unknown;
      }) => boolean;
      /** See `checkpointId` on `client.runs.joinStream`. */
      checkpointId?: string;
    }
  ): Promise<void> {
    return this.#join(runId, lastEventId, joinOptions, false);
  }

  /**
   * `own` marks a join `stop()` may cancel: the engine's queued and stored runs
   * and the run it finds after a load. Apps call `joinStream()` to watch a run,
   * so `stop()` leaves those runs going. `runInfo` is the run as a list
   * returned it, so its options need no read.
   */
  async #join(
    runId: string,
    lastEventId: string | undefined,
    joinOptions: Parameters<
      StreamOrchestrator<StateType, Bag>["joinStream"]
    >[2],
    own: boolean,
    runInfo?: Run
  ): Promise<void> {
    type UpdateType = GetUpdateType<Bag, StateType>;
    type CustomType = GetCustomEventType<Bag>;

    // The run being submitted may be this one, known only once its create
    // request answers.
    if (this.#ownRun) await this.#ownRun;
    // Lookups and loads can answer after a dispose.
    if (this.#disposed) return;
    const live = this.#liveRuns.get(runId);
    if (live && !live.signal?.aborted) return live.promise;

    // eslint-disable-next-line no-param-reassign
    lastEventId ??= "-1";
    const tid = this.#threadId;
    if (!tid) return;
    this.#threadIdStreaming = tid;
    this.#threadRuns.set(runId, "running");

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
    const watch: RunWatch = {};
    let outcome: RunOutcome = "aborted";

    let releaseStream: (() => void) | undefined;
    const run: LiveRun = { promise: Promise.resolve() };
    this.#dropHeld();
    run.promise = this.stream.start(
      async (signal: AbortSignal) => {
        run.signal = signal;
        releaseStream = holdStream();
        if (own) this.#streamingRunId = runId;
        const mode = this.#options.scopedSubagents
          ? await this.#joinMode(tid, runId, runInfo, signal)
          : undefined;
        this.scopes.setRun(runId, mode);
        const rawStream = client.runs.joinStream(tid, runId, {
          signal,
          lastEventId,
          streamMode: joinOptions?.streamMode,
          checkpointId: joinOptions?.checkpointId,
          streamNamespaces: mode?.filtered ? [""] : undefined,
          ...this.#reconnectOptions(),
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
          outcome = "success";
          this.#runMetadataStorage?.removeItem(`lg:stream:${tid}`);
          return this.#finishRun(tid, shouldRefetchJoin, callbackMeta);
        },
        onError: (error) => {
          outcome = { error };
          this.#options.onError?.(error, callbackMeta);
        },
        onFinish: () => {
          this.#threadIdStreaming = null;
          releaseStream?.();
          this.scopes.endRun(runId);
          if (this.#streamingRunId === runId) this.#streamingRunId = undefined;
          this.#endRun(runId);
          void this.#reportRunEnd(tid, runId, watch, outcome);
          this.#drainQueue();
        },
        isReplaying: lastEventId === "-1",
        onEvent: (event, data) => {
          this.#watchEvent(watch, event, data);
          this.#channels.emit(event, data, watch.paused);
        },
      }
    );

    this.#liveRuns.set(runId, run);
    try {
      await run.promise;
    } finally {
      if (this.#liveRuns.get(runId) === run) this.#liveRuns.delete(runId);
    }
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

    // On the latest branch the cached head may be behind the server's
    // (the thread moved on since history was read); pinning it would
    // fork the thread.
    const viewingLatest =
      currentBranchContext.threadHead?.checkpoint?.checkpoint_id ===
      this.#history.data?.[0]?.checkpoint?.checkpoint_id;
    let checkpoint =
      submitOptions?.checkpoint ??
      (includeImplicitBranch && !viewingLatest
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
    let runId: string | undefined;
    let responded = false;

    const client = this.#accessors.getClient();
    const assistantId = this.#accessors.getAssistantId();

    let settleOwnRun: (runId?: string) => void = () => {};
    const ownRun = new Promise<string | undefined>((resolve) => {
      settleOwnRun = (id) => {
        resolve(id);
        if (this.#ownRun === ownRun) this.#ownRun = undefined;
      };
    });
    this.#ownRun = ownRun;
    const watch: RunWatch = {};
    let outcome: RunOutcome = "aborted";
    const input = this.#prepareInput(values);
    const optimistic =
      this.#options.optimistic !== false &&
      submitOptions?.optimisticValues == null
        ? input
        : undefined;
    const unsent = new Set(optimistic?.echoedIds);
    if (unsent.size > 0) this.#metadata.markPending(unsent);
    let shownKeys: OptimisticKeySnapshot[] = [];
    let sentValues = false;
    const stopRun = new AbortController();

    let releaseStream: (() => void) | undefined;
    this.#dropHeld();
    const started = this.stream.start(
      async (signal) => {
        releaseStream = holdStream();
        this.#stopOwnRun = stopRun;
        usableThreadId = this.#threadId;
        // Only the thread's load tells whether it exists yet.
        if (usableThreadId && this.#history.isLoading) await this.#hydration;
        // A stop or thread switch came meanwhile, so its input must not show.
        if (signal.aborted) return (async function* () {})();

        // Before any thread create, so a new chat's input shows at once.
        this.stream.setStreamValues(() => {
          const current = { ...this.historyValues, ...this.stream.values };
          shownKeys = snapshotKeys(current, optimistic);
          return runStartValues(
            current,
            optimistic,
            submitOptions?.optimisticValues,
            {
              get: (values) => this.#getMessages(values),
              set: (values, messages) => this.#setMessages(values, messages),
            }
          );
        });

        if (usableThreadId) {
          if (this.#missingThreads.has(usableThreadId)) {
            await this.#createMissingThread(
              usableThreadId,
              submitOptions?.metadata
            );
            if (signal.aborted) return (async function* () {})();
          }
          this.#threadIdStreaming = usableThreadId;
        }
        if (!usableThreadId) {
          const threadPromise = client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          // A failed create leaves no thread, so a submit made meanwhile
          // creates one itself.
          this.#threadIdPromise = threadPromise.then(
            (t) => t.thread_id,
            () => undefined
          );

          const thread = await threadPromise;

          usableThreadId = thread.thread_id;
          this.#setThreadIdFromSubmit(usableThreadId);
        }

        const modes = this.#getRunStreamModes(submitOptions);
        const streamMode = Array.isArray(modes) ? modes : await modes;
        const streamSubgraphs = this.#streamSubgraphs(submitOptions);
        // The run's stream carries the main conversation only when the run
        // tells which subagent is which (lifecycle) and publishes them.
        const filtered =
          this.#options.scopedSubagents === true &&
          streamSubgraphs === true &&
          streamMode.includes("lifecycle") &&
          (await this.#canFilter());
        // The 422 fallback goes without the filter.
        let rootFiltered = filtered;
        const streamResumable =
          submitOptions?.streamResumable ??
          (this.#durable || !!this.#runMetadataStorage);

        // Only the response names a run that outlives its request, so after a
        // stop between sending the request and its response, the request
        // stays open for onRunCreated to cancel the run. A stream stopped
        // before this point has sent nothing, and anything else closes the
        // request with the stream.
        const request = new AbortController();
        const closeRequest = () => {
          if (!stopRun.signal.aborted || runId != null || responded) {
            request.abort();
            return;
          }
          const timer = setTimeout(() => request.abort(), STOP_RUN_ID_WAIT_MS);
          request.signal.addEventListener("abort", () => clearTimeout(timer));
        };
        if (signal.aborted) request.abort();
        else signal.addEventListener("abort", closeRequest, { once: true });

        const runOptions: RunsStreamPayload<StreamMode[], boolean> = {
          input: (input?.dispatchInput ?? values) as Record<string, unknown>,
          config: withV1Streaming(
            submitOptions?.config,
            submitOptions?.context
          ),
          context: submitOptions?.context,
          command: submitOptions?.command,

          interruptBefore: submitOptions?.interruptBefore,
          interruptAfter: submitOptions?.interruptAfter,
          metadata: submitOptions?.metadata,
          multitaskStrategy: submitOptions?.multitaskStrategy,
          strictResume: submitOptions?.strictResume,
          onCompletion: submitOptions?.onCompletion,
          onDisconnect:
            submitOptions?.onDisconnect ??
            (streamResumable ? "continue" : "cancel"),

          signal: request.signal,

          checkpoint,
          streamSubgraphs,
          streamResumable,
          durability: submitOptions?.durability,
          ...this.#reconnectOptions(),
          onRunCreated: (params) => {
            if (stopRun.signal.aborted) {
              void client.runs
                .cancel(usableThreadId!, params.run_id)
                .catch(() => undefined);
              request.abort();
              return;
            }
            callbackMeta = {
              run_id: params.run_id,
              thread_id: params.thread_id ?? usableThreadId!,
            };
            runId = params.run_id;
            this.#liveRuns.set(runId, { promise: started, signal });
            this.#threadRuns.set(runId, "running");
            this.#streamingRunId = runId;
            settleOwnRun(runId);
            this.scopes.setRun(runId, {
              subgraphs: streamSubgraphs === true,
              filtered: rootFiltered,
            });

            if (this.#runMetadataStorage) {
              rejoinKey = `lg:stream:${usableThreadId}`;
              this.#runMetadataStorage.setItem(rejoinKey, callbackMeta.run_id);
            }

            this.#options.onCreated?.(callbackMeta);
          },
        };
        const runStream = (modes: StreamMode[], namespaces?: string[]) =>
          client.runs.stream(usableThreadId!, assistantId, {
            ...runOptions,
            streamMode: modes,
            streamNamespaces: namespaces,
          }) as AsyncGenerator<
            EventStreamEvent<StateType, UpdateType, CustomType>
          >;
        const fallback = withoutRunEventModes(streamMode);
        return fallback.length < streamMode.length
          ? retryUnprocessable(
              runStream(streamMode, filtered ? [""] : undefined),
              () => {
                rootFiltered = false;
                return runStream(fallback);
              }
            )
          : runStream(streamMode);
      },
      {
        getMessages: (value: StateType) => this.#getMessages(value),
        setMessages: (current: StateType, messages: Message[]) =>
          this.#setMessages(current, messages),
        initialValues: this.historyValues,
        callbacks: this.#options,

        onSuccess: async () => {
          outcome = "success";
          if (rejoinKey) this.#runMetadataStorage?.removeItem(rejoinKey);
          return this.#finishRun(usableThreadId, shouldRefetch, callbackMeta);
        },
        onError: (error) => {
          outcome = { error };
          this.#options.onError?.(error, callbackMeta);
          submitOptions?.onError?.(error, callbackMeta);
        },
        onFinish: () => {
          this.#threadIdStreaming = null;
          releaseStream?.();
          settleOwnRun();
          this.#unhide(submitOptions?.command);
          // A run that ends before its values hold a message almost always
          // ended before saving its input.
          this.#metadata.resolvePending(
            unsent,
            outcome === "success" ? "sent" : "failed"
          );
          // Keys the input showed stay only if the run's values held them. A
          // stop leaves them to its read of the thread.
          if (outcome !== "aborted" && !sentValues && shownKeys.length > 0) {
            this.stream.setStreamValues(
              (values) => values && restoreKeys(values, shownKeys)
            );
          }
          if (this.#stopOwnRun === stopRun) this.#stopOwnRun = undefined;
          if (runId == null) return;
          this.scopes.endRun(runId);
          if (this.#streamingRunId === runId) this.#streamingRunId = undefined;
          this.#endRun(runId);
          void this.#reportRunEnd(usableThreadId, runId, watch, outcome);
        },
        onEvent: (event, data) => {
          // The run exists once it streams, even when no response header
          // named it.
          responded = true;
          settleOwnRun();
          this.#watchEvent(watch, event, data);
          this.#channels.emit(event, data, watch.paused);
          if (event === "values") sentValues = true;
          if (event === "values" && unsent.size > 0) {
            const saved = this.#getMessages((data ?? {}) as StateType).flatMap(
              ({ id }) => (id != null && unsent.delete(id) ? [id] : [])
            );
            this.#metadata.resolvePending(saved, "sent");
          }
        },
      },
      {
        abortPrevious:
          (submitOptions?.multitaskStrategy === "interrupt" ||
            submitOptions?.multitaskStrategy === "rollback") &&
          this.stream.isLoading,
      }
    );

    return started.finally(() => {
      if (runId && this.#liveRuns.get(runId)?.promise === started) {
        this.#liveRuns.delete(runId);
      }
    });
  }

  /**
   * The input with an id on every message, also when it isn't shown at once,
   * since the fork points are found by the ids the run's steps wrote.
   */
  #prepareInput(values: StateType | null | undefined) {
    return prepareSubmitInput(values, this.#accessors.getMessagesKey());
  }

  /**
   * Creates a thread a read found missing, with its id, before the first run
   * on it, so the app's `threads.create` auth handler runs. If it exists by
   * now, such as when another tab created it, the server returns it when
   * this user's auth can read it, and refuses it otherwise.
   */
  async #createMissingThread(
    threadId: string,
    metadata: Metadata | undefined
  ): Promise<void> {
    await this.#accessors
      .getClient()
      .threads.create({ threadId, metadata, ifExists: "do_nothing" });
    this.#threadFound(threadId);
  }

  /** A create can land after a switch, so only the current thread is marked. */
  #threadFound(threadId: string): void {
    this.#missingThreads.delete(threadId);
    if (threadId === this.#threadId) this.#threadExists = threadId;
  }

  /**
   * A submit's own `streamMode` goes as it is. `lifecycle`, asked for when
   * subagents are tracked, and `tools`, asked for by `onToolEvent`, go only
   * to servers that send them on run routes, as do tracked ones. Runs that
   * ask for neither get their modes without waiting for `/info`.
   */
  #getRunStreamModes(
    submitOptions?: SubmitOptions<StateType, GetConfigurableType<Bag>>
  ): StreamMode[] | Promise<StreamMode[]> {
    const tracked = unique([
      ...this.#trackedStreamModes,
      ...(this.#options.filterSubagentMessages
        ? (["lifecycle"] as StreamMode[])
        : []),
      ...(this.#options.onToolEvent != null ? (["tools"] as StreamMode[]) : []),
    ]);
    const modes = (sent: StreamMode[]) =>
      unique([
        "values" as StreamMode,
        "updates" as StreamMode,
        ...(submitOptions?.streamMode ?? []),
        ...sent,
        ...this.#callbackStreamModes,
      ]);
    const plain = withoutRunEventModes(tracked);
    if (plain.length === tracked.length) return modes(tracked);
    return serverInfo(this.#accessors.getClient()).then((info) =>
      modes(info?.flags?.stream_lifecycle === true ? tracked : plain)
    );
  }

  #drainQueue(): void {
    if (
      !this.#disposed &&
      !this.isLoading &&
      !this.#submitting &&
      this.pendingRuns.size > 0
    ) {
      const next = this.pendingRuns.shift();
      if (next) {
        this.#submitting = true;
        const sent =
          this.#options.queue === "local"
            ? this.submitDirect(next.values as StateType, next.options)
            : this.#join(
                next.id,
                undefined,
                undefined,
                true,
                this.#listedRuns.get(next.id)
              ).finally(() => this.#unhide(next.options?.command));
        void sent.finally(() => {
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
   * replaced). An explicit `"reject"` is forwarded to the server, which
   * rejects the run while another is in flight. The error is reported via
   * `onError`. Queued runs are drained sequentially via {@link drainQueue}.
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

      if (
        this.#options.queue === "local" &&
        submitOptions?.multitaskStrategy !== "reject"
      ) {
        this.pendingRuns.add({
          id: uuidv7(),
          values: values as Partial<StateType> | null | undefined,
          options: submitOptions,
          createdAt: new Date(),
        });
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
          // Sent before the run being submitted reaches the server, it would
          // run first.
          if (this.#ownRun) await this.#ownRun;
          const streamMode = await this.#getRunStreamModes(submitOptions);
          const input = (this.#prepareInput(values)?.dispatchInput ??
            values) as Record<string, unknown>;
          const create = (modes: StreamMode[]) =>
            client.runs.create(usableThreadId!, assistantId, {
              input,
              config: withV1Streaming(
                submitOptions?.config,
                submitOptions?.context
              ),
              context: submitOptions?.context,
              command: submitOptions?.command,
              interruptBefore: submitOptions?.interruptBefore,
              interruptAfter: submitOptions?.interruptAfter,
              metadata: submitOptions?.metadata,
              multitaskStrategy: submitOptions?.multitaskStrategy ?? "enqueue",
              strictResume: submitOptions?.strictResume,
              streamMode: modes,
              streamResumable: true,
              streamSubgraphs: this.#streamSubgraphs(submitOptions),
              durability: submitOptions?.durability,
            });
          const fallback = withoutRunEventModes(streamMode);
          const run = await create(streamMode).catch((error: unknown) => {
            if (
              !isUnprocessable(error) ||
              fallback.length === streamMode.length
            ) {
              throw error;
            }
            return create(fallback);
          });

          this.pendingRuns.add({
            id: run.run_id,
            values: values as Partial<StateType> | null | undefined,
            options: submitOptions,
            createdAt: new Date(run.created_at),
          });
        } catch (error) {
          this.#unhide(submitOptions?.command);
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
   * Answer one interrupt: `options.interruptId`, or the first one shown
   * that isn't answered yet, once a thread load has looked for a run still
   * going. See {@link respondAll}.
   */
  async respond(
    value: unknown,
    options: RespondOptions<GetConfigurableType<Bag>> & {
      interruptId?: string;
    } = {}
  ): Promise<void> {
    const threadId = this.#threadId;
    if (threadId == null) {
      throw new Error("No active thread to respond to.");
    }
    while (options.interruptId == null && this.#unconfirmedHead()) {
      await this.#hydration;
      if (this.#disposed || this.#threadId !== threadId) {
        throw new Error(
          "The thread closed or changed while respond() waited for its interrupt."
        );
      }
    }
    const interruptId =
      options.interruptId ??
      this.interrupts.find((interrupt) => interrupt.id != null)?.id;
    if (interruptId == null) {
      throw new Error("No pending interrupt to respond to.");
    }
    return this.respondAll({ [interruptId]: value }, options);
  }

  /**
   * Answer interrupts by id, in one run. It starts at once when nothing
   * streams, or waits in the queue behind the run in flight, never
   * interrupting it. The answered interrupts are hidden until that run
   * ends. Resolves once the run is created or queued, and rejects when it
   * can't be sent. Unless `strictResume` is `false`, an answer to an
   * interrupt that is no longer waiting fails its run instead of running
   * the step again, and the interrupt shows again.
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
    const queued = this.stream.isLoading || this.#submitting;
    const sent = this.submit(null as unknown as StateType, {
      command: resumeCommand(
        responses,
        options,
        this.#accessors.getMessagesKey()
      ),
      config: options.config,
      metadata: options.metadata,
      strictResume: options.strictResume ?? true,
      multitaskStrategy: "enqueue",
      onError: (error) => {
        failed ??= { error };
      },
    });
    const created = queued ? sent : this.#ownRun;
    if ((await created) == null && failed != null) throw failed.error;
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
      this.#clearThreadState();
      // A listed run may be another client's, so only cancelQueueItem() or
      // clearQueue() cancels it.
      const queued = this.pendingRuns
        .removeAll()
        .filter((entry) => !this.#listedRuns.has(entry.id));
      this.#listedRuns.clear();
      void this.#dropQueued(prevThreadId, queued);

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
        void this.#join(runId, undefined, undefined, true);
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
    clearTimeout(this.#pendingDispose);
    this.#disposed = true;
    this.scopes.dispose();
    globalThis.document?.removeEventListener(
      "visibilitychange",
      this.#onVisibilityChange
    );
    this.#syncWatcher();
    this.#streamUnsub?.();
    this.#queueUnsub?.();
    this.#streamUnsub = null;
    this.#queueUnsub = null;
    void this.stop({ cancel: false }).catch(() => undefined);
  }

  /**
   * StrictMode-safe lifecycle for framework bindings: call it from the bind
   * site's effect and return the result as the effect's cleanup. The
   * returned release disposes on the next macrotask, unless another
   * `activate()` comes first, as on StrictMode's remount. The thread watcher
   * (`watchThread`) runs only between the first `activate()` and dispose.
   *
   * An engine that loads threads needs it: a load before the first
   * `activate()` reads the thread and holds what it finds until then, the
   * running run's join, the head's headless tool calls and the server's
   * queued runs. A running run held this way counts as {@link isLoading}, so
   * the queue waits for it too. A stream the engine starts first, such as a
   * submit from an effect that runs before the bind site's, drops what the
   * load held.
   */
  activate(): () => void {
    clearTimeout(this.#pendingDispose);
    if (!this.#active) {
      this.#active = true;
      globalThis.document?.addEventListener(
        "visibilitychange",
        this.#onVisibilityChange
      );
      if (
        this.#options.filterSubagentMessages ||
        this.#options.scopedSubagents ||
        this.#options.onToolEvent != null
      ) {
        // Read ahead of the first run, which needs it to pick stream modes.
        void serverInfo(this.#accessors.getClient());
      }
      this.#syncWatcher();
      const join = this.#heldJoin;
      const tools = this.#heldTools;
      this.#dropHeld();
      // The run answers the head's calls, and the queue drains when it ends.
      if (join != null) {
        join();
      } else {
        if (tools != null) this.#flushHeadToolCalls(tools);
        this.#drainQueue();
      }
    }
    return () => {
      if (this.#disposed) return;
      this.#pendingDispose = setTimeout(() => this.dispose(), 0);
    };
  }

  /**
   * Load a thread. Another thread is switched to, as with
   * {@link switchThread}. The current one is read again, and when no run
   * streams, the read replaces values left from earlier streams. Unless
   * `durableRuns` is `false`, the thread's running run is joined after the
   * read.
   *
   * @returns {@link hydrationPromise}.
   */
  hydrate(threadId: string | null = this.#threadId ?? null): Promise<void> {
    if ((threadId ?? undefined) !== this.#threadId) {
      this.switchThread(threadId);
    } else if (threadId != null) {
      this.#startLoad(this.#reload(threadId, {}, true));
    }
    return this.#hydration;
  }

  /**
   * Opens the thread watcher when it should run and closes it when it
   * shouldn't, on every state change.
   */
  #syncWatcher(): void {
    const threadId = this.#threadId;
    const wanted =
      this.#active &&
      !this.#disposed &&
      this.#options.watchThread !== false &&
      !this.#watchOff &&
      threadId != null &&
      threadId === this.#threadExists &&
      threadId !== this.#watchRefused &&
      !this.isLoading &&
      this.pendingRuns.size === 0 &&
      globalThis.document?.visibilityState !== "hidden";
    if (this.#watch != null && (!wanted || this.#watch.threadId !== threadId)) {
      this.#watch.controller.abort();
      this.#watch = undefined;
    }
    if (!wanted || this.#watch != null) return;

    const watch = { threadId, controller: new AbortController() };
    this.#watch = watch;
    const releaseStream = holdStream();
    void followThread(
      this.#accessors.getClient(),
      threadId,
      this.#watchCursor,
      (event, data) => this.#onThreadEvent(threadId, event, data),
      watch.controller.signal
    ).then((end) => {
      releaseStream();
      if (end === "unsupported") this.#watchOff = true;
      if (end === "refused") this.#watchRefused = threadId;
      // A failed watcher keeps its place, so it opens again only after the
      // next pause, not on the next state change.
      if (end !== "failed" && this.#watch === watch) this.#watch = undefined;
    });
  }

  #onThreadEvent(threadId: string, event: string, data: unknown): void {
    if (threadId !== this.#threadId) return;
    if (event === "gap") {
      // A load still looking for its run keeps the head in doubt until both
      // end, also when the gap's read fails and looks for none.
      this.#startLoad(
        Promise.all([
          this.#hydration,
          this.#reload(threadId, { quiet: true }, true),
        ]).then(() => undefined)
      );
      return;
    }
    const {
      run_id: runId,
      status,
      answered,
    } = (data ?? {}) as {
      run_id?: unknown;
      status?: unknown;
      answered?: unknown;
    };
    if (typeof runId !== "string") return;
    const seen = this.#threadRuns.get(runId);

    if (event === "interrupts") {
      // A replay can bring the answers of a run that ended since.
      if (seen === "ended" || !Array.isArray(answered)) return;
      const ids = answered.filter((id): id is string => typeof id === "string");
      this.#answeredBy.set(runId, ids);
      for (const id of ids) this.#answered.add(id);
      this.#notify();
      return;
    }
    if (event !== "metadata") return;

    if (status === "run_done") {
      const streamed = seen === "ended" || this.#liveRuns.has(runId);
      this.#endRun(runId);
      if (!streamed) void this.#reload(threadId, { quiet: true });
      return;
    }
    if (seen != null) return;
    this.#threadRuns.set(runId, "running");
    void this.#accessors
      .getClient()
      .runs.get(threadId, runId)
      // Unknown, the run shows when its end reads the state.
      .catch(() => undefined)
      .then((run) => {
        if (
          run == null ||
          threadId !== this.#threadId ||
          this.#threadRuns.get(runId) !== "running"
        ) {
          return;
        }
        if (run.status !== "pending" && run.status !== "running") {
          this.#endRun(runId);
          void this.#reload(threadId, { quiet: true });
          return;
        }
        const head = this.#history.data?.at(0)?.checkpoint?.checkpoint_id;
        void this.#join(
          runId,
          "-1",
          { checkpointId: head ?? undefined },
          true,
          run
        );
      });
  }

  /** Marks a run ended and shows again what it answered elsewhere. */
  #endRun(runId: string): void {
    this.#threadRuns.set(runId, "ended");
    const ids = this.#answeredBy.get(runId);
    if (ids == null) return;
    this.#answeredBy.delete(runId);
    for (const id of ids) this.#answered.delete(id);
    this.#notify();
  }

  /**
   * Settles once the latest thread load is done: its state read and, unless
   * `durableRuns` is `false`, the running run's lookup. It never rejects: a
   * failed read sets {@link error}.
   */
  get hydrationPromise(): Promise<void> {
    return this.#hydration;
  }

  /** Scoped subagents need their runs to publish subagent events. */
  #streamSubgraphs(
    submitOptions?: SubmitOptions<StateType, GetConfigurableType<Bag>>
  ): boolean | undefined {
    return (
      submitOptions?.streamSubgraphs ??
      (this.#options.scopedSubagents ? true : undefined)
    );
  }

  async #canFilter(): Promise<boolean> {
    const info = await serverInfo(this.#accessors.getClient());
    return info?.flags?.stream_namespaces === true;
  }

  /**
   * How a joined run streams, from its own options: subgraphs (so panels have
   * events to join) and lifecycle events (so the main conversation knows its
   * subagents). Only with both, on a server with both flags, does its stream
   * carry the main conversation alone.
   */
  async #joinMode(
    threadId: string,
    runId: string,
    runInfo: Run | undefined,
    signal: AbortSignal
  ): Promise<{ filtered: boolean; subgraphs?: boolean }> {
    const info = await serverInfo(this.#accessors.getClient());
    if (
      info?.flags?.stream_namespaces !== true ||
      info.flags.stream_lifecycle !== true
    ) {
      return { filtered: false };
    }
    const kwargs = (
      runInfo ??
      (await this.#accessors
        .getClient()
        .runs.get(threadId, runId, { signal })
        .catch(() => undefined))
    )?.kwargs;
    if (kwargs == null) return { filtered: false };
    const modes = kwargs.stream_mode;
    const subgraphs = kwargs.subgraphs === true;
    const lifecycle = Array.isArray(modes)
      ? modes.includes("lifecycle")
      : modes === "lifecycle";
    return { filtered: subgraphs && lifecycle, subgraphs };
  }

  #reconnectOptions() {
    const {
      maxReconnectAttempts,
      reconnectDelayMs,
      onReconnect,
      onConnected,
      streamIdleReconnect,
    } = this.#options;
    return {
      maxReconnectAttempts,
      reconnectDelayMs,
      onReconnect,
      onConnected,
      streamIdleReconnect,
    };
  }

  async #reportRunEnd(
    threadId: string | undefined,
    runId: string,
    watch: RunWatch,
    outcome: RunOutcome
  ): Promise<void> {
    const { onRunEnd } = this.#options;
    const epoch = this.stream.epoch;
    if (threadId == null) return;
    if (onRunEnd == null && !this.stream.hasOpenSubagents()) return;
    let reason: RunEndReason;
    // Whether the server said how the run ended, not only that this client
    // stopped its stream or lost the connection while the run went on.
    let ended = true;
    if (outcome === "aborted") {
      reason = "stopped";
      ended = false;
    } else if (outcome !== "success") {
      const { name } = outcome.error as { name?: unknown };
      reason =
        name === "UserInterrupt" || name === "UserRollback"
          ? "stopped"
          : "error";
      // eslint-disable-next-line no-instanceof/no-instanceof
      ended = outcome.error instanceof StreamError;
    } else {
      // Servers that send no `end` event leave the run's status to a read.
      // A rolled back run is deleted.
      const status =
        watch.status ??
        (await this.#accessors
          .getClient()
          .runs.get(threadId, runId)
          .then(
            (run) => run.status,
            (error) =>
              (error as { status?: unknown })?.status === 404
                ? "rollback"
                : "success"
          ));
      if (status === "success") {
        reason = watch.paused ? "interrupt" : "success";
      } else if (status === "interrupted" || status === "rollback") {
        reason = "stopped";
      } else {
        reason = "error";
      }
    }
    // Subagents the run left open take its word, unless another stream began.
    if (
      ended &&
      (reason === "error" || reason === "stopped") &&
      this.stream.epoch === epoch
    ) {
      this.stream.closeOpenSubagents(`The run ended: ${reason}`);
    }
    if (!this.#disposed) onRunEnd?.({ runId, reason });
  }

  #flushHeadToolCalls(head: ThreadState<StateType> | undefined): void {
    // Thread state values never carry `__interrupt__`; a pending call is in
    // the head's tasks.
    this.#flushPendingHeadlessToolInterrupts({
      __interrupt__: head?.tasks?.flatMap((task) => task.interrupts ?? []),
    });
  }

  #flushPendingHeadlessToolInterrupts(
    values: Record<string, unknown> | null | undefined
  ): void {
    const threadId = this.#threadId;
    flushPendingHeadlessToolInterrupts(
      values,
      this.#options.tools,
      this.#handledHeadlessToolInterruptIds,
      {
        onTool: this.#options.onTool,
        defer: (run) => {
          void Promise.resolve().then(run);
        },
        resumeSubmit: (command) => {
          // submit() resumes the current thread. The call stays pending on its
          // own thread and runs again when that thread is read.
          if (threadId !== this.#threadId) return;
          void this.submit(null as unknown as StateType, {
            multitaskStrategy: "interrupt",
            command,
          });
        },
      }
    );
  }
}
