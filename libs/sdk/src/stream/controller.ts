/**
 * Framework-agnostic controller for the experimental v2 stream.
 *
 * Responsibilities:
 *  - Owns at most one {@link ThreadStream} at a time (swapped on
 *    `hydrate(newThreadId)` or `dispose`).
 *  - Exposes three always-on observable surfaces via {@link StreamStore}:
 *      - `rootStore`      : root values/messages/toolCalls/interrupts/…
 *      - `subagentStore`  : discovery map of subagents (no content)
 *      - `subgraphStore`  : discovery map of subgraphs  (no content)
 *  - Owns a {@link ChannelRegistry} that framework selector hooks
 *    (`useMessages`, `useToolCalls`, `useExtension`, `useChannel`)
 *    use to lazily open per-namespace subscriptions.
 *  - Imperative run surface: `submit`, `stop`, `respond`, `joinStream`.
 *
 * A single multi-channel subscription (`values`, `lifecycle`, `input`,
 * `messages`, `tools`) powers every always-on projection and both
 * discovery runners. Selector hooks add their own (deduped)
 * subscriptions on top — so even a UI with many subagents only opens
 * one extra subscription per `(channels, namespace)` actually
 * rendered on screen.
 */
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  Channel,
  Event,
  LifecycleEvent,
  MessagesEvent,
  ToolsEvent,
  ValuesEvent,
} from "@langchain/protocol";
import type { Interrupt } from "../schema.js";
import type { ThreadStream } from "../client/stream/index.js";
import type { SubscriptionHandle } from "../client/stream/index.js";
import { ToolCallAssembler } from "../client/stream/handles/tools.js";
import { ensureMessageInstances } from "../ui/messages.js";
import type { Message } from "../types.messages.js";
import { StreamStore } from "./store.js";
import { ChannelRegistry } from "./channel-registry.js";
import {
  SubagentDiscovery,
  type SubagentMap,
  SubgraphDiscovery,
  type SubgraphMap,
  type SubgraphByNodeMap,
} from "./discovery/index.js";
import {
  isInternalWorkNamespace,
  isLegacySubagentNamespace,
  isRootNamespace,
} from "./namespace.js";
import {
  MessageMetadataTracker,
  type CheckpointEnvelope,
  type MessageMetadata,
  type MessageMetadataMap,
} from "./message-metadata-tracker.js";
import { LifecycleLoadingTracker } from "./lifecycle-loading-tracker.js";
import { RootMessageProjection } from "./root-message-projection.js";
import {
  EMPTY_QUEUE,
  SubmitCoordinator,
  type SubmissionQueueEntry,
  type SubmissionQueueSnapshot,
} from "./submit-coordinator.js";
import { upsertToolCall } from "./tool-calls.js";
import type {
  RootEventBus,
  RootSnapshot,
  StreamControllerOptions,
  StreamSubmitOptions,
} from "./types.js";

function isAbortLikeError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const maybeError = error as { name?: unknown; message?: unknown };
  return (
    maybeError.name === "AbortError" ||
    (typeof maybeError.message === "string" &&
      maybeError.message.includes("aborted"))
  );
}

const ROOT_NAMESPACE: readonly string[] = [];

/**
 * Channel set covered by the always-on root subscription. Exported so
 * projections (and transports) can reason about what the root pump
 * already delivers before opening additional server subscriptions.
 */
export const ROOT_PUMP_CHANNELS: readonly Channel[] = [
  "values",
  "checkpoints",
  "lifecycle",
  "input",
  "messages",
  "tools",
];

interface ResolvedInterrupt {
  interruptId: string;
  namespace: string[];
}

export type {
  MessageMetadata,
  MessageMetadataMap,
  SubmissionQueueEntry,
  SubmissionQueueSnapshot,
};

/**
 * Coordinates one thread's protocol-v2 stream and exposes stable
 * observable projections for framework bindings.
 *
 * The controller owns the root subscription, lazily binds scoped
 * projections through {@link ChannelRegistry}, and normalizes protocol
 * events into class-message, tool-call, discovery, interrupt, and queue
 * stores.
 *
 * @typeParam StateType - Shape of the graph state exposed on `values`.
 * @typeParam InterruptType - Shape of protocol interrupt payloads.
 * @typeParam ConfigurableType - Shape of `config.configurable` accepted by submit.
 */
export class StreamController<
  StateType extends object = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> {
  readonly rootStore: StreamStore<RootSnapshot<StateType, InterruptType>>;
  readonly subagentStore: StreamStore<SubagentMap>;
  readonly subgraphStore: StreamStore<SubgraphMap>;
  readonly subgraphByNodeStore: StreamStore<SubgraphByNodeMap>;
  readonly messageMetadataStore: StreamStore<MessageMetadataMap>;
  readonly queueStore: StreamStore<SubmissionQueueSnapshot<StateType>>;
  readonly registry: ChannelRegistry;

  readonly #options: StreamControllerOptions<StateType>;
  readonly #messagesKey: string;
  readonly #subagents = new SubagentDiscovery();
  readonly #subgraphs = new SubgraphDiscovery();
  readonly #messageMetadata = new MessageMetadataTracker();

  #thread: ThreadStream | undefined;
  #currentThreadId: string | null;
  #rootSubscription: SubscriptionHandle<Event> | undefined;
  #rootPump: Promise<void> | undefined;
  #rootPumpReady: Promise<void> | undefined;
  #threadEventUnsubscribe: (() => void) | undefined;
  #disposed = false;
  #pendingDisposeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #resolvedInterrupts = new Set<string>();
  /**
   * Thread ids we minted client-side on first `submit()`. Keeping them
   * here lets `hydrate()` skip the `threads.getState()` round-trip —
   * we know there is nothing checkpointed server-side yet (and the
   * request would 404 and surface a spurious error to the UI).
   */
  readonly #selfCreatedThreadIds = new Set<string>();
  readonly #rootEventListeners = new Set<(event: Event) => void>();
  readonly #rootBus: RootEventBus;

  /**
   * Single-shot hydration promise. Exposed via `hydrationPromise`
   * so Suspense wrappers can throw it until the first hydrate
   * completes (resolve) or fails (reject). Reset whenever a new
   * hydrate cycle begins so `<Suspense>` boundaries re-suspend on
   * thread switch.
   */
  #hydrationPromise: Promise<void>;
  #resolveHydration!: () => void;
  #rejectHydration!: (error: unknown) => void;

  /**
   * Tool assembler lives for the lifetime of a thread; reset on
   * rebind so a fresh thread starts with a clean slate.
   */
  #rootToolAssembler = new ToolCallAssembler();
  #rootMessages!: RootMessageProjection<StateType, InterruptType>;
  #lifecycleLoading!: LifecycleLoadingTracker<
    RootSnapshot<StateType, InterruptType>
  >;
  #submitter!: SubmitCoordinator<StateType, InterruptType, ConfigurableType>;

  readonly #threadListeners = new Set<
    (thread: ThreadStream | undefined) => void
  >();

  /**
   * Create a controller around a LangGraph client and optional initial thread.
   *
   * @param options - Runtime configuration, client, thread id, and initial state.
   */
  constructor(options: StreamControllerOptions<StateType>) {
    this.#options = options;
    this.#messagesKey = options.messagesKey ?? "messages";
    this.#currentThreadId = options.threadId ?? null;
    this.#rootBus = {
      channels: ROOT_PUMP_CHANNELS,
      subscribe: (listener) => {
        this.#rootEventListeners.add(listener);
        return () => {
          this.#rootEventListeners.delete(listener);
        };
      },
    };
    this.registry = new ChannelRegistry(this.#rootBus);
    this.subagentStore = this.#subagents.store;
    this.subgraphStore = this.#subgraphs.store;
    this.subgraphByNodeStore = this.#subgraphs.byNodeStore;
    this.rootStore = new StreamStore<RootSnapshot<StateType, InterruptType>>(
      this.#createInitialSnapshot()
    );
    this.#rootMessages = new RootMessageProjection({
      messagesKey: this.#messagesKey,
      store: this.rootStore,
      subagents: this.#subagents,
    });
    this.#lifecycleLoading = new LifecycleLoadingTracker({
      store: this.rootStore,
      isDisposed: () => this.#disposed,
    });
    this.messageMetadataStore = this.#messageMetadata.store;
    this.queueStore = new StreamStore<SubmissionQueueSnapshot<StateType>>(
      EMPTY_QUEUE as SubmissionQueueSnapshot<StateType>
    );
    this.#submitter = new SubmitCoordinator({
      options: this.#options,
      rootStore: this.rootStore,
      queueStore: this.queueStore,
      getDisposed: () => this.#disposed,
      getCurrentThreadId: () => this.#currentThreadId,
      setCurrentThreadId: (threadId) => {
        this.#currentThreadId = threadId;
      },
      rememberSelfCreatedThreadId: (threadId) => {
        this.#selfCreatedThreadIds.add(threadId);
      },
      hydrate: (threadId) => this.hydrate(threadId),
      ensureThread: (threadId) => this.#ensureThread(threadId),
      waitForRootPumpReady: () => this.#rootPumpReady,
      awaitNextTerminal: (signal) => this.#awaitNextTerminal(signal),
      latestUnresolvedInterrupt: () => this.#latestUnresolvedInterrupt(),
      markInterruptResolved: (interruptId) => {
        this.#resolvedInterrupts.add(interruptId);
      },
    });
    this.#hydrationPromise = this.#createHydrationPromise();
    /**
     * Attach a default no-op catch so orphaned hydrationPromise
     * rejections (e.g. controllers spawned during Suspense retries
     * whose promise never gets subscribed to because the suspense
     * cache already holds an earlier one) don't surface as unhandled
     * rejections. Callers that attach their own handlers via .then()
     * still receive the rejection on their derived promise.
     */
    this.#hydrationPromise.catch(() => undefined);
    /**
     * Kick off the initial hydrate eagerly when a caller-supplied
     * thread id is present. Suspense consumers throw
     * `hydrationPromise` on the very first render, which unmounts the
     * subtree before any `useEffect` can run — so if we waited for an
     * effect to drive the hydrate we'd deadlock. Firing here makes
     * the promise settle independently of the component lifecycle.
     */
    if (this.#currentThreadId != null) {
      void this.hydrate(this.#currentThreadId);
    } else {
      this.#resolveHydration();
    }
  }

  /**
   * Promise that settles the first time {@link hydrate} finishes on
   * the current thread. Resolves on a clean hydration, rejects when
   * the thread-state fetch errors. A fresh promise is installed on
   * every thread swap so `<Suspense>` wrappers re-suspend on
   * `switchThread`.
   */
  get hydrationPromise(): Promise<void> {
    return this.#hydrationPromise;
  }

  /**
   * Create the deferred promise backing the current hydration cycle.
   */
  #createHydrationPromise(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#resolveHydration = resolve;
      this.#rejectHydration = reject;
    });
  }

  /**
   * Replace the current hydration promise before a thread swap.
   */
  #resetHydrationPromise(): void {
    /**
     * Swallow rejection on the orphaned promise so Node doesn't
     * flag it as unhandled; Suspense callers that still hold a
     * reference see the rejection they subscribed to.
     */
    this.#hydrationPromise.catch(() => undefined);
    this.#hydrationPromise = this.#createHydrationPromise();
  }

  // ---------- public imperatives ----------

  /**
   * Fetch the checkpointed thread state and seed the root snapshot.
   * Re-calling with a different `threadId` swaps the underlying
   * {@link ThreadStream}, rewires the registry to the new thread, and
   * resets assemblers.
   *
   * @param threadId - Optional replacement thread id; `null` clears the active thread.
   */
  async hydrate(threadId?: string | null): Promise<void> {
    if (this.#disposed) return;
    const target = threadId === undefined ? this.#currentThreadId : threadId;
    const changed = target !== this.#currentThreadId;
    this.#currentThreadId = target ?? null;
    this.rootStore.setState((s) => ({ ...s, threadId: this.#currentThreadId }));

    if (changed) {
      /**
       * Swap to a new thread: re-arm the hydration promise so any
       * Suspense boundary remounted against the new id suspends again.
       */
      this.#resetHydrationPromise();
      await this.#teardownThread();
      /**
       * Reset UI-facing snapshot so stale messages/values/tool-calls
       * from the previous thread don't bleed into the new one. The
       * new thread's state (if any) is then populated below via
       * `#applyValues`.
       */
      this.rootStore.setState(() => ({
        ...this.#createInitialSnapshot(),
        threadId: this.#currentThreadId,
      }));
      /**
       * Drop queued submissions — they were targeted at the previous
       * thread so dispatching them against the new thread would be
       * surprising. Mirrors the legacy `StreamOrchestrator` behaviour.
       */
      this.queueStore.setState(
        () => EMPTY_QUEUE as SubmissionQueueSnapshot<StateType>
      );
    }

    if (this.#currentThreadId == null) {
      this.rootStore.setState((s) => ({ ...s, isThreadLoading: false }));
      this.#resolveHydration();
      return;
    }

    /**
     * Self-generated thread ids have nothing to fetch server-side yet
     * — the thread is created lazily by the first `run.start`. Calling
     * `threads.getState()` here would return a 404 and surface a
     * spurious error to the UI.
     */
    if (this.#selfCreatedThreadIds.has(this.#currentThreadId)) {
      this.rootStore.setState((s) => ({ ...s, isThreadLoading: false }));
      this.#resolveHydration();
      return;
    }

    this.rootStore.setState((s) => ({ ...s, isThreadLoading: true }));
    let hydrationError: unknown;
    try {
      const state = await this.#options.client.threads.getState<StateType>(
        this.#currentThreadId
      );
      if (state?.values != null) {
        /**
         * `threads.getState()` returns the legacy `ThreadState` shape
         * where `parent_checkpoint` is an object (`{ thread_id,
         * checkpoint_id, checkpoint_ns }`). Synthesize the v2
         * `Checkpoint` envelope (matching the `checkpoints` channel
         * payload) so hydrated messages also get their
         * `parentCheckpointId` populated for fork / edit flows.
         */
        const checkpointId = state.checkpoint?.checkpoint_id;
        const parentCheckpointId =
          state.parent_checkpoint?.checkpoint_id ?? undefined;
        const syntheticCheckpoint =
          typeof checkpointId === "string"
            ? {
                id: checkpointId,
                ...(parentCheckpointId != null
                  ? { parent_id: parentCheckpointId }
                  : {}),
              }
            : undefined;
        this.#applyValues(state.values as unknown, syntheticCheckpoint);
      }
    } catch (error) {
      /**
       * A 404 on hydrate means the thread does not exist server-side
       * yet (most commonly because the caller supplied a brand-new,
       * externally-minted thread id and is about to create it via the
       * first `submit()`). Treat it as "empty state" rather than a
       * fatal hydration error so Suspense boundaries resolve cleanly
       * and no spurious error renders in the UI.
       */
      const status = (error as { status?: number } | null)?.status;
      if (status !== 404) {
        hydrationError = error;
        this.rootStore.setState((s) => ({ ...s, error }));
      }
    } finally {
      this.rootStore.setState((s) => ({ ...s, isThreadLoading: false }));
      if (hydrationError != null) {
        this.#rejectHydration(hydrationError);
      } else {
        this.#resolveHydration();
      }
    }

    /**
     * P0 fix: open the shared subscription on mount so in-flight
     * server-side runs are observed even when no local `submit()` is
     * active. The transport replays the run from `seq=0` on a rotating
     * subscribe, so late-joining is free once the subscription exists.
     * `isLoading` transitions are driven by the persistent root
     * lifecycle listener registered in `#startRootPump`.
     */
    this.#ensureThread(this.#currentThreadId);
  }

  /**
   * Submit input or a resume command to the active thread.
   *
   * @param input - Input payload for a new run; `null`/`undefined` submits no input.
   * @param options - Per-run config, metadata, multitask behavior, and callbacks.
   */
  async submit(
    input: unknown,
    options?: StreamSubmitOptions<StateType, ConfigurableType>
  ): Promise<void> {
    await this.#submitter.submit(input, options);
  }

  /**
   * Abort the currently tracked run and mark the controller idle.
   */
  async stop(): Promise<void> {
    await this.#submitter.stop();
  }

  /**
   * Cancel a queued submission by id. Returns `true` when the entry
   * was found and removed, `false` otherwise.
   *
   * Today this only removes the entry from the client-side mirror —
   * once the server exposes queue cancel (roadmap A0.3) the
   * controller will additionally issue a cancel call against the
   * active transport.
   *
   * @param id - Client-side queue entry id to remove.
   */
  async cancelQueued(id: string): Promise<boolean> {
    return this.#submitter.cancelQueued(id);
  }

  /**
   * Drop every queued submission. Server-side cancel arrives with A0.3.
   */
  async clearQueue(): Promise<void> {
    await this.#submitter.clearQueue();
  }

  /**
   * Respond to a pending protocol interrupt.
   *
   * @param response - Payload to send back to the interrupted namespace.
   * @param target - Optional explicit interrupt id and namespace; defaults to the latest unresolved interrupt.
   */
  async respond(
    response: unknown,
    target?: { interruptId: string; namespace?: string[] }
  ): Promise<void> {
    if (this.#disposed || this.#thread == null) {
      throw new Error("No active thread to respond to.");
    }
    const resolved =
      target != null
        ? {
            interruptId: target.interruptId,
            namespace: target.namespace ?? [...ROOT_NAMESPACE],
          }
        : this.#latestUnresolvedInterrupt();
    if (resolved == null) {
      throw new Error("No pending interrupt to respond to.");
    }
    try {
      await this.#thread.respondInput({
        namespace: resolved.namespace,
        interrupt_id: resolved.interruptId,
        response,
      });
      this.#resolvedInterrupts.add(resolved.interruptId);
    } catch (error) {
      if (this.#disposed && isAbortLikeError(error)) {
        return;
      }
      throw error;
    }
  }

  /**
   * Dispose the active thread, subscriptions, registry entries, and listeners.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#cancelPendingDispose();
    this.#disposed = true;
    this.#submitter.abortActiveRun();
    await this.#teardownThread();
    await this.registry.dispose();
    this.#threadListeners.clear();
  }

  /**
   * StrictMode-safe lifecycle hook for framework bindings.
   *
   * React 18+ `StrictMode` intentionally mounts → unmounts → remounts
   * components in dev to surface effect-cleanup bugs. A naive
   * `useEffect(() => () => controller.dispose())` would permanently
   * tear the controller down on that first synthetic unmount, leaving
   * every subsequent `submit()` a silent no-op.
   *
   * Call {@link activate} from the bind site's effect and return the
   * result as the effect's cleanup. The controller uses deferred
   * disposal: a `release()` only schedules a dispose on the next
   * microtask, which is cancelled if another `activate()` arrives
   * before it fires (the normal StrictMode remount path).
   */
  activate(): () => void {
    this.#cancelPendingDispose();
    return () => {
      if (this.#disposed) return;
      this.#pendingDisposeTimer = setTimeout(() => {
        this.#pendingDisposeTimer = null;
        void this.dispose().catch(() => undefined);
      }, 0);
    };
  }

  /**
   * Cancel a deferred dispose scheduled by {@link activate}.
   */
  #cancelPendingDispose(): void {
    if (this.#pendingDisposeTimer != null) {
      clearTimeout(this.#pendingDisposeTimer);
      this.#pendingDisposeTimer = null;
    }
  }

  // ---------- escape hatches ----------

  /**
   * Current underlying {@link ThreadStream} (v2 escape hatch).
   */
  getThread(): ThreadStream | undefined {
    return this.#thread;
  }

  /**
   * Listen for `ThreadStream` lifecycle (swap on thread-id change,
   * detach on dispose). The listener fires immediately with the
   * current thread (may be `undefined`).
   *
   * @param listener - Callback invoked immediately and on every thread swap.
   */
  subscribeThread(
    listener: (thread: ThreadStream | undefined) => void
  ): () => void {
    this.#threadListeners.add(listener);
    listener(this.#thread);
    return () => {
      this.#threadListeners.delete(listener);
    };
  }

  // ---------- internals ----------

  /**
   * Build the initial root snapshot from configured initial values.
   */
  #createInitialSnapshot(): RootSnapshot<StateType, InterruptType> {
    const values = (this.#options.initialValues ??
      ({} as StateType)) as StateType;
    const messages = extractAndCoerceMessages(
      values as unknown as Record<string, unknown>,
      this.#messagesKey
    );
    /**
     * Seed `isThreadLoading: true` synchronously when a caller-supplied
     * threadId is on the controller at construction/swap time. Without
     * this Suspense wrappers would render their fallback for a tick
     * because `isThreadLoading` flips false → true → false once the
     * deferred `hydrate()` starts, and the synchronous render observes
     * the initial `false`.
     */
    const willHydrate =
      this.#currentThreadId != null &&
      !this.#selfCreatedThreadIds.has(this.#currentThreadId);
    return {
      values,
      messages,
      toolCalls: [],
      interrupts: [],
      interrupt: undefined,
      isLoading: false,
      isThreadLoading: willHydrate,
      error: undefined,
      threadId: this.#currentThreadId,
    };
  }

  /**
   * Return the active thread stream, creating and binding one when needed.
   *
   * @param threadId - Thread id used when constructing the stream.
   */
  #ensureThread(threadId: string): ThreadStream {
    if (this.#thread != null) return this.#thread;
    this.#thread = this.#options.client.threads.stream(threadId, {
      assistantId: this.#options.assistantId,
      transport: this.#options.transport,
      fetch: this.#options.fetch,
      webSocketFactory: this.#options.webSocketFactory,
    });
    this.registry.bind(this.#thread);
    this.#startRootPump(this.#thread);
    this.#notifyThreadListeners();
    return this.#thread;
  }

  /**
   * Close the current thread stream and reset per-thread assembly state.
   */
  async #teardownThread(): Promise<void> {
    const thread = this.#thread;
    this.#thread = undefined;
    this.registry.bind(undefined);
    this.#threadEventUnsubscribe?.();
    this.#threadEventUnsubscribe = undefined;
    /**
     * Persistent lifecycle driver is scoped to the current thread
     * stream. Remove it so a swap to a new thread starts with a clean
     * listener set (a new one is installed in `#startRootPump`).
     */
    this.#rootEventListeners.delete(this.#lifecycleLoading.listener);
    try {
      await this.#rootSubscription?.unsubscribe();
    } catch {
      /* already closed */
    }
    this.#rootSubscription = undefined;
    this.#rootPumpReady = undefined;
    try {
      await this.#rootPump;
    } catch {
      /* ignore */
    }
    this.#rootPump = undefined;

    // Reset per-thread assembly state.
    this.#rootMessages.reset();
    this.#rootToolAssembler = new ToolCallAssembler();
    this.#lifecycleLoading.reset();
    this.#messageMetadata.reset();
    this.queueStore.setState(
      () => EMPTY_QUEUE as SubmissionQueueSnapshot<StateType>
    );

    if (thread != null) {
      try {
        await thread.close();
      } catch {
        /* already closed */
      }
      this.#notifyThreadListeners();
    }
  }

  /**
   * Determine whether the configured transport uses the resumable event-stream path.
   */
  #usesEventStreamTransport(): boolean {
    const transport = this.#options.transport;
    if (transport === "websocket") return false;
    if (transport == null || transport === "sse") return true;
    return typeof transport.openEventStream === "function";
  }

  /**
   * Start the always-on root subscription pump for the provided thread.
   *
   * @param thread - Thread stream to subscribe to and fan out from.
   */
  #startRootPump(thread: ThreadStream): void {
    if (this.#rootPump != null) return;
    let resolveReady: (() => void) | undefined;
    this.#rootPumpReady = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    /**
     * Wildcard discovery + interrupt tracking is delivered via the
     * thread's dedicated lifecycle watcher (see `ThreadStream.onEvent`).
     * This callback fires once per globally-unique event across both
     * the content pump AND the watcher, so we can drive discovery
     * runners and nested HITL capture without widening the content
     * pump's narrow filter.
     */
    this.#threadEventUnsubscribe = thread.onEvent((event) =>
      this.#onWildcardEvent(event)
    );

    /**
     * Persistent isLoading driver. Drives `isLoading` from
     * root-namespace lifecycle events so that in-flight runs observed
     * via `hydrate()` (not initiated by a local `submit()`) still flip
     * the UI to loading. `running` → true; terminals → false. The
     * optimistic `isLoading = true` inside `submit()` stays because
     * that fires before any subscription event arrives.
     */
    this.#rootEventListeners.add(this.#lifecycleLoading.listener);

    this.#rootPump = (async () => {
      try {
        /**
         * Narrow the content pump to the root namespace, depth 1:
         * this is enough to observe root LLM deltas and first-level
         * discovery hints (tool-started for task:* / subgraph
         * boundaries) without downloading content from every nested
         * subagent / subgraph. Deeper content is pulled in lazily by
         * per-namespace selector projections (e.g. `useMessages(sub)`),
         * which expand `#computeUnionFilter` progressively.
         */
        const subscriptionPromise = thread.subscribe({
          channels: [...ROOT_PUMP_CHANNELS] as Channel[],
          namespaces: [[] as string[]],
          depth: 1,
        });
        if (this.#usesEventStreamTransport()) {
          /**
           * SSE streams can legitimately withhold response headers until
           * the first event is available. Waiting for `subscribe()` here
           * would deadlock new-thread submits: the run is not dispatched
           * until the root pump is "ready", but the pump does not become
           * ready until the run emits. `thread.subscribe()` has already
           * registered the local subscription and scheduled the stream
           * rotation by this point; waiting one microtask lets the fetch
           * get kicked off without requiring headers to arrive.
           */
          queueMicrotask(() => {
            resolveReady?.();
            resolveReady = undefined;
          });
        }
        const subscription = await subscriptionPromise;
        resolveReady?.();
        resolveReady = undefined;
        this.#rootSubscription = subscription;
        /**
         * The SSE transport pauses the underlying subscription when
         * a terminal root lifecycle event arrives (so `for await`
         * loops observing a single run exit cleanly) and re-opens
         * the next run's server stream on `#prepareForNextRun`,
         * resuming the subscription handle. The root pump needs to
         * survive that hand-off: we re-enter the inner `for await`
         * for every resumed iteration until the subscription is
         * permanently closed or the controller is disposed.
         */
        while (!this.#disposed) {
          for await (const event of subscription) {
            if (this.#disposed) {
              break;
            }
            /**
             * Resilience: isolate per-event dispatch from the pump loop.
             *
             * `#onRootEvent` runs synchronously and, transitively,
             * invokes every root-bus listener (selector projections that
             * opted into the shared stream) plus every `rootStore`
             * subscriber. Some of those subscribers live in a React
             * render tree — `useStream` drives
             * `useSyncExternalStore`, so a misbehaving component can
             * surface a render-phase error ("Maximum update depth
             * exceeded", "The result of getSnapshot should be cached",
             * etc.) that propagates out here.
             *
             * Without this guard, a single throw bubbles through the
             * `for await` loop and terminates the root pump permanently.
             * That is catastrophic: no more root events get processed —
             * the terminal `lifecycle: completed` never lands, so
             * `#awaitNextTerminal` never resolves, `isLoading` stays
             * `true`, composers stay disabled, and the final assistant
             * turn never commits to `stream.messages`. The UI looks
             * hung even though the server is still emitting events
             * (and `ThreadStream.onEvent` keeps firing).
             *
             * We therefore swallow the error and keep pumping. The
             * the pump's correctness guarantees do not depend on any
             * consumer behaving well.
             */
            try {
              this.#onRootEvent(event);
            } catch {
              /**
               * Best-effort — a consumer-facing store subscriber should not
               * terminate the root pump. Store mutations happen before
               * listeners are notified, so continuing with later events keeps
               * the controller's authoritative state moving forward.
               */
            }
          }
          if (this.#disposed) break;
          if (!subscription.isPaused) {
            break;
          }
          await subscription.waitForResume();
        }
      } catch {
        resolveReady?.();
        resolveReady = undefined;
        /* thread closed or errored */
      }
    })();
  }

  /**
   * Handle an event delivered via {@link ThreadStream.onEvent}.
   *
   * `onEvent` fires once per globally-unique event across the content
   * pump and the wildcard lifecycle watcher, so this is the single
   * entry point for wildcard discovery / interrupt tracking. It does
   * NOT fan events out to the root bus (that's driven by the content
   * pump iterator so root-bus short-circuits stay depth-1 scoped) and
   * it does NOT process root content — messages/tools/values at root
   * are handled by `#onRootEvent` off the content pump.
   *
   * @param event - Raw protocol event observed by the thread-wide listener.
   */
  #onWildcardEvent(event: Event): void {
    try {
      this.#subagents.push(event);
    } catch {
      /**
       * Discovery store subscribers are user/UI code. If one throws, still
       * let the wildcard watcher update subgraphs, loading, and interrupts.
       */
    }
    this.#subgraphs.push(event);
    this.#lifecycleLoading.handle(event);

    /**
     * Nested `input.requested` events (HITL inside a subagent /
     * subgraph) are not observable via the narrow content pump. The
     * `ThreadStream` itself already records them into
     * `thread.interrupts`, which `#latestUnresolvedInterrupt()`
     * consults — so HITL respond() works for any depth. Root-level
     * interrupts are also mirrored into `rootStore.interrupts` here so
     * UI state does not depend on the narrower content pump being the
     * first consumer to see the event.
     */
    this.#recordRootInterrupt(event);
  }

  /**
   * Process one root-pump event and update all root projections.
   *
   * @param event - Event yielded by the root subscription.
   */
  #onRootEvent(event: Event): void {
    try {
      this.#subagents.push(event);
    } catch {
      /**
       * Discovery store subscribers are user/UI code. If one throws, still
       * process the root event below so orchestrator messages and terminal
       * state continue to advance.
       */
    }

    /**
     * Fan root-pump events out to every root-bus listener (selector
     * projections that opted into the shared stream,
     * `#awaitTerminal`, etc.). The root bus mirrors the content
     * pump's narrow scope (depth 1 at root) so projections that
     * short-circuit via the bus stay bounded.
     */
    if (this.#rootEventListeners.size > 0) {
      for (const listener of this.#rootEventListeners) {
        try {
          listener(event);
        } catch {
          /**
           * Best-effort — a bad listener should not wedge other
           * projections or the root pump itself.
           */
        }
      }
    }

    /**
     * `messages` and `tools` events are emitted under a node's
     * namespace — for a typical StateGraph the LLM's token deltas
     * land on `["model:<uuid>"]`, tool executions on
     * `["tools:<uuid>"]`, etc. The orchestrator's own turns (root
     * agent, or an orchestrator-scoped subgraph like `model:*` /
     * `model_request:*`) belong in `root.messages` and
     * `root.toolCalls`.
     *
     * Subagent / tool-internal branches do NOT:
     *   - `task:*` segment — legacy subagent convention.
     *   - `tools:*` segment — every tool execution is wrapped in a
     *     `tools` subgraph. For simple tools its only content is
     *     the eventual tool result (also echoed verbatim by
     *     `values.messages` so we don't lose anything). For the
     *     deep-agent `task` tool its content IS the spawned
     *     subagent's full message + tool stream, which is surfaced
     *     separately via `useMessages(stream, subagent)` /
     *     `useToolCalls(stream, subagent)`.
     *
     * We therefore drop `messages` events from any namespace that
     * contains a `task:*` or `tools:*` segment; the authoritative
     * tool-result text lands in `root.messages` via the root
     * `values.messages` snapshot merge in `#applyValues`.
     */
    const isInternalNamespace = isInternalWorkNamespace(event.params.namespace);
    const hasLegacySubagentNamespace = isLegacySubagentNamespace(
      event.params.namespace
    );

    if (event.method === "messages") {
      if (!isInternalNamespace) {
        this.#rootMessages.handleMessage(event as MessagesEvent);
      }
      return;
    }

    if (event.method === "tools") {
      /**
       * Root-level tool events (both for simple orchestrator tools
       * and the deep-agent `task` dispatcher) fire at a
       * single-segment `["tools:<id>"]` namespace. Anything deeper
       * (e.g. `[tools:<outer>, tools:<inner>]`) is a subagent's own
       * tool call and belongs to that subagent's `useToolCalls`
       * view, not the orchestrator's `root.toolCalls`.
       */
      const isRootLevelTool =
        event.params.namespace.length <= 1 && !hasLegacySubagentNamespace;
      if (isRootLevelTool) {
        /**
         * Record the `namespace → tool_call_id` association so that
         * the ensuing `message-start` (role: "tool") at the same
         * namespace can recover the `tool_call_id` (the `messages`
         * channel's start event doesn't carry it directly).
         */
        const toolData = event.params.data as {
          event?: string;
          tool_call_id?: string;
        };
        if (
          toolData.event === "tool-started" &&
          typeof toolData.tool_call_id === "string"
        ) {
          this.#rootMessages.recordToolCallNamespace(
            event.params.namespace,
            toolData.tool_call_id
          );
        }
        const tc = this.#rootToolAssembler.consume(event as ToolsEvent);
        if (tc != null) {
          this.rootStore.setState((s) => ({
            ...s,
            toolCalls: upsertToolCall(s.toolCalls, tc),
          }));
        }
      }
      return;
    }

    /**
     * The `checkpoints` channel carries the lightweight envelope
     * (`id`, `parent_id`, `step`, `source`) emitted immediately
     * before its companion `values` event on the same superstep.
     * Buffer the envelope per-namespace so the ensuing `values`
     * event at the same namespace can pair with it in `#applyValues`.
     * The buffer is read-and-cleared on consumption so a subsequent
     * `values` event without a new checkpoint doesn't reuse stale
     * metadata.
     */
    if (event.method === "checkpoints") {
      const data = event.params.data as {
        id?: unknown;
        parent_id?: unknown;
      } | null;
      this.#messageMetadata.bufferCheckpoint(event.params.namespace, data);
      return;
    }

    // Channels below are only meaningful at the root namespace.
    const isRoot = isRootNamespace(event.params.namespace);
    if (!isRoot) return;

    if (event.method === "values") {
      const valuesEvent = event as ValuesEvent;
      const bufferedCheckpoint = this.#messageMetadata.consumeCheckpoint(
        event.params.namespace
      );
      this.#applyValues(valuesEvent.params.data, bufferedCheckpoint);
      return;
    }

    if (event.method === "input.requested") {
      this.#recordRootInterrupt(event);
      return;
    }

    if (event.method === "lifecycle") {
      /**
       * Root lifecycle transitions are observed elsewhere
       * (#awaitTerminal) to unblock `submit`.
       */
      const lifecycle = (event as LifecycleEvent).params.data as {
        event?: string;
      };
      void lifecycle;
    }
  }

  /**
   * Merge a `values` payload into root values and root messages.
   *
   * @param raw - Raw `values` channel payload.
   * @param checkpoint - Optional checkpoint envelope paired with the values event.
   */
  #applyValues(raw: unknown, checkpoint?: CheckpointEnvelope): void {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return;
    }
    const state = raw as Record<string, unknown>;
    /**
     * Surface parent_checkpoint per-message when the values event
     * carries the lightweight checkpoint envelope (populated by
     * `@langchain/langgraph-core`'s `_emitValuesWithCheckpointMeta` and
     * forwarded through `convertToProtocolEvent`). Consumers surface
     * this as `useMessageMetadata(stream, msg.id).parentCheckpointId`
     * for fork / edit flows.
     */
    const parentCheckpointId = checkpoint?.parent_id;
    if (parentCheckpointId != null && Array.isArray(state[this.#messagesKey])) {
      this.#messageMetadata.recordMessages(
        state[this.#messagesKey] as Array<{ id?: string }>,
        { parentCheckpointId }
      );
    }
    const maybeMessages = state[this.#messagesKey];
    let nextValues: StateType;
    let nextMessages: BaseMessage[];
    if (Array.isArray(maybeMessages)) {
      const coerced = ensureMessageInstances(
        maybeMessages as (Message | BaseMessage)[]
      );
      nextValues = {
        ...(state as StateType),
        [this.#messagesKey]: coerced,
      } as StateType;
      nextMessages = coerced;
    } else {
      nextValues = state as StateType;
      nextMessages = [];
    }
    this.#rootMessages.applyValues(nextValues, nextMessages);
  }

  /**
   * Mirror root protocol interrupts into the root snapshot.
   *
   * This can be called from both the wildcard lifecycle/input watcher and the
   * root content pump. Store-level dedup keeps the user-facing list stable.
   */
  #recordRootInterrupt(event: Event): void {
    if (event.method !== "input.requested") return;
    if (!isRootNamespace(event.params.namespace)) return;
    const data = event.params.data as {
      interrupt_id?: string;
      payload?: unknown;
    };
    const interruptId = data?.interrupt_id;
    if (
      typeof interruptId !== "string" ||
      this.#resolvedInterrupts.has(interruptId)
    ) {
      return;
    }
    const interrupt: Interrupt<InterruptType> = {
      id: interruptId,
      value: data.payload as InterruptType,
    };
    this.rootStore.setState((s) => {
      if (s.interrupts.some((entry) => entry.id === interruptId)) return s;
      const interrupts = [...s.interrupts, interrupt];
      return { ...s, interrupts, interrupt: interrupts[0] };
    });
  }

  /**
   * Resolve on the next root-namespace terminal lifecycle event
   * (`completed` / `failed` / `interrupted`) or on abort.
   *
   * Attaches to the controller's root event bus instead of opening
   * a second server subscription. Callers should register the
   * returned promise **before** dispatching the command that
   * triggers the run (`thread.run.start` / `thread.input.respond`)
   * — the root pump fans events out synchronously on arrival, so a
   * late registration would miss the terminal for fast runs.
   *
   * @param signal - Abort signal for the local submit lifecycle.
   */
  #awaitNextTerminal(signal: AbortSignal): Promise<{
    event: "completed" | "failed" | "interrupted" | "aborted";
    error?: string;
  }> {
    return new Promise((resolve) => {
      let settled = false;
      function finish(result: {
        event: "completed" | "failed" | "interrupted" | "aborted";
        error?: string;
      }) {
        if (settled) return;
        settled = true;
        unsubscribeRoot?.();
        unsubscribeThread?.();
        signal.removeEventListener("abort", finishAborted);
        resolve(result);
      }
      const finishAborted = () => finish({ event: "aborted" });
      const onEvent = (event: Event) => {
        if (settled) return;
        if (event.method !== "lifecycle") return;
        if (!isRootNamespace(event.params.namespace)) return;
        const lifecycle = (event as LifecycleEvent).params.data as {
          event?: string;
          error?: string;
        };
        if (lifecycle?.event === "completed") {
          setTimeout(() => finish({ event: "completed" }), 0);
        } else if (lifecycle?.event === "failed") {
          setTimeout(
            () => finish({ event: "failed", error: lifecycle.error }),
            0
          );
        } else if (lifecycle?.event === "interrupted") {
          setTimeout(() => finish({ event: "interrupted" }), 0);
        }
      };
      const unsubscribeRoot = this.#rootBus.subscribe(onEvent);
      const unsubscribeThread = this.#thread?.onEvent(onEvent);
      if (signal.aborted) {
        finishAborted();
      } else {
        signal.addEventListener("abort", finishAborted, { once: true });
      }
    });
  }

  /**
   * Find the newest unresolved interrupt recorded on the active thread.
   */
  #latestUnresolvedInterrupt(): ResolvedInterrupt | null {
    const thread = this.#thread;
    if (thread == null) return null;
    for (let i = thread.interrupts.length - 1; i >= 0; i -= 1) {
      const entry = thread.interrupts[i];
      if (entry == null) continue;
      if (this.#resolvedInterrupts.has(entry.interruptId)) continue;
      return {
        interruptId: entry.interruptId,
        namespace: entry.namespace,
      };
    }
    return null;
  }

  /**
   * Notify listeners that the underlying thread stream changed.
   */
  #notifyThreadListeners(): void {
    for (const listener of this.#threadListeners) listener(this.#thread);
  }
}

// ---------- helpers ----------

/**
 * Extract and coerce the configured messages key from a values object.
 *
 * @param values - State values object to read from.
 * @param messagesKey - Key that contains the message array.
 */
function extractAndCoerceMessages(
  values: Record<string, unknown>,
  messagesKey: string
): BaseMessage[] {
  const raw = values[messagesKey];
  if (!Array.isArray(raw)) return [];
  return ensureMessageInstances(
    raw as (Message | BaseMessage)[]
  ) as BaseMessage[];
}

// Unused import guard — `AIMessage` is only referenced by type tests.
void AIMessage;
