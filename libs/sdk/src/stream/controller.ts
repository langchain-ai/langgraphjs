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
import { v7 as uuidv7 } from "@langchain/core/utils/uuid";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  Channel,
  Event,
  LifecycleEvent,
  MessagesEvent,
  ToolsEvent,
  ValuesEvent,
} from "@langchain/protocol";
import type { Interrupt, ThreadState } from "../schema.js";
import type { ThreadStream } from "../client/stream/index.js";
import type { SubscriptionHandle } from "../client/stream/index.js";
import { ToolCallAssembler } from "../client/stream/handles/tools.js";
import type { AssembledToolCall } from "../client/stream/handles/tools.js";
import { normalizeInterruptForClient } from "../ui/interrupts.js";
import { normalizeHitlResponseForServer } from "../ui/hitl-interrupt-payload.js";
import type { Message } from "../types.messages.js";
import { NAMESPACE_SEPARATOR } from "./constants.js";
import { StreamStore } from "./store.js";
import { ChannelRegistry } from "./channel-registry.js";
import { ensureMessageInstances } from "./message-coercion.js";
import {
  SubagentDiscovery,
  type SubagentMap,
  SubgraphDiscovery,
  type SubgraphMap,
  type SubgraphByNodeMap,
} from "./discovery/index.js";
import {
  collectSubgraphHostNamespaces,
  getHistoryPage,
  mapSubagentNamespaces,
  resolveSubagentNamespaces,
} from "./discovery/namespace-from-history.js";
import type { SubagentDiscoverySnapshot } from "./types.js";
import {
  isInternalWorkNamespace,
  isLegacySubagentNamespace,
  isRootNamespace,
  namespaceKey,
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
  prepareOptimisticInput,
  serializeUpdateMessages,
  type OptimisticHandle,
} from "./optimistic-input.js";
import {
  EMPTY_QUEUE,
  SubmitCoordinator,
  type SubmissionQueueEntry,
  type SubmissionQueueSnapshot,
} from "./submit-coordinator.js";
import {
  reconcileToolCallsFromMessages,
  seedToolCallsFromMessages,
  upsertToolCall,
} from "./tool-calls.js";
import { resolveInterruptTargetForHeadlessResume } from "../headless-tools.js";
import type {
  RootEventBus,
  RootSnapshot,
  RunExecutionReason,
  StreamControllerOptions,
  StreamRespondAllOptions,
  StreamRespondOptions,
  StreamStopOptions,
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

function lifecycleReason(event: string | undefined): RunExecutionReason | null {
  if (event === "completed") return "success";
  if (event === "failed") return "error";
  if (event === "interrupted") return "interrupt";
  return null;
}

interface ScopedHistorySeed {
  readonly messages: BaseMessage[];
  readonly toolCalls: AssembledToolCall[];
}

/**
 * Decide whether a hydrated thread is *active* (a run is executing or
 * paused awaiting resume) from the `getState()` snapshot alone — no
 * extra request.
 *
 * Why this gate exists: a finished thread does not need either of the
 * always-on SSE pumps. Subagent/subgraph cards are already seeded from
 * the `getState()` messages and a single bounded `getHistory()` page, so
 * opening the depth-1 content pump + the wildcard lifecycle watcher only
 * to replay a completed run and then idle forever is pure waste. We open
 * the pumps eagerly only when the thread is active; otherwise they come
 * up on the first local `submit()` (the existing deferred-pump path) or
 * a thread swap that lands on an active thread.
 *
 * The gate is deliberately conservative: we only conclude *idle* when
 * the state proves it. A thread is treated as active unless `next` is a
 * present, empty array AND no task carries a pending interrupt:
 *  - `next` missing / not an array: unknown shape (a server or custom
 *    client may omit it). Treat as active so an already-running
 *    server-side run is still observed on reconnect — never silently
 *    disable streaming on an unfamiliar `getState` shape.
 *  - `next.length > 0`: the checkpoint still has nodes to execute, i.e.
 *    a run is mid-flight or paused at an interrupt.
 *  - `next` is `[]` but a `tasks[].interrupts` is non-empty: the thread
 *    is interrupted and a resume (which starts a run) must be observable.
 *  - `next` is `[]` and no pending interrupts: a completed run → idle.
 */
function isThreadStateActive(
  state: { next?: unknown; tasks?: unknown } | null | undefined
): boolean {
  if (state == null) return true;
  // Only a present, empty `next` array proves "no nodes pending". A
  // missing/non-array `next` is an unknown shape → assume active.
  if (!Array.isArray(state.next)) return true;
  if (state.next.length > 0) return true;
  if (Array.isArray(state.tasks)) {
    for (const task of state.tasks) {
      const interrupts = (task as { interrupts?: unknown } | null)?.interrupts;
      if (Array.isArray(interrupts) && interrupts.length > 0) return true;
    }
  }
  return false;
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
  /**
   * `true` while a self-created thread has its root pump deferred until
   * the first `submitRun` / `respondInput` commits the thread row
   * server-side. See `#ensureThread` and `#startDeferredRootPump`.
   */
  #rootPumpDeferred = false;
  #threadEventUnsubscribe: (() => void) | undefined;
  #disposed = false;
  #pendingDisposeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #resolvedInterrupts = new Set<string>();
  /**
   * Set of interrupt IDs the server reports as currently *active* on
   * the thread (from `state.tasks[].interrupts`). Populated during
   * {@link hydrate} from `client.threads.getState()` and used as a
   * strict allowlist when processing replayed `input.requested`
   * events from the persistent SSE subscription. Without this guard,
   * SSE replay re-adds historically-requested interrupts that have
   * since been resolved (no `input.responded` event exists in the
   * protocol, so the SDK has no other way to tell replay from live
   * for an idle thread). `null` outside the hydrate-window so
   * genuinely new live interrupts on an active run aren't filtered;
   * cleared at the start of `submit()` for the same reason.
   */
  #hydratedActiveInterruptIds: Set<string> | null = null;
  /**
   * Monotonic counter bumped at the start of each `submit()` and used
   * by {@link hydrate} to skip its post-fetch allowlist write when a
   * submit started while the state fetch was in flight. Without this
   * guard, a submit-then-hydrate race could re-install a stale
   * allowlist that filters out genuinely-new live interrupts emitted
   * by the just-started run.
   */
  #submitGeneration = 0;
  /**
   * Thread ids we minted client-side on first `submit()`. Keeping them
   * here lets `hydrate()` skip the `threads.getState()` round-trip —
   * we know there is nothing checkpointed server-side yet (and the
   * request would 404 and surface a spurious error to the UI).
   */
  readonly #selfCreatedThreadIds = new Set<string>();
  /**
   * In-flight per-subagent namespace resolutions, keyed by tool-call
   * id. De-dupes concurrent {@link resolveSubagentNamespace} calls so
   * re-renders / multiple consumers of the same subagent don't issue
   * parallel `getHistory` walks.
   */
  readonly #namespaceResolves = new Map<string, Promise<void>>();
  /**
   * In-flight hydrate-time discovery seed ({@link #seedDiscoveryFromHistory}):
   * a single bounded `getHistory` page that bulk-promotes every
   * still-default subagent namespace and seeds subgraph hosts. Per-card
   * {@link resolveSubagentNamespace} calls await this shared promise
   * instead of each firing their own `getHistory` walk, so opening N
   * cards right after reconnect costs one history read, not N. Re-armed
   * per hydrate cycle and cleared once it settles.
   */
  #discoverySeedPromise: Promise<void> | undefined;
  readonly #scopedHistorySeeds = new Map<
    string,
    Promise<ScopedHistorySeed | null>
  >();
  readonly #rootEventListeners = new Set<(event: Event) => void>();
  readonly #rootBus: RootEventBus;
  #activeRunId: string | undefined;
  #localRunDepth = 0;
  /**
   * `true` once a root `values` event has been applied for the current
   * optimistic run. Reset to `false` in {@link #beginOptimistic} and
   * read in {@link #settleOptimistic}: when a run terminates without
   * the server ever echoing a `values` snapshot, optimistically-merged
   * non-message keys are rolled back to their pre-submit values.
   */
  #sawValuesForRun = false;

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
      trySeedFromHistory: (params) =>
        this.#trySeedProjectionFromHistory(params),
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
      ensureThread: (threadId, deferRootPump) =>
        this.#ensureThread(threadId, deferRootPump),
      startDeferredRootPump: () => this.#startDeferredRootPump(),
      abandonDeferredRootPump: () => this.#abandonDeferredRootPump(),
      forgetSelfCreatedThreadId: (threadId) => {
        this.#selfCreatedThreadIds.delete(threadId);
      },
      waitForRootPumpReady: () => this.#rootPumpReady,
      awaitNextTerminal: (signal) => this.#awaitNextTerminal(signal),
      awaitResumedRunTerminal: (signal) =>
        this.#awaitResumedRunTerminal(signal),
      onSubmitStart: () => {
        // Clear the hydrate-window allowlist so genuinely-new live
        // interrupts on the just-started run aren't filtered. Bump
        // the generation so any in-flight hydrate skips its
        // allowlist write on return (see #hydratedActiveInterruptIds).
        this.#hydratedActiveInterruptIds = null;
        this.#submitGeneration += 1;
      },
      onRunStart: () => this.#markLocalRunStart(),
      onRunCreated: (runId) => this.#notifyCreated(runId),
      onRunCompleted: (reason, runId) => this.#notifyCompleted(reason, runId),
      onRunEnd: () => this.#markLocalRunEnd(),
      beginOptimistic: (input) => this.#beginOptimistic(input),
      settleOptimistic: (handle, event) =>
        this.#settleOptimistic(handle, event),
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
   * Load thread state for hydration, preferring the active custom
   * adapter's `getState()` when present.
   */
  async #fetchHydrationState(): Promise<ThreadState<StateType> | null> {
    const threadId = this.#currentThreadId;
    if (threadId == null) return null;

    const transport = this.#options.transport;
    if (
      transport != null &&
      typeof transport === "object" &&
      typeof transport.getState === "function"
    ) {
      return (await transport.getState<StateType>()) as ThreadState<StateType> | null;
    }

    return this.#options.client.threads.getState<StateType>(threadId);
  }

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
    // Re-arm per hydrate cycle: a stale seed from a previous thread must
    // not be awaited by this thread's lazy namespace resolves.
    this.#discoverySeedPromise = undefined;
    this.#scopedHistorySeeds.clear();
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
    let threadExists = false;
    // Default active so a getState error / non-404 failure never
    // silently disables streaming — the pumps open eagerly as before.
    // Flipped to the real signal once we have the state in hand.
    let threadActive = true;
    try {
      const state = await this.#fetchHydrationState();
      threadExists = state != null;
      threadActive = isThreadStateActive(state);
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
        /**
         * Carry the checkpoint `step` from `getState()` metadata so the
         * root message projection treats this seed as the authoritative
         * latest superstep. The content pump's reconnect replay emits
         * older checkpoints (lower step); marking the seed's step lets
         * the projection reject those as stale instead of letting them
         * remove the seeded message tail (the final assistant turn).
         */
        const seedStep = (state.metadata as { step?: unknown } | undefined)
          ?.step;
        const syntheticCheckpoint =
          typeof checkpointId === "string"
            ? {
                id: checkpointId,
                ...(parentCheckpointId != null
                  ? { parent_id: parentCheckpointId }
                  : {}),
                ...(typeof seedStep === "number" ? { step: seedStep } : {}),
              }
            : undefined;
        this.#applyValues(state.values as unknown, syntheticCheckpoint);

        /**
         * Seed subagent discovery from checkpoint messages so deep-agent
         * cards render on refresh without waiting for SSE replay. Zero
         * extra HTTP (reuses the `getState` payload); mirrors the
         * interrupt-seeding below. `#subagents` was cleared in
         * `#teardownThread`, and `seedFromCheckpointMessages` is
         * idempotent, so this is safe on re-hydrate.
         */
        const seedMessages = (state.values as Record<string, unknown>)[
          this.#messagesKey
        ];
        if (Array.isArray(seedMessages)) {
          this.#subagents.seedFromCheckpointMessages(seedMessages);

          /**
           * An idle (finished) thread defers its root SSE pump; the first
           * `submit()` brings it up and the transport replays the finished
           * run from `seq=0`. Seal the seeded message ids so that replay's
           * `messages` channel deltas can't downgrade the already-complete
           * tail to empty partials (a visible "messages replay"). Only safe
           * for idle threads, where every seeded message is final — an
           * active thread's tail may still be streaming and must keep
           * receiving deltas. New ids from the next run are never sealed,
           * and the seal lifts once a newer checkpoint advances the
           * timeline.
           */
          if (!threadActive) {
            const sealedIds = (seedMessages as Array<{ id?: unknown }>)
              .map((message) => message?.id)
              .filter((id): id is string => typeof id === "string");
            if (sealedIds.length > 0) {
              this.#rootMessages.sealMessageIds(sealedIds);
            }
          }
        }
      }
      /**
       * Converge to server truth: drop any optimistic messages the
       * server state does not contain (`pending` / `failed` that were
       * never persisted — e.g. a failed run's user message). Echoed
       * ids were flipped to `"sent"` by `#applyValues` above and so are
       * excluded from `unpersistedOptimisticIds()`.
       */
      const unpersisted = this.#messageMetadata.unpersistedOptimisticIds();
      if (unpersisted.size > 0) {
        this.#rootMessages.dropOptimisticMessages(unpersisted);
        this.#messageMetadata.forget(unpersisted);
      }
      /**
       * Sync the visible interrupt list to the server's authoritative
       * `state.tasks[].interrupts`. Without this, SSE replay of past
       * `input.requested` events would re-add resolved interrupts to
       * the UI on every page navigation back to the thread.
       *
       * Only runs when `state.tasks` is an array — runtimes that don't
       * surface tasks in `threads.getState()` are left untouched (an
       * unconditional overwrite would wipe any in-flight interrupt
       * state the wildcard watcher may already have recorded).
       */
      if (Array.isArray(state?.tasks)) {
        const generationAtFetch = this.#submitGeneration;
        const activeInterrupts: Interrupt<InterruptType>[] = [];
        const activeIds = new Set<string>();
        for (const task of state.tasks) {
          if (!Array.isArray(task?.interrupts)) continue;
          for (const interrupt of task.interrupts) {
            const typed = interrupt as
              | { id?: string; value?: unknown }
              | null
              | undefined;
            const id = typed?.id;
            if (typeof id !== "string" || activeIds.has(id)) continue;
            activeIds.add(id);
            activeInterrupts.push(
              normalizeInterruptForClient({
                id,
                value: typed?.value as InterruptType,
              })
            );
          }
        }
        this.rootStore.setState((s) => ({
          ...s,
          interrupts: activeInterrupts,
          interrupt: activeInterrupts[0],
        }));
        // Only seed the allowlist when no submit started while the
        // state fetch was in flight. If one did, the cleared
        // (null) allowlist must stay null so the new run's live
        // interrupts are not filtered.
        if (this.#submitGeneration === generationAtFetch) {
          this.#hydratedActiveInterruptIds = activeIds;
        }
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
     * Open the shared subscription on mount so in-flight server-side
     * runs are observed even when no local `submit()` is active — BUT
     * only when the thread is actually active (see
     * {@link isThreadStateActive}). A finished thread's cards are seeded
     * from `getState()` + the bounded `getHistory()` below, so opening
     * the depth-1 content pump just to replay a completed run and idle
     * forever is pure waste. When idle we take the deferred path: the
     * pump (and watcher) come up on the first local `submit()` via
     * {@link #startDeferredRootPump}, exactly like a self-created thread.
     * The transport replays from `seq=0` on the deferred subscribe, so
     * nothing is missed.
     */
    const thread = this.#ensureThread(this.#currentThreadId, !threadActive);

    /**
     * Start the wildcard lifecycle watcher up-front for existing,
     * active threads. The root content pump runs at `depth: 1`, which
     * covers root-namespace and one-deep events but not arbitrarily-
     * nested subagent / subgraph lifecycle — the dedicated watcher
     * handles those.
     *
     * Skipped when:
     *  - the thread is idle/finished — there are no live events to
     *    watch; discovery is seeded from history below, and the watcher
     *    starts with the deferred pump on the first `submit()`.
     *  - the thread is self-created (new) — the watcher would 404
     *    against a not-yet-existent thread; `submitRun` / `respondInput`
     *    call `startLifecycleWatcher` on first submission instead.
     */
    if (threadExists && threadActive) {
      thread.startLifecycleWatcher();
    }
    if (threadExists) {
      /**
       * Seed subgraph discovery and promote subagent execution
       * namespaces from a single bounded `getHistory` page. Subgraph
       * structure is not present in the root checkpoint messages
       * (unlike subagents), so it can only be reconstructed from
       * history. Fire-and-forget — not awaited into the hydration
       * promise, so Suspense / first paint stay unblocked; cards fill
       * in progressively when it resolves.
       *
       * Held in `#discoverySeedPromise` so lazy per-card
       * {@link resolveSubagentNamespace} calls coalesce onto this single
       * read instead of each firing their own `getHistory` walk.
       */
      const seed: Promise<void> = this.#seedDiscoveryFromHistory(
        this.#currentThreadId
      ).finally(() => {
        // Only clear if a later hydrate cycle hasn't re-armed it.
        if (this.#discoverySeedPromise === seed) {
          this.#discoverySeedPromise = undefined;
        }
      });
      this.#discoverySeedPromise = seed;
    }
  }

  /**
   * One bounded, non-blocking `getHistory` read at hydrate that seeds
   * subgraph hosts and bulk-promotes still-default subagent execution
   * namespaces. O(1) in requests regardless of subagent/subgraph count.
   */
  async #seedDiscoveryFromHistory(threadId: string): Promise<void> {
    try {
      const history = await getHistoryPage(this.#options.client, threadId, {
        limit: 20,
      });
      // A thread swap (or dispose) during the fetch invalidates this seed.
      if (this.#disposed || this.#currentThreadId !== threadId) return;

      this.#primeScopedHistorySeedsFromHistory(threadId, history);

      const hosts = collectSubgraphHostNamespaces(history);
      this.#subgraphs.seedFromHistory(hosts);

      const defaultOnlyIds = [...this.#subagents.snapshot.values()]
        .filter(namespaceIsDefaultOnly)
        .map((entry) => entry.id);
      if (defaultOnlyIds.length > 0) {
        const map = mapSubagentNamespaces(
          history,
          defaultOnlyIds,
          this.#messagesKey
        );
        for (const [id, segment] of map) {
          this.#subagents.applyExecutionNamespace(id, segment);
        }
      }
    } catch {
      /* non-fatal: SSE replay still reconciles discovery */
    }
  }

  /**
   * Lazily resolve a single subagent's execution namespace from
   * checkpoint history. Intended call site: the first scoped
   * `useMessages` / `useToolCalls` mount for a subagent whose namespace
   * is still the default `tools:<toolCallId>`. A fallback for the
   * hydrate-time bulk seed ({@link #seedDiscoveryFromHistory}) — most
   * subagents are already promoted by the time a panel opens.
   *
   * Skips ids already promoted past default-only (SSE replay or a prior
   * resolve). Concurrent calls for the same id share one `getHistory`
   * walk via {@link #namespaceResolves}.
   *
   * @param toolCallId - Parent `task` tool-call id (the subagent's discovery key).
   */
  async resolveSubagentNamespace(toolCallId: string): Promise<void> {
    if (this.#disposed) return;
    const threadId = this.#currentThreadId;
    if (threadId == null) return;
    if (!namespaceIsDefaultOnly(this.#subagents.snapshot.get(toolCallId))) {
      return;
    }
    const inflight = this.#namespaceResolves.get(toolCallId);
    if (inflight != null) return inflight;

    const run = (async () => {
      try {
        /**
         * Coalesce onto the hydrate-time discovery seed. That single
         * bounded `getHistory` page bulk-promotes every default-only
         * subagent, so when many cards mount at once (the common
         * reconnect case) they all await this one read instead of each
         * firing their own walk. Re-check after it settles: usually the
         * bulk seed already promoted us and no further fetch is needed.
         */
        const seed = this.#discoverySeedPromise;
        if (seed != null) {
          await seed;
          if (this.#disposed || this.#currentThreadId !== threadId) return;
          if (
            !namespaceIsDefaultOnly(this.#subagents.snapshot.get(toolCallId))
          ) {
            return;
          }
        }
        const map = await resolveSubagentNamespaces(
          this.#options.client,
          threadId,
          [toolCallId],
          { messagesKey: this.#messagesKey }
        );
        if (this.#disposed || this.#currentThreadId !== threadId) return;
        const segment = map.get(toolCallId);
        if (segment != null) {
          this.#subagents.applyExecutionNamespace(toolCallId, segment);
        }
      } catch {
        /* non-fatal: SSE replay still reconciles the namespace */
      } finally {
        this.#namespaceResolves.delete(toolCallId);
      }
    })();
    this.#namespaceResolves.set(toolCallId, run);
    return run;
  }

  /**
   * Try to satisfy a scoped selector projection from checkpoint history
   * instead of opening a scoped `/events` replay.
   *
   * This is only valid while the root pump is deferred, which means hydrate
   * has classified the thread as idle/stale. Active and interrupted threads
   * must keep using SSE so ongoing work and resumes are observed. For an idle
   * thread, though, a late-mounted subagent card only needs the latest scoped
   * checkpoint snapshot; opening `/events` just asks the server to replay work
   * that already finished and can be slow for namespaces discovered from
   * history.
   *
   * Returns `true` when the projection was handled without `/events`. That can
   * mean either the store was seeded from namespace-specific history, or the
   * projection targeted a default subagent namespace that should be skipped
   * because hydrate promoted it to its execution namespace. Returns `false`
   * when the caller should fall back to the normal subscription path.
   */
  async #trySeedProjectionFromHistory<T>(params: {
    kind: "messages" | "toolCalls";
    namespace: readonly string[];
    store: StreamStore<T>;
  }): Promise<boolean> {
    const threadId = this.#currentThreadId;
    if (
      this.#disposed ||
      threadId == null ||
      params.namespace.length === 0 ||
      !this.#rootPumpDeferred ||
      this.#selfCreatedThreadIds.has(threadId)
    ) {
      return false;
    }

    if (await this.#skipDefaultSubagentProjection(params.namespace, threadId)) {
      return true;
    }
    if (
      this.#disposed ||
      this.#currentThreadId !== threadId ||
      !this.#rootPumpDeferred
    ) {
      return false;
    }

    const seed = await this.#getScopedHistorySeed(threadId, params.namespace);
    if (
      seed == null ||
      this.#disposed ||
      this.#currentThreadId !== threadId ||
      !this.#rootPumpDeferred
    ) {
      return false;
    }

    if (await this.#skipDefaultSubagentProjection(params.namespace, threadId)) {
      return true;
    }

    if (params.kind === "messages") {
      params.store.setValue(seed.messages as T);
      return true;
    }
    params.store.setValue(seed.toolCalls as T);
    return true;
  }

  /**
   * Suppress subscriptions for placeholder subagent namespaces once hydrate has
   * resolved the real execution namespace.
   *
   * Deep-agent discovery first creates cards at `tools:<toolCallId>`. The
   * actual worker history usually lives under a different checkpoint namespace
   * such as `tools:<uuid>`, and hydrate resolves that mapping from the bounded
   * root history seed. React/Vue/Svelte/Angular selector effects can mount
   * while that seed is still in flight, so this helper waits for it and then
   * returns `true` when the original placeholder namespace is stale. Returning
   * `true` tells the projection runtime not to open an `/events` subscription
   * for the wrong namespace; the framework will re-render with the promoted
   * card namespace and acquire the real projection.
   */
  async #skipDefaultSubagentProjection(
    namespace: readonly string[],
    threadId: string
  ): Promise<boolean> {
    const toolCallId = defaultSubagentToolCallId(namespace);
    if (toolCallId == null) return false;
    if (!namespaceIsDefaultOnly(this.#subagents.snapshot.get(toolCallId))) {
      return false;
    }
    const seed = this.#discoverySeedPromise;
    if (seed != null) {
      await seed;
    }
    if (this.#disposed || this.#currentThreadId !== threadId) return true;
    return !namespaceIsDefaultOnly(this.#subagents.snapshot.get(toolCallId));
  }

  /**
   * Load and cache the latest checkpoint snapshot for one scoped namespace.
   *
   * `useMessages(stream, subagent)` and `useToolCalls(stream, subagent)` often
   * mount together. Both need the same namespace-specific history page, so the
   * controller keeps an in-flight promise per `threadId + checkpoint_ns`.
   * The cache may already be primed by the hydrate-time discovery history page;
   * otherwise this method performs a narrow `checkpoint_ns` read and derives
   * both projection snapshots from that one response:
   *
   * - `messages` are coerced with the stream-local message coercion rules, so
   *   serialized `content_blocks` and tool-call metadata hydrate correctly.
   * - `toolCalls` are reconstructed from AI tool calls plus matching
   *   ToolMessages, enough for finished/stale card panels without replaying
   *   the `tools` channel.
   *
   * Returns `null` when history does not contain usable values, or the request
   * fails. Callers treat that as a signal to fall back to `/events` so custom
   * servers or unusual state shapes still work.
   */
  #getScopedHistorySeed(
    threadId: string,
    namespace: readonly string[]
  ): Promise<ScopedHistorySeed | null> {
    const checkpointNs = namespaceKey(namespace);
    const key = `${threadId}|${checkpointNs}`;
    const existing = this.#scopedHistorySeeds.get(key);
    if (existing != null) return existing;

    const seed = (async (): Promise<ScopedHistorySeed | null> => {
      try {
        const history = await getHistoryPage(this.#options.client, threadId, {
          limit: 1,
          checkpoint: { checkpoint_ns: checkpointNs },
        });
        const values = history[0]?.values;
        if (values == null || typeof values !== "object") return null;
        const messages = extractAndCoerceMessagesWithFallback(
          values as Record<string, unknown>,
          this.#messagesKey
        );
        if (messages == null) return null;
        return {
          messages,
          toolCalls: seedToolCallsFromMessages(namespace, messages),
        };
      } catch {
        return null;
      }
    })();
    this.#scopedHistorySeeds.set(key, seed);
    return seed;
  }

  /**
   * Reuse the hydrate-time discovery history page as scoped projection data
   * when it already contains checkpoint values for a namespace.
   *
   * The discovery read is required to resolve subagent execution namespaces and
   * subgraph hosts. That same page often includes the latest values for those
   * namespaces, so priming `#scopedHistorySeeds` here lets later
   * `useMessages(stream, subagent)` / `useToolCalls(stream, subagent)` mounts
   * hydrate from memory instead of issuing an immediate second `getHistory`
   * request. If a namespace is not present in the bounded page,
   * `#getScopedHistorySeed` still falls back to a targeted `checkpoint_ns`
   * history read.
   */
  #primeScopedHistorySeedsFromHistory(
    threadId: string,
    history: Array<{
      checkpoint?: { checkpoint_ns?: unknown };
      values?: unknown;
    }>
  ): void {
    for (const state of history) {
      const checkpointNs = state.checkpoint?.checkpoint_ns;
      if (typeof checkpointNs !== "string" || checkpointNs.length === 0) {
        continue;
      }
      const namespace = checkpointNs
        .split(NAMESPACE_SEPARATOR)
        .filter((segment) => segment.length > 0);
      if (namespace.length === 0) continue;
      const key = `${threadId}|${namespaceKey(namespace)}`;
      if (this.#scopedHistorySeeds.has(key)) continue;
      const values = state.values;
      if (values == null || typeof values !== "object") continue;
      const messages = extractAndCoerceMessagesWithFallback(
        values as Record<string, unknown>,
        this.#messagesKey
      );
      if (messages == null) continue;
      this.#scopedHistorySeeds.set(
        key,
        Promise.resolve({
          messages,
          toolCalls: seedToolCallsFromMessages(namespace, messages),
        })
      );
    }
  }

  /**
   * Submit input to the active thread.
   *
   * To resume a pending interrupt, use {@link respond} instead.
   *
   * @param input - Input payload for a new run.
   * @param options - Per-run config, metadata, multitask behavior, and callbacks.
   */
  async submit(
    input: unknown,
    options?: StreamSubmitOptions<StateType, ConfigurableType>
  ): Promise<void> {
    await this.#submitter.submit(input, options);
  }

  /**
   * Disconnect the client from the active run and mark the controller
   * idle. By default also cancels the run server-side; pass
   * `{ cancel: false }` or call {@link disconnect} to keep the agent
   * running (join/rejoin).
   */
  async stop(options?: StreamStopOptions): Promise<void> {
    const shouldCancel = options?.cancel ?? true;
    if (shouldCancel) {
      const threadId = this.#currentThreadId;
      const runId = this.#activeRunId;
      if (threadId != null && runId != null) {
        try {
          await this.#options.client.runs.cancel(threadId, runId);
        } catch {
          /* server cancel failures must not block client disconnect */
        }
      }
    }
    await this.#submitter.stop();
  }

  /**
   * Disconnect the client without cancelling the run server-side.
   * Alias for `stop({ cancel: false })`.
   */
  async disconnect(): Promise<void> {
    return this.stop({ cancel: false });
  }

  #markLocalRunStart(): void {
    this.#localRunDepth += 1;
  }

  #markLocalRunEnd(): void {
    this.#localRunDepth = Math.max(0, this.#localRunDepth - 1);
  }

  #notifyCreated(runId: string): void {
    this.#activeRunId = runId;
    try {
      this.#options.onCreated?.({ runId });
    } catch {
      /* caller-supplied callback errors must not crash the stream */
    }
  }

  #notifyCompleted(
    reason: RunExecutionReason,
    runId = this.#activeRunId
  ): void {
    if (runId != null && runId === this.#activeRunId) {
      this.#activeRunId = undefined;
    }
    setTimeout(() => {
      if (this.#disposed) return;
      try {
        this.#options.onCompleted?.(
          runId == null ? { reason } : { runId, reason }
        );
      } catch {
        /* caller-supplied callback errors must not crash the stream */
      }
    }, 0);
  }

  readonly #runLifecycleListener = (event: Event): void => {
    if (this.#localRunDepth > 0) return;
    if (event.method !== "lifecycle") return;
    if (!isRootNamespace(event.params.namespace)) return;
    if (!this.rootStore.getSnapshot().isLoading) return;
    const lifecycle = (event as LifecycleEvent).params.data as {
      event?: string;
    };
    const reason = lifecycleReason(lifecycle?.event);
    if (reason == null) return;
    this.#notifyCompleted(reason);
  };

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
   * Respond to a single pending protocol interrupt.
   *
   * When `options.interruptId` is omitted, resolution walks
   * {@link ThreadStream.interrupts `thread.interrupts`} from newest to
   * oldest and picks the first entry whose `interruptId` has not already
   * been resolved by a prior `respond()` call. That entry may be at the
   * root (`namespace: []`) or inside a subgraph (non-empty `namespace`).
   * This is **not** the same as {@link RootSnapshot.interrupts
   * `rootStore.interrupts[0]`} / framework `stream.interrupt`, which only
   * mirrors root-namespace interrupts for UI convenience.
   *
   * Omitting `interruptId` is fine when exactly one interrupt is pending.
   * When several can be active (parallel subagents, fan-out, nested
   * graphs), pass an explicit `interruptId` (and `namespace` for subgraph
   * interrupts) so you resume the interrupt the user acted on.
   *
   * To resume several interrupts pending at the same checkpoint in one
   * command, use {@link respondAll} — sequential single `respond()` calls
   * would not work, since the first resume starts a run, leaving the
   * others with no interrupted run to respond to.
   *
   * The server validates `namespace` against the pending interrupt. Root
   * interrupts use `namespace: []` (the default when `namespace` is
   * omitted). Subgraph interrupts require the exact tuple from
   * `getThread()?.interrupts` — see the example below.
   *
   * @param response - Payload sent back to the interrupted namespace.
   * @param options - Optional target (`interruptId` / `namespace`) and
   *   run-level `config` / `metadata` folded into the run that services
   *   the resume (model/user config, trigger source, test flags, …).
   *   Equivalent to the same fields on {@link StreamSubmitOptions}.
   *
   * @example Single pending interrupt (safe to omit a target)
   * ```ts
   * await controller.respond({ approved: true });
   * ```
   *
   * @example Carry run config / metadata onto the resume
   * ```ts
   * await controller.respond(
   *   { approved: true },
   *   { config: { configurable: { model: "gpt-4o" } }, metadata: { source: "ui" } },
   * );
   * ```
   *
   * @example Multiple root interrupts — target by id
   * ```tsx
   * for (const intr of stream.interrupts) {
   *   await stream.respond(decide(intr.value), { interruptId: intr.id! });
   * }
   * ```
   *
   * @example Subgraph interrupt — read `namespace` from the thread stream
   * ```tsx
   * const thread = stream.getThread();
   * for (const entry of thread?.interrupts ?? []) {
   *   await stream.respond(buildResponse(entry.payload), {
   *     interruptId: entry.interruptId,
   *     namespace: entry.namespace,
   *   });
   * }
   * ```
   *
   * Each {@link InterruptPayload} on `thread.interrupts` mirrors an
   * `input.requested` event: `{ interruptId, payload, namespace }`.
   * Nested interrupts may appear here but not on `stream.interrupts`.
   */
  async respond(
    response: unknown,
    options?: StreamRespondOptions<ConfigurableType>
  ): Promise<void> {
    if (this.#disposed || this.#thread == null) {
      throw new Error("No active thread to respond to.");
    }

    const resolved =
      options?.interruptId != null
        ? {
            interruptId: options.interruptId,
            namespace: options.namespace ?? [...ROOT_NAMESPACE],
          }
        : this.#resolveInterruptForResume();
    if (resolved == null) {
      throw new Error("No pending interrupt to respond to.");
    }
    const thread = this.#thread;

    // Apply the state `update` optimistically, mirroring `submit()`: append its
    // messages to the root projection and mint stable ids so the resumed run's
    // echo reconciles by id. Without this the interrupt is cleared the instant
    // `respond()` dispatches while the pushed messages only reappear after a
    // server round-trip — so a HITL "card" pushed via `update` would vanish for
    // that window (the flicker). The id-injected payload is what we dispatch,
    // so the server echoes the same ids back and `#applyValues` flips them
    // `pending` → `sent` in place (no duplicate, no gap).
    const prepared =
      options?.update != null
        ? this.#beginOptimistic(options.update)
        : undefined;
    const dispatchUpdate = this.#resolveDispatchUpdate(
      options?.update,
      prepared
    );

    try {
      // Route through the coordinator so a resumed run that fails (e.g. a
      // missing model key surfaced after the user answers) lands in the
      // reactive `rootStore.error` slot, exactly like a `submit()` failure.
      // The dispatch (`respondInput` + interrupt-resolved bookkeeping) is
      // what's awaited; the resumed run's terminal is watched in the
      // background (see {@link SubmitCoordinator.dispatchResume}), which also
      // settles the optimistic handle (rolls back un-echoed keys on failure).
      await this.#submitter.dispatchResume(async () => {
        await thread.respondInput({
          namespace: resolved.namespace,
          interrupt_id: resolved.interruptId,
          response: normalizeHitlResponseForServer(response),
          // Fold an optional state update / directed jump into the same
          // superstep as the resume (HITL "push card into state + resume").
          // Omitted when absent so the server still sees a plain resume.
          // `BaseMessage` instances under the messages key are serialized to
          // plain dicts (like `submit()`) so they coerce server-side.
          ...(dispatchUpdate != null ? { update: dispatchUpdate } : {}),
          ...(options?.goto != null ? { goto: options.goto } : {}),
          config: options?.config,
          metadata: options?.metadata,
        });
        this.#markInterruptResolvedInRootStore(resolved.interruptId);
      }, prepared?.handle);
    } catch (error) {
      if (this.#disposed && isAbortLikeError(error)) {
        return;
      }
      throw error;
    }
  }

  /**
   * Resume several pending interrupts at the same checkpoint in a single
   * command.
   *
   * Required when a run pauses on multiple interrupts simultaneously
   * (e.g. parallel tool-authorization prompts): a single
   * `Command({ resume })` carrying every interrupt's payload resumes them
   * together. Sequential {@link respond} calls would fail because the
   * first resume starts a run, leaving the rest with no interrupted run to
   * respond to.
   *
   * `responsesById` maps each pending `interruptId` to the payload sent
   * back to it, so different interrupts can receive different responses
   * (approve one, deny another). To send the *same* payload to several
   * interrupts, build the map with that value for each id, e.g.
   * `Object.fromEntries(ids.map((id) => [id, response]))`.
   *
   * The server resumes by `interruptId`, so namespaces are resolved
   * internally from `getThread()?.interrupts` and need not be supplied.
   *
   * @param responsesById - Map of pending `interruptId` to its response
   *   payload. Must contain at least one entry.
   * @param options - Optional run-level `config` / `metadata` folded into
   *   the single run that services the batched resume. Equivalent to the
   *   same fields on {@link StreamSubmitOptions}.
   *
   * @example Distinct payloads per interrupt
   * ```tsx
   * await stream.respondAll({
   *   [interruptA.id]: { approved: true },
   *   [interruptB.id]: { approved: false },
   * });
   * ```
   *
   * @example Same payload to every pending interrupt
   * ```tsx
   * await stream.respondAll(
   *   Object.fromEntries(stream.interrupts.map((i) => [i.id!, { approved: true }])),
   * );
   * ```
   */
  async respondAll(
    responsesById: Record<string, unknown>,
    options?: StreamRespondAllOptions<ConfigurableType>
  ): Promise<void> {
    if (this.#disposed || this.#thread == null) {
      throw new Error("No active thread to respond to.");
    }
    const entries = Object.entries(responsesById);
    if (entries.length === 0) {
      throw new Error("respondAll() requires at least one response.");
    }
    const thread = this.#thread;
    const pending = thread.interrupts;
    const responses = entries.map(([interruptId, response]) => ({
      interrupt_id: interruptId,
      response: normalizeHitlResponseForServer(response),
      namespace: pending.find((entry) => entry.interruptId === interruptId)
        ?.namespace ?? [...ROOT_NAMESPACE],
    }));
    // Apply the run-level `update` optimistically (see `respond()` for the
    // rationale): the batched resume's pushed messages paint immediately and
    // reconcile by id when the single servicing run echoes them back.
    const prepared =
      options?.update != null
        ? this.#beginOptimistic(options.update)
        : undefined;
    const dispatchUpdate = this.#resolveDispatchUpdate(
      options?.update,
      prepared
    );

    try {
      // See `respond()` — route through the coordinator so the single run
      // that services the batched resume surfaces failures on the reactive
      // `rootStore.error` slot and settles the optimistic handle.
      await this.#submitter.dispatchResume(async () => {
        await thread.respondInput({
          responses,
          // A batched resume services every targeted interrupt in one run, so
          // the update / jump are run-level (not per-entry) — applied once in
          // that run's superstep alongside all the resumes. `BaseMessage`
          // instances under the messages key are serialized to plain dicts
          // (like `submit()`) so they coerce server-side.
          ...(dispatchUpdate != null ? { update: dispatchUpdate } : {}),
          ...(options?.goto != null ? { goto: options.goto } : {}),
          config: options?.config,
          metadata: options?.metadata,
        });
        for (const { interrupt_id: interruptId } of responses) {
          this.#markInterruptResolvedInRootStore(interruptId);
        }
      }, prepared?.handle);
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

  // ---------- thread access ----------

  /**
   * Returns the bound {@link ThreadStream}, if one exists. Prefer
   * {@link StreamController.rootStore} and selector projections for
   * UI work; use this for low-level protocol access.
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
   * @param deferRootPump - When `true`, build the ThreadStream and bind
   *   the registry but skip starting the persistent root SSE pump. Used
   *   for client-self-created thread ids whose server-side thread row
   *   doesn't exist yet — opening the pump's `subscription.subscribe`
   *   against a not-yet-existent thread produces a `404: Thread not
   *   found` protocol error that strands terminal lifecycle events and
   *   leaves the UI showing nothing until the user reloads. The pump is
   *   started later via {@link #startDeferredRootPump} after `submitRun`
   *   / `respondInput` commits the thread server-side.
   *
   *   Note: PR 2381's `#runStartReady` gate covers the analogous race
   *   for the in-flight `run.start` send, but only when that send is
   *   already pending. `#ensureThread` runs *before* `submitRun` is
   *   called (and thus before the gate is armed), so on transports
   *   that subscribe synchronously (WebSocket) the deferred path is
   *   still required.
   */
  #ensureThread(threadId: string, deferRootPump = false): ThreadStream {
    if (this.#thread != null) return this.#thread;
    this.#thread = this.#options.client.threads.stream(threadId, {
      assistantId: this.#options.assistantId,
      transport: this.#options.transport,
      fetch: this.#options.fetch,
      webSocketFactory: this.#options.webSocketFactory,
    });
    this.registry.bind(this.#thread);
    if (deferRootPump) {
      // Resolve `#rootPumpReady` immediately so `submit()`'s `await
      // this.#rootPumpReady` doesn't block — the dispatch path only
      // needs the ThreadStream wired up to call `submitRun`, not the
      // persistent subscription.
      this.#rootPumpReady = Promise.resolve();
      this.#rootPumpDeferred = true;
    } else {
      this.#startRootPump(this.#thread);
    }
    this.#notifyThreadListeners();
    return this.#thread;
  }

  /**
   * Start the previously-deferred root SSE pump after the first
   * `submitRun` / `respondInput` has committed the thread server-side.
   *
   * No-op when the pump was started eagerly in {@link #ensureThread}
   * (i.e. for hydrated existing threads, or for any thread whose pump
   * has already been brought up).
   */
  #startDeferredRootPump(): void {
    if (!this.#rootPumpDeferred) return;
    if (this.#thread == null) return;
    this.#rootPumpDeferred = false;
    this.#startRootPump(this.#thread);
  }

  /**
   * Abandon a deferred root pump that never started because its
   * triggering dispatch (`submitRun` / `respondInput`) failed.
   *
   * Without this, the controller would be wedged in a state where:
   *   - `#thread` is wired but no content pump is open
   *   - `#rootPumpDeferred` stays `true`
   *   - `selfCreatedThreadIds` still holds the id
   *
   * A retry submit on the same controller would see
   * `wasSelfCreated=false` (because `currentThreadId` is no longer
   * null), `#ensureThread(id, false)` would early-return because
   * `#thread != null`, and the pump would never start. The thread
   * would have an id committed to the URL but no live subscription.
   *
   * Tearing down `#thread` so the next submit re-runs `#ensureThread`
   * from scratch is the simplest recovery — the failed dispatch
   * means there was nothing to subscribe to anyway.
   */
  #abandonDeferredRootPump(): void {
    if (!this.#rootPumpDeferred) return;
    this.#rootPumpDeferred = false;
    void this.#teardownThread();
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
    this.#rootEventListeners.delete(this.#runLifecycleListener);
    try {
      await this.#rootSubscription?.unsubscribe();
    } catch {
      /* already closed */
    }
    this.#rootSubscription = undefined;
    this.#rootPumpReady = undefined;
    // Reset so a swap to a new thread doesn't carry over a stale
    // deferred flag — `#ensureThread` will set it again if the new
    // thread is self-created.
    this.#rootPumpDeferred = false;
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
    this.#subagents.reset();
    this.#subgraphs.reset();
    this.#scopedHistorySeeds.clear();
    this.#activeRunId = undefined;
    this.#localRunDepth = 0;
    this.#messageMetadata.reset();
    // Drop the hydrate-window allowlist — the next thread's hydrate
    // will repopulate it from that thread's `state.tasks[].interrupts`.
    this.#hydratedActiveInterruptIds = null;
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
    this.#rootEventListeners.add(this.#runLifecycleListener);

    this.#rootPump = (async () => {
      try {
        /**
         * Root content pump: depth 1 is required because the controller
         * classifies tool events at namespace length ≤ 1 as root-level
         * (see `#onWildcardEvent`'s `isRootLevelTool` check). The deep-
         * agent `task` dispatcher fires `tools.tool-started` at
         * `["tools:<id>"]` (length 1), so a depth-0 filter would drop
         * those events server-side before they reached `root.toolCalls`.
         *
         * Deeper content (subagent message tokens, values snapshots) is
         * pulled in on demand by per-namespace selector projections
         * (e.g. `useMessages(sub)`).
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
        step?: unknown;
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
  /**
   * Apply a submit input optimistically to the root projection before
   * the server responds. Mints stable ids for id-less messages (so the
   * server echo reconciles by id), appends them to the projection, and
   * shallow-merges non-message input keys into `values`.
   *
   * Returns the dispatch payload (id-injected) for the coordinator to
   * send, plus an {@link OptimisticHandle} for terminal reconciliation.
   * Returns `undefined` when optimistic UI is disabled or there is
   * nothing to echo, in which case the coordinator dispatches the raw
   * input unchanged.
   *
   * @param input - Raw input passed to `submit()`.
   */
  #beginOptimistic(
    input: unknown
  ): { dispatchInput: unknown; handle: OptimisticHandle } | undefined {
    if (this.#options.optimistic === false) return undefined;
    if (input == null || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }
    const prepared = prepareOptimisticInput(
      input as Record<string, unknown>,
      this.#messagesKey,
      () => uuidv7()
    );
    const extraKeys = Object.keys(prepared.extraValues);
    if (prepared.echoedIds.length === 0 && extraKeys.length === 0) {
      return undefined;
    }

    const currentValues = this.rootStore.getSnapshot().values as Record<
      string,
      unknown
    >;
    const restoreKeys = extraKeys.map((key) => ({
      key,
      hadKey: Object.prototype.hasOwnProperty.call(currentValues, key),
      prevValue: currentValues[key],
    }));

    this.#sawValuesForRun = false;
    // Commit synchronously: this runs inside the user's `submit()` /
    // `respond()` call (before the first await), so the optimistic
    // message lands in the same tick — and therefore the same React /
    // framework commit — as any local UI state the caller flips
    // alongside it. A macrotask-deferred flush would paint the message
    // one tick late, leaving a blink (e.g. a HITL card vanishing between
    // "form hidden" and "resolved card shown").
    this.#rootMessages.appendOptimistic(
      prepared.optimisticMessages,
      prepared.extraValues,
      { sync: true }
    );
    if (prepared.echoedIds.length > 0) {
      this.#messageMetadata.markPending(prepared.echoedIds);
    }
    return {
      dispatchInput: prepared.dispatchInput,
      handle: { echoedIds: prepared.echoedIds, restoreKeys },
    };
  }

  /**
   * Pick the `update` payload to dispatch on a resume (`respond` /
   * `respondAll`).
   *
   * When the optimistic path ran ({@link #beginOptimistic} returned a handle),
   * its `dispatchInput` already carries the minted message ids the server must
   * echo back, so dispatch that — the echo reconciles the optimistic messages
   * by id (no duplicate). Otherwise (optimistic UI disabled, or an `update`
   * with no echoable messages — e.g. the tuple-entry form) fall back to
   * serializing `BaseMessage` instances to dicts, exactly as before. Returns
   * `undefined` when there is no `update`, so the server still sees a plain
   * resume.
   */
  #resolveDispatchUpdate(
    update: Record<string, unknown> | [string, unknown][] | undefined,
    prepared: { dispatchInput: unknown; handle: OptimisticHandle } | undefined
  ): Record<string, unknown> | [string, unknown][] | undefined {
    if (prepared != null) {
      return prepared.dispatchInput as Record<string, unknown>;
    }
    if (update == null) return undefined;
    return serializeUpdateMessages(update, this.#messagesKey);
  }

  /**
   * Reconcile optimistic state when a run terminates.
   *
   *   - Messages: any echoed id still `"pending"` (never echoed by the
   *     server) is flipped to `"sent"` on success/interrupt, or
   *     `"failed"` on failure/abort. Ids the server already echoed were
   *     flipped to `"sent"` in {@link #applyValues} and are untouched.
   *   - Non-message keys: rolled back to their pre-submit values when no
   *     server `values` event landed during the run (otherwise the
   *     server snapshot already reconciled them). Skipped on abort,
   *     where a superseding run (or `stop()`) owns subsequent state.
   *
   * @param handle - Handle returned by {@link #beginOptimistic}.
   * @param event  - Terminal lifecycle event for the run.
   */
  #settleOptimistic(
    handle: OptimisticHandle,
    event: "completed" | "failed" | "interrupted" | "aborted"
  ): void {
    const failed = event === "failed" || event === "aborted";
    this.#messageMetadata.resolvePending(
      handle.echoedIds,
      failed ? "failed" : "sent"
    );
    if (event !== "aborted" && !this.#sawValuesForRun) {
      this.#rootMessages.restoreValueKeys(handle.restoreKeys);
    }
  }

  #applyValues(raw: unknown, checkpoint?: CheckpointEnvelope): void {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return;
    }
    const state = raw as Record<string, unknown>;
    // A root `values` snapshot landed: optimistic non-message keys are
    // now reconciled against server truth (see #settleOptimistic).
    this.#sawValuesForRun = true;
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
    this.#rootMessages.applyValues(nextValues, nextMessages, {
      step: checkpoint?.step,
    });
    if (nextMessages.length > 0) {
      // Any optimistic message the server just echoed is now
      // server-authoritative: flip its status `pending` → `sent`.
      this.#messageMetadata.resolvePending(
        nextMessages
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string"),
        "sent"
      );
      this.rootStore.setState((s) => {
        const toolCalls = reconcileToolCallsFromMessages(
          s.toolCalls,
          nextMessages
        );
        if (toolCalls === s.toolCalls) return s;
        return { ...s, toolCalls };
      });
    }
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
    // Strict allowlist when populated by the most-recent hydrate: SSE
    // replay of `input.requested` carries no signal distinguishing
    // historical (already-resolved) interrupts from live ones, so we
    // accept only ids the server reported as currently active in
    // `state.tasks[].interrupts`. `null` (outside the hydrate window
    // / after a submit clears it) disables filtering entirely so new
    // live interrupts on an active run pass through.
    if (
      this.#hydratedActiveInterruptIds != null &&
      !this.#hydratedActiveInterruptIds.has(interruptId)
    ) {
      return;
    }
    const interrupt: Interrupt<InterruptType> = normalizeInterruptForClient({
      id: interruptId,
      value: data.payload as InterruptType,
    });
    this.rootStore.setState((s) => {
      if (s.interrupts.some((entry) => entry.id === interruptId)) return s;
      const interrupts = [...s.interrupts, interrupt];
      return { ...s, interrupts, interrupt: interrupts[0] };
    });
  }

  /**
   * Mark an interrupt resolved for replay filtering and mirror the
   * removal into the root snapshot the framework hooks read.
   */
  #markInterruptResolvedInRootStore(interruptId: string): void {
    this.#resolvedInterrupts.add(interruptId);
    this.rootStore.setState((s) => {
      const interrupts = s.interrupts.filter(
        (entry) => entry.id !== interruptId
      );
      if (
        interrupts.length === s.interrupts.length &&
        s.interrupt?.id !== interruptId
      ) {
        return s;
      }
      return {
        ...s,
        interrupts,
        interrupt: interrupts[0],
      };
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
    return this.#awaitRootTerminal(signal, {
      skipInterruptedUntilRunning: false,
    });
  }

  /**
   * Resolve on the resumed run's root terminal lifecycle.
   *
   * Unlike {@link #awaitNextTerminal}, ignores `interrupted` events until a
   * root `running` lifecycle has been observed. Headless-tool flows can emit
   * a stale `interrupted` for the run being resumed after `input.requested`
   * but before `respondInput` calls `#prepareForNextRun`; accepting that
   * terminal would unsubscribe the watcher before the resumed run's `failed`
   * terminal arrives.
   */
  #awaitResumedRunTerminal(signal: AbortSignal): Promise<{
    event: "completed" | "failed" | "interrupted" | "aborted";
    error?: string;
  }> {
    return this.#awaitRootTerminal(signal, {
      skipInterruptedUntilRunning: true,
    });
  }

  #awaitRootTerminal(
    signal: AbortSignal,
    options: { skipInterruptedUntilRunning: boolean }
  ): Promise<{
    event: "completed" | "failed" | "interrupted" | "aborted";
    error?: string;
  }> {
    return new Promise((resolve) => {
      let settled = false;
      let sawRunning = false;
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
        if (lifecycle?.event === "running") {
          sawRunning = true;
          return;
        }
        if (lifecycle?.event === "completed") {
          setTimeout(() => finish({ event: "completed" }), 0);
        } else if (lifecycle?.event === "failed") {
          setTimeout(
            () => finish({ event: "failed", error: lifecycle.error }),
            0
          );
        } else if (lifecycle?.event === "interrupted") {
          if (options.skipInterruptedUntilRunning && !sawRunning) {
            return;
          }
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
   * Resolve which protocol interrupt a resume command should target.
   * Headless-tool resumes are keyed by tool-call id; without matching
   * on that id, parallel tool handlers would respond to the wrong
   * interrupt (always the newest).
   */
  #resolveInterruptForResume(resume?: unknown): ResolvedInterrupt | null {
    const thread = this.#thread;
    if (thread == null) return null;
    return resolveInterruptTargetForHeadlessResume(
      resume,
      thread.interrupts,
      this.#resolvedInterrupts
    );
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
 * True when a subagent still sits on its default `tools:<toolCallId>`
 * namespace — i.e. no execution namespace has been observed (via SSE
 * replay) or resolved (via history) yet. Used to gate lazy namespace
 * resolution so already-promoted subagents aren't re-fetched.
 */
function namespaceIsDefaultOnly(
  entry: SubagentDiscoverySnapshot | undefined
): boolean {
  if (entry == null) return false;
  return (
    entry.namespace.length === 1 && entry.namespace[0] === `tools:${entry.id}`
  );
}

function defaultSubagentToolCallId(
  namespace: readonly string[]
): string | undefined {
  if (namespace.length !== 1) return undefined;
  const segment = namespace[0];
  if (!segment.startsWith("tools:")) return undefined;
  const id = segment.slice("tools:".length);
  return id.length > 0 ? id : undefined;
}

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

function extractAndCoerceMessagesWithFallback(
  values: Record<string, unknown>,
  messagesKey: string
): BaseMessage[] | null {
  let raw = values[messagesKey];
  if (!Array.isArray(raw) && messagesKey !== "messages") {
    raw = values.messages;
  }
  if (!Array.isArray(raw)) return null;
  return ensureMessageInstances(
    raw as (Message | BaseMessage)[]
  ) as BaseMessage[];
}

// Unused import guard — `AIMessage` is only referenced by type tests.
void AIMessage;
