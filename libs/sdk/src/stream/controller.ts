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
import { v7 as uuidv7 } from "uuid";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  Channel,
  Event,
  LifecycleEvent,
  MessagesEvent,
  MessageRole,
  MessageStartData,
  ToolsEvent,
  ValuesEvent,
} from "@langchain/protocol";
import type { Interrupt } from "../schema.js";
import type { ThreadStream } from "../client/stream/index.js";
import type { SubscriptionHandle } from "../client/stream/index.js";
import { MessageAssembler } from "../client/stream/messages.js";
import {
  ToolCallAssembler,
  type AssembledToolCall,
} from "../client/stream/handles/tools.js";
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
  assembledMessageToBaseMessage,
  type ExtendedMessageRole,
} from "./assembled-to-message.js";
import type {
  RootEventBus,
  RootSnapshot,
  StreamControllerOptions,
  StreamSubmitOptions,
} from "./types.js";

const ROOT_NAMESPACE: readonly string[] = [];

const EMPTY_METADATA_MAP: MessageMetadataMap = new Map();

/**
 * Gated diagnostic logger for the root event pump. Silent by default so
 * high-frequency streaming runs don't pay for `console.log` formatting
 * on every delta. Opt in from the browser DevTools console by setting
 * `globalThis.__LG_STREAM_DEBUG__ = true` before submitting a run; the
 * logs then show the event ordering / pump transitions needed to
 * diagnose stuck-UI regressions like the fan-out render loop that
 * motivated the resilience try/catch in `#startRootPump`.
 *
 * @param tag - Short category appended to the `lg:` debug prefix.
 * @param args - Values to forward to `console.log` when debug logging is enabled.
 */
function lgDebug(tag: string, ...args: unknown[]): void {
  if (
    (globalThis as { __LG_STREAM_DEBUG__?: boolean }).__LG_STREAM_DEBUG__ !==
    true
  ) {
    return;
  }
  console.log(`[lg:${tag}]`, ...args);
}

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

/**
 * Metadata tracked per message id. Surfaced to applications via
 * `useMessageMetadata(stream, messageId)`. The map is populated as
 * the controller processes `values` / `messages` events; entries
 * whose metadata is not known yet are simply absent (the selector
 * hook then returns `undefined`).
 */
export interface MessageMetadata {
  /**
   * Checkpoint id the message was first observed at. Used by fork /
   * edit flows (`submit(input, { forkFrom: { checkpointId } })`).
   */
  readonly parentCheckpointId: string | undefined;
}

export type MessageMetadataMap = ReadonlyMap<string, MessageMetadata>;

/**
 * Queued submission entry mirrored from the server-side run queue.
 *
 * Populated when `submit()` is called with `multitaskStrategy:
 * "enqueue"` while a run is in flight. The array is snapshot-shaped
 * (readonly) so `useSubmissionQueue()` consumers can compare by
 * identity across React re-renders.
 *
 * Today the controller maintains the queue optimistically on the
 * client and reconciles it with server lifecycle events. Once the
 * server starts emitting a dedicated queue channel (roadmap A0.3)
 * the controller will switch to a pure mirror; the public shape
 * here will not change.
 */
export interface SubmissionQueueEntry<
  StateType extends object = Record<string, unknown>,
> {
  /** Server-side run id when known; client-minted id until the run hits the server. */
  readonly id: string;
  /** The `submit(values, ...)` payload. `null` when the caller passed `null`. */
  readonly values: Partial<StateType> | null | undefined;
  /** Snapshot of the `StreamSubmitOptions` used when enqueueing. */
  readonly options?: StreamSubmitOptions<StateType>;
  /** Wall-clock time the entry was created on the client. */
  readonly createdAt: Date;
}

export type SubmissionQueueSnapshot<
  StateType extends object = Record<string, unknown>,
> = ReadonlyArray<SubmissionQueueEntry<StateType>>;

const EMPTY_QUEUE: SubmissionQueueSnapshot<never> = Object.freeze([]);

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

  #thread: ThreadStream | undefined;
  #currentThreadId: string | null;
  #rootSubscription: SubscriptionHandle<Event> | undefined;
  #rootPump: Promise<void> | undefined;
  #rootPumpReady: Promise<void> | undefined;
  #threadEventUnsubscribe: (() => void) | undefined;
  #runAbort: AbortController | undefined;
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
   * Assemblers that live for the lifetime of a thread; reset on
   * rebind so a fresh thread starts with a clean slate.
   */
  #rootMessageAssembler = new MessageAssembler();
  readonly #rootMessageRoles = new Map<
    string,
    { role: ExtendedMessageRole; toolCallId?: string }
  >();
  readonly #rootMessageIndex = new Map<string, number>();
  /**
   * Message ids observed in the most recent `values.messages`
   * snapshot for the root thread. Used by `#applyValues` to drop
   * stream-assembled messages the server has explicitly removed
   * (e.g. via `RemoveMessage` reducer deltas) while still preserving
   * stream-only messages whose enclosing superstep hasn't emitted a
   * `values` snapshot yet (mid-superstep token streaming).
   */
  #rootValuesMessageIds = new Set<string>();
  #rootToolAssembler = new ToolCallAssembler();
  /**
   * Maps the namespace a tool result is streamed on (`["tools:<uuid>"]`)
   * to the `tool_call_id` reported by that namespace's most recent
   * `tool-started` event. The `messages` channel's `message-start`
   * for a `role: "tool"` response does NOT carry the tool_call_id
   * itself — the correlation lives on the `tools` channel — so we
   * stash it here and look it up when the tool message begins.
   */
  readonly #toolCallIdByNamespace = new Map<string, string>();

  /**
   * Buffers the most recent `Checkpoint` envelope per namespace.
   * Populated by `checkpoints` channel events and consumed by the
   * companion `values` event on the same superstep — the server
   * emits `checkpoints` immediately before its paired `values` so
   * this map is always fresh when `#applyValues` reads it. Clients
   * use the resulting `parentCheckpointId` to target fork / edit
   * flows (`submit(input, { forkFrom: { checkpointId } })`).
   */
  readonly #pendingCheckpointByNamespace = new Map<
    string,
    { id: string; parent_id?: string }
  >();

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
    this.messageMetadataStore = new StreamStore<MessageMetadataMap>(
      EMPTY_METADATA_MAP
    );
    this.queueStore = new StreamStore<SubmissionQueueSnapshot<StateType>>(
      EMPTY_QUEUE as SubmissionQueueSnapshot<StateType>
    );
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
     * — the thread is created lazily by the first `run.input`. Calling
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
      if (state?.checkpoint != null && state.values != null) {
        /**
         * `threads.getState()` returns the legacy `ThreadState` shape
         * where `parent_checkpoint` is an object (`{ thread_id,
         * checkpoint_id, checkpoint_ns }`). Synthesize the v2
         * `Checkpoint` envelope (matching the `checkpoints` channel
         * payload) so hydrated messages also get their
         * `parentCheckpointId` populated for fork / edit flows.
         */
        const checkpointId = state.checkpoint.checkpoint_id;
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
    if (this.#disposed) return;

    /**
     * Honour per-submit `threadId` overrides: rebind to the supplied
     * thread id before dispatching. Mirrors the legacy behaviour of
     * `submit({}, { threadId })` — subsequent submits stay on the new
     * thread unless the hook's own `threadId` prop flips again.
     */
    const overrideThreadId = options?.threadId;
    if (
      overrideThreadId !== undefined &&
      overrideThreadId !== this.#currentThreadId
    ) {
      await this.hydrate(overrideThreadId);
    }

    if (this.#currentThreadId == null) {
      this.#currentThreadId = uuidv7();
      this.#selfCreatedThreadIds.add(this.#currentThreadId);
      this.#options.onThreadId?.(this.#currentThreadId);
      this.rootStore.setState((s) => ({
        ...s,
        threadId: this.#currentThreadId,
      }));
    }
    const thread = this.#ensureThread(this.#currentThreadId);
    if (this.#usesEventStreamTransport()) {
      await this.#rootPumpReady;
    }

    /**
     * Honour `multitaskStrategy` when a run is already in flight. Only
     * `rollback` (the default) and `enqueue` / `reject` are resolved
     * client-side today; `interrupt` is forwarded as a server hint
     * (roadmap A0.3) and currently falls back to `rollback`.
     */
    const strategy = options?.multitaskStrategy ?? "rollback";
    const hasActiveRun =
      this.#runAbort != null && !this.#runAbort.signal.aborted;
    if (hasActiveRun && strategy === "reject") {
      throw new Error(
        "submit() rejected: a run is already in flight and multitaskStrategy is 'reject'."
      );
    }
    if (hasActiveRun && strategy === "enqueue") {
      this.#enqueueSubmission(input, options);
      return;
    }

    this.#runAbort?.abort();
    const abort = new AbortController();
    this.#runAbort = abort;

    const resumeCommand = options?.command?.resume;
    const isResume = resumeCommand !== undefined;

    this.rootStore.setState((s) => ({
      ...s,
      interrupts: [],
      interrupt: undefined,
      error: undefined,
      isLoading: true,
    }));

    const boundConfig = bindThreadConfig(
      options?.config,
      this.#currentThreadId
    );

    /**
     * Register the terminal-lifecycle listener on the root bus BEFORE
     * dispatching the command that triggers the run. The root pump
     * fans events out synchronously on arrival, so a late
     * registration could miss the terminal for short-lived runs
     * (particularly `input.respond` which the server can complete in
     * a single round-trip).
     */
    const terminalPromise = this.#awaitNextTerminal(abort.signal);

    try {
      if (isResume) {
        const target = this.#latestUnresolvedInterrupt();
        if (target == null) {
          throw new Error(
            "submit({ command: { resume } }) called but no pending protocol interrupt is available."
          );
        }
        await thread.respondInput({
          namespace: target.namespace,
          interrupt_id: target.interruptId,
          response: resumeCommand,
        });
        this.#resolvedInterrupts.add(target.interruptId);
      } else {
        const result = await thread.submitRun({
          input: input ?? null,
          config: boundConfig,
          metadata: (options?.metadata ?? undefined) as Record<string, unknown>,
          forkFrom: options?.forkFrom,
          multitaskStrategy:
            options?.multitaskStrategy === "enqueue"
              ? "enqueue"
              : options?.multitaskStrategy,
        });
        this.#options.onCreated?.({
          run_id: result.run_id as string,
          thread_id: this.#currentThreadId,
        });
      }

      const terminal = await terminalPromise;
      if (terminal.event === "failed" && !abort.signal.aborted) {
        const runError = new Error(
          terminal.error ?? "Run failed with no error message"
        );
        this.rootStore.setState((s) => ({ ...s, error: runError }));
        try {
          options?.onError?.(runError);
        } catch {
          /* caller-supplied callback errors must not crash the submit */
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.rootStore.setState((s) => ({ ...s, error }));
        try {
          options?.onError?.(error);
        } catch {
          /* caller-supplied callback errors must not crash the submit */
        }
      }
    } finally {
      this.rootStore.setState((s) => ({ ...s, isLoading: false }));
      if (this.#runAbort === abort) this.#runAbort = undefined;
      /**
       * Drain the client-side submission queue. Entries enqueued via
       * `multitaskStrategy: "enqueue"` while this run was in flight
       * are dispatched sequentially now that the transport is idle.
       * Matches the legacy `StreamOrchestrator.#drainQueue` behaviour.
       * Defer to a macrotask so the outer submit's promise fully
       * settles (and framework bindings observe `isLoading: false`)
       * before the next run starts.
       */
      setTimeout(() => this.#drainQueue(), 0);
    }
  }

  /**
   * Start the next queued submission once the active run has settled.
   */
  #drainQueue(): void {
    if (this.#disposed) return;
    if (this.#runAbort != null && !this.#runAbort.signal.aborted) return;
    const current = this.queueStore.getSnapshot();
    if (current.length === 0) return;
    const [next, ...rest] = current;
    this.queueStore.setState(() => rest);
    /**
     * Strip the original `multitaskStrategy` so the dequeued run
     * dispatches immediately instead of being re-enqueued on top of
     * itself. Any other options the caller supplied (config, metadata,
     * onError, …) are preserved verbatim.
     */
    const nextOptions: StreamSubmitOptions<StateType, ConfigurableType> = {
      ...((next.options ?? {}) as StreamSubmitOptions<
        StateType,
        ConfigurableType
      >),
      multitaskStrategy: undefined,
    };
    void this.submit(next.values, nextOptions).catch(() => {
      /* submit() already routes errors through the per-submit onError
       * hook and the root store; swallow here so a failing drain does
       * not surface as an unhandled rejection. */
    });
  }

  /**
   * Abort the currently tracked run and mark the controller idle.
   */
  async stop(): Promise<void> {
    this.#runAbort?.abort();
    this.#runAbort = undefined;
    this.rootStore.setState((s) => ({ ...s, isLoading: false }));
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
    const current = this.queueStore.getSnapshot();
    const next = current.filter((entry) => entry.id !== id);
    if (next.length === current.length) return false;
    this.queueStore.setState(() => next);
    return true;
  }

  /**
   * Drop every queued submission. Server-side cancel arrives with A0.3.
   */
  async clearQueue(): Promise<void> {
    this.queueStore.setState(
      () => EMPTY_QUEUE as SubmissionQueueSnapshot<StateType>
    );
  }

  /**
   * Add a submission to the optimistic client-side queue.
   *
   * @param input - Input payload that will be submitted when the queue drains.
   * @param options - Original submit options to replay with the queued input.
   */
  #enqueueSubmission(
    input: unknown,
    options?: StreamSubmitOptions<StateType, ConfigurableType>
  ): void {
    const entry: SubmissionQueueEntry<StateType> = {
      id: uuidv7(),
      values: (input ?? undefined) as Partial<StateType> | null | undefined,
      options: options as StreamSubmitOptions<StateType> | undefined,
      createdAt: new Date(),
    };
    this.queueStore.setState((current) => [...current, entry]);
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
    await this.#thread.respondInput({
      namespace: resolved.namespace,
      interrupt_id: resolved.interruptId,
      response,
    });
    this.#resolvedInterrupts.add(resolved.interruptId);
  }

  /**
   * Dispose the active thread, subscriptions, registry entries, and listeners.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#cancelPendingDispose();
    this.#disposed = true;
    this.#runAbort?.abort();
    this.#runAbort = undefined;
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
    this.#rootEventListeners.delete(this.#persistentLifecycleListener);
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
    this.#rootMessageAssembler = new MessageAssembler();
    this.#rootMessageRoles.clear();
    this.#rootMessageIndex.clear();
    this.#rootValuesMessageIds = new Set();
    this.#rootToolAssembler = new ToolCallAssembler();
    this.#toolCallIdByNamespace.clear();
    this.messageMetadataStore.setState(() => EMPTY_METADATA_MAP);
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
    this.#rootEventListeners.add(this.#persistentLifecycleListener);

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
        const subscription = await thread.subscribe({
          channels: [...ROOT_PUMP_CHANNELS] as Channel[],
          namespaces: [[] as string[]],
          depth: 1,
        });
        lgDebug("root-pump.subscribed", {
          channels: [...ROOT_PUMP_CHANNELS],
          subId: subscription.subscriptionId,
        });
        this.#rootSubscription = subscription;
        resolveReady?.();
        resolveReady = undefined;
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
        let iterationCount = 0;
        while (!this.#disposed) {
          iterationCount += 1;
          let perIterCount = 0;
          lgDebug("root-pump.iter-start", { iterationCount });
          for await (const event of subscription) {
            if (this.#disposed) {
              lgDebug("root-pump.disposed-break", {
                iterationCount,
                perIterCount,
              });
              break;
            }
            perIterCount += 1;
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
             * underlying component bug is still reported via `lgDebug`
             * (opt in with `globalThis.__LG_STREAM_DEBUG__ = true` in
             * DevTools to surface the full stack for diagnosis) — but
             * the pump's correctness guarantees do not depend on any
             * consumer behaving well.
             */
            try {
              this.#onRootEvent(event);
            } catch (err) {
              const errObj = err as Error;
              const evSeq = (event as unknown as { seq?: number }).seq;
              const evEventKind = (
                event.params.data as { event?: string } | undefined
              )?.event;
              lgDebug("root-event.THREW", {
                seq: evSeq,
                method: event.method,
                ns: event.params.namespace,
                event: evEventKind,
                error: errObj?.message,
                stack: errObj?.stack,
              });
            }
          }
          lgDebug("root-pump.iter-end", {
            iterationCount,
            perIterCount,
            disposed: this.#disposed,
            isPaused: subscription.isPaused,
          });
          if (this.#disposed) break;
          if (!subscription.isPaused) {
            lgDebug("root-pump.exit-not-paused", { iterationCount });
            break;
          }
          await subscription.waitForResume();
          lgDebug("root-pump.resumed", { iterationCount });
        }
        lgDebug("root-pump.loop-exit", { iterationCount });
      } catch (err) {
        resolveReady?.();
        resolveReady = undefined;
        lgDebug("root-pump.error", { error: String(err) });
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
    this.#subagents.push(event);
    this.#subgraphs.push(event);

    /**
     * Nested `input.requested` events (HITL inside a subagent /
     * subgraph) are not observable via the narrow content pump. The
     * `ThreadStream` itself already records them into
     * `thread.interrupts`, which `#latestUnresolvedInterrupt()`
     * consults — so HITL respond() works for any depth. Root-level
     * interrupts stay in `rootStore.interrupts` via `#onRootEvent`.
     */
    void event;
  }

  /**
   * Bound root-lifecycle listener that keeps `isLoading` in sync with
   * the actual server-side run state. Installed when the root pump is
   * started so it lives for the entire thread-stream lifetime.
   *
   * Not wired through `#awaitNextTerminal` — that helper is one-shot
   * and scoped to the current `submit()` call. For re-attach on
   * mount we need an always-on listener so hydrated-into-in-flight
   * runs also flip `isLoading` correctly.
   *
   * @param event - Root-bus event to inspect for lifecycle transitions.
   */
  readonly #persistentLifecycleListener = (event: Event): void => {
    if (event.method !== "lifecycle") return;
    if (event.params.namespace.length !== 0) return;
    const lifecycle = (event as LifecycleEvent).params.data as {
      event?: string;
    };
    if (lifecycle?.event === "running") {
      this.rootStore.setState((s) =>
        s.isLoading ? s : { ...s, isLoading: true }
      );
      return;
    }
    if (
      lifecycle?.event === "completed" ||
      lifecycle?.event === "failed" ||
      lifecycle?.event === "interrupted" ||
      lifecycle?.event === "cancelled"
    ) {
      this.rootStore.setState((s) =>
        s.isLoading ? { ...s, isLoading: false } : s
      );
    }
  };

  /**
   * Process one root-pump event and update all root projections.
   *
   * @param event - Event yielded by the root subscription.
   */
  #onRootEvent(event: Event): void {
    const evSeq = (event as unknown as { seq?: number }).seq;
    const evEventKind = (event.params.data as { event?: string } | undefined)
      ?.event;
    lgDebug("root-event", {
      seq: evSeq,
      method: event.method,
      ns: event.params.namespace,
      event: evEventKind,
    });
    /**
     * Discovery runners are fed by the wildcard lifecycle watcher via
     * `thread.onEvent` so deeply-nested subagents/subgraphs are
     * discovered even when the content pump stays narrow. See
     * `#onWildcardEvent`.
     */

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
    const isInternalNamespace = event.params.namespace.some(
      (seg) => seg.startsWith("task:") || seg.startsWith("tools:")
    );
    const isLegacySubagentNamespace = event.params.namespace.some((seg) =>
      seg.startsWith("task:")
    );

    if (event.method === "messages") {
      if (!isInternalNamespace) {
        this.#onRootMessage(event as MessagesEvent);
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
        event.params.namespace.length <= 1 && !isLegacySubagentNamespace;
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
          this.#toolCallIdByNamespace.set(
            namespaceKey(event.params.namespace),
            toolData.tool_call_id
          );
        }
        const tc = this.#rootToolAssembler.consume(event as ToolsEvent);
        if (tc != null) {
          this.rootStore.setState((s) => ({
            ...s,
            toolCalls: appendToolCall(s.toolCalls, tc),
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
     * event at the same namespace can pair with it in
     * `#applyValues` (see `#pendingCheckpointByNamespace`). The
     * buffer is read-and-cleared on consumption so a subsequent
     * `values` event without a new checkpoint doesn't reuse stale
     * metadata.
     */
    if (event.method === "checkpoints") {
      const data = event.params.data as {
        id?: unknown;
        parent_id?: unknown;
      } | null;
      if (data != null && typeof data.id === "string") {
        const envelope: { id: string; parent_id?: string } = { id: data.id };
        if (typeof data.parent_id === "string") {
          envelope.parent_id = data.parent_id;
        }
        this.#pendingCheckpointByNamespace.set(
          namespaceKey(event.params.namespace),
          envelope
        );
      }
      return;
    }

    // Channels below are only meaningful at the root namespace.
    const isRoot = event.params.namespace.length === 0;
    if (!isRoot) return;

    if (event.method === "values") {
      const valuesEvent = event as ValuesEvent;
      const rootKey = namespaceKey(event.params.namespace);
      const bufferedCheckpoint =
        this.#pendingCheckpointByNamespace.get(rootKey);
      if (bufferedCheckpoint != null) {
        this.#pendingCheckpointByNamespace.delete(rootKey);
      }
      this.#applyValues(valuesEvent.params.data, bufferedCheckpoint);
      return;
    }

    if (event.method === "input.requested") {
      const data = event.params.data as {
        interrupt_id?: string;
        payload?: unknown;
      };
      const interruptId = data?.interrupt_id;
      if (
        typeof interruptId === "string" &&
        !this.#resolvedInterrupts.has(interruptId)
      ) {
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
   * Fold a root `messages` event into the class-message projection.
   *
   * @param event - Protocol messages event from a root-owned namespace.
   */
  #onRootMessage(event: MessagesEvent): void {
    const data = event.params.data;
    if (data.event === "message-start") {
      const startData = data as MessageStartData;
      const role = (startData.role ?? "ai") as MessageRole;
      const extendedRole =
        (startData as { role?: ExtendedMessageRole }).role ?? role;
      let toolCallId = (startData as { tool_call_id?: string }).tool_call_id;
      /**
       * Tool-role messages don't carry `tool_call_id` on the
       * `message-start` event itself — the correlation lives in
       * the message id, which follows the LangGraph convention
       * `run-<run_id>-tool-<tool_call_id>` (multiple tool calls
       * can execute under the same `tools:<uuid>` namespace, so a
       * namespace-keyed map alone would collide on parallel tool
       * invocations). We also fall back to the `namespace →
       * tool_call_id` map from the `tools` channel's
       * `tool-started` event for tool messages whose id doesn't
       * follow that format.
       *
       * Without this recovery the resulting ToolMessage has
       * `tool_call_id: ""`, so the UI can't pair it with the
       * AI's `tool_calls[].id` and the tool result renders in
       * its own bubble with a perpetually-"pending" status pill.
       */
      if (extendedRole === "tool" && toolCallId == null) {
        const messageId = startData.id;
        if (messageId != null) {
          const match = /-tool-(.+)$/.exec(messageId);
          if (match != null) toolCallId = match[1];
        }
        if (toolCallId == null) {
          toolCallId = this.#toolCallIdByNamespace.get(
            namespaceKey(event.params.namespace)
          );
        }
      }
      if (startData.id != null) {
        this.#rootMessageRoles.set(startData.id, {
          role: extendedRole,
          toolCallId,
        });
      }
    }

    const update = this.#rootMessageAssembler.consume(event);
    const id = update.message.id;
    if (id == null) return;
    const captured = this.#rootMessageRoles.get(id) ?? { role: "ai" as const };
    const base = assembledMessageToBaseMessage(update.message, captured.role, {
      toolCallId: captured.toolCallId,
    });

    this.rootStore.setState((s) => {
      const existingIdx = this.#rootMessageIndex.get(id);
      if (existingIdx == null) {
        this.#rootMessageIndex.set(id, s.messages.length);
        return { ...s, messages: [...s.messages, base] };
      }
      if (messagesEqual(s.messages[existingIdx], base)) {
        return s;
      }
      const messages = s.messages.slice();
      messages[existingIdx] = base;
      return { ...s, messages };
    });
  }

  /**
   * Merge a `values` payload into root values and root messages.
   *
   * @param raw - Raw `values` channel payload.
   * @param checkpoint - Optional checkpoint envelope paired with the values event.
   */
  #applyValues(
    raw: unknown,
    checkpoint?: { id: string; parent_id?: string }
  ): void {
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
      this.#recordMessageMetadata(
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
    this.rootStore.setState((s) => {
      if (nextMessages.length === 0) {
        return stateValuesShallowEqual(s.values, nextValues, this.#messagesKey)
          ? s
          : { ...s, values: nextValues };
      }
      /**
       * Merge `values.messages` with the stream-assembled projection.
       *
       * The `messages` channel delivers token-level deltas that we
       * fold into `s.messages` via `#onRootMessage`. Those streamed
       * messages are also echoed back in the `values` snapshot when
       * a superstep finishes — but wholesale replacing with
       * `values.messages` here would stomp on any in-progress
       * streaming message (the user would see the final turn appear
       * in a single render instead of streaming token-by-token).
       *
       * Strategy: for each message in `values.messages`, prefer the
       * stream-assembled version if we have one for the same id.
       * `values.messages` remains authoritative for ORDER and for
       * non-streamed messages (human turns, tool results serialised
       * from state, subagent echoes, …). New ids in values that we
       * haven't seen via the channel are appended verbatim.
       */
      const valueIds = new Set<string>();
      const merged = nextMessages.map((msg) => {
        const id = msg.id;
        if (id != null) valueIds.add(id);
        if (id == null) return msg;
        const streamIdx = this.#rootMessageIndex.get(id);
        if (streamIdx == null) return msg;
        const streamed = s.messages[streamIdx];
        if (streamed == null) return msg;
        return shouldPreferValuesMessageForToolCalls(msg, streamed)
          ? msg
          : streamed;
      });
      /**
       * Preserve any stream-assembled messages that haven't yet been
       * echoed into `values.messages`. This happens when a node emits
       * token deltas before the enclosing superstep's values snapshot
       * lands — e.g. the next assistant turn is already streaming
       * while we receive a values event describing the previous
       * superstep. Without this, the merge would truncate them and
       * the UI would flash between renders.
       *
       * Stream-only messages that WERE in a prior values snapshot but
       * disappeared from this one are treated as explicit removals
       * (server-side `RemoveMessage` reducer deltas) and dropped.
       * Without this exclusion, RemoveMessage would be silently
       * ignored on the client and the removed turn would linger in
       * the projection forever.
       */
      for (const existing of s.messages) {
        const id = existing.id;
        if (id == null) continue;
        if (valueIds.has(id)) continue;
        if (this.#rootValuesMessageIds.has(id)) continue;
        merged.push(existing);
      }
      /**
       * Record the authoritative ids from THIS values snapshot.
       * Stream-only messages (preserved via `merged.push` above)
       * stay absent here so a subsequent frame that still hasn't
       * echoed them isn't treated as a remove — only messages that
       * actually appeared in a values payload then disappeared
       * count as a RemoveMessage.
       */
      this.#rootValuesMessageIds = valueIds;
      const messages = messagesEqualList(s.messages, merged)
        ? s.messages
        : merged;
      const values = {
        ...(nextValues as Record<string, unknown>),
        [this.#messagesKey]: messages,
      } as StateType;
      if (
        messages === s.messages &&
        stateValuesShallowEqual(s.values, values, this.#messagesKey)
      ) {
        return s;
      }
      /**
       * Keep `rootMessageIndex` aligned with the new positions so
       * subsequent channel deltas still resolve the right slot.
       */
      this.#rootMessageIndex.clear();
      messages.forEach((msg, idx) => {
        if (msg.id != null) this.#rootMessageIndex.set(msg.id, idx);
      });
      return {
        ...s,
        values,
        messages,
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
   * triggers the run (`thread.run.input` / `thread.input.respond`)
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
      const finish = (result: {
        event: "completed" | "failed" | "interrupted" | "aborted";
        error?: string;
      }) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal.removeEventListener("abort", finishAborted);
        resolve(result);
      };
      const finishAborted = () => finish({ event: "aborted" });
      const unsubscribe = this.#rootBus.subscribe((event) => {
        if (settled) return;
        if (event.method !== "lifecycle") return;
        if (event.params.namespace.length !== 0) return;
        const lifecycle = (event as LifecycleEvent).params.data as {
          event?: string;
          error?: string;
        };
        if (lifecycle?.event === "completed") {
          finish({ event: "completed" });
        } else if (lifecycle?.event === "failed") {
          finish({ event: "failed", error: lifecycle.error });
        } else if (lifecycle?.event === "interrupted") {
          finish({ event: "interrupted" });
        }
      });
      if (signal.aborted) {
        finishAborted();
      } else {
        signal.addEventListener("abort", finishAborted, { once: true });
      }
    });
  }

  /**
   * Merge `metadata` into every entry keyed by a message id. Only
   * writes when at least one entry actually changes so subscribers
   * don't see unnecessary re-renders.
   *
   * @param messages - Messages whose ids should receive the metadata.
   * @param metadata - Metadata fields to merge for each message id.
   */
  #recordMessageMetadata(
    messages: Array<{ id?: string }>,
    metadata: MessageMetadata
  ): void {
    const current = this.messageMetadataStore.getSnapshot();
    let changed = false;
    const next = new Map(current);
    for (const msg of messages) {
      const id = msg?.id;
      if (typeof id !== "string" || id.length === 0) continue;
      const prev = next.get(id);
      if (
        prev != null &&
        prev.parentCheckpointId === metadata.parentCheckpointId
      ) {
        continue;
      }
      next.set(id, { ...prev, ...metadata });
      changed = true;
    }
    if (changed) this.messageMetadataStore.setState(() => next);
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
 * Merge a thread id into the submit config's `configurable` object.
 *
 * @param config - Caller-supplied run config, if any.
 * @param threadId - Thread id to bind into `config.configurable.thread_id`.
 */
function bindThreadConfig(
  config: unknown,
  threadId: string
): Record<string, unknown> {
  const base =
    config != null && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {};
  const configurable =
    base.configurable != null && typeof base.configurable === "object"
      ? (base.configurable as Record<string, unknown>)
      : {};
  return {
    ...base,
    configurable: {
      ...configurable,
      thread_id: threadId,
    },
  };
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

/**
 * Insert or replace an assembled tool call by call id.
 *
 * @param current - Existing root tool-call projection.
 * @param next - Newly assembled tool-call snapshot.
 */
function appendToolCall(
  current: AssembledToolCall[],
  next: AssembledToolCall
): AssembledToolCall[] {
  const idx = current.findIndex((c) => c.callId === next.callId);
  if (idx < 0) return [...current, next];
  const out = current.slice();
  out[idx] = next;
  return out;
}

/**
 * Decide whether a values message carries tool-call data missing from the streamed message.
 *
 * @param valuesMessage - Message from the authoritative `values.messages` payload.
 * @param streamedMessage - Message assembled from the `messages` channel.
 */
function shouldPreferValuesMessageForToolCalls(
  valuesMessage: BaseMessage,
  streamedMessage: BaseMessage
): boolean {
  const valuesToolCalls = getMessageToolCalls(valuesMessage);
  if (valuesToolCalls.length === 0) return false;

  const streamedToolCalls = getMessageToolCalls(streamedMessage);
  if (streamedToolCalls.length < valuesToolCalls.length) return true;

  const streamedIds = new Set(
    streamedToolCalls
      .map((toolCall) => toolCall.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );
  return valuesToolCalls.some((toolCall) => {
    return typeof toolCall.id === "string" && !streamedIds.has(toolCall.id);
  });
}

/**
 * Read normalized tool-call descriptors from a message instance.
 *
 * @param message - Message that may carry `tool_calls`.
 */
function getMessageToolCalls(
  message: BaseMessage
): Array<{ id?: string; name?: string }> {
  const raw = (message as unknown as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (toolCall): toolCall is { id?: string; name?: string } =>
      toolCall != null && typeof toolCall === "object"
  );
}

/**
 * Compare two message arrays by semantic message content.
 *
 * @param previous - Current message projection.
 * @param next - Candidate message projection.
 */
function messagesEqualList(
  previous: readonly BaseMessage[],
  next: readonly BaseMessage[]
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let i = 0; i < previous.length; i += 1) {
    if (!messagesEqual(previous[i], next[i])) return false;
  }
  return true;
}

/**
 * Compare two messages by the fields that affect UI rendering and stream state.
 *
 * @param previous - Current message instance.
 * @param next - Candidate message instance.
 */
function messagesEqual(
  previous: BaseMessage | undefined,
  next: BaseMessage | undefined
): boolean {
  if (previous === next) return true;
  if (previous == null || next == null) return false;
  const previousRecord = previous as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  const previousType =
    typeof previous.getType === "function"
      ? previous.getType()
      : previousRecord.type;
  const nextType =
    typeof next.getType === "function" ? next.getType() : nextRecord.type;

  return (
    previous.id === next.id &&
    previousType === nextType &&
    jsonishEqual(previous.content, next.content) &&
    previousRecord.tool_call_id === nextRecord.tool_call_id &&
    previousRecord.status === nextRecord.status &&
    jsonishEqual(
      previousRecord.additional_kwargs,
      nextRecord.additional_kwargs
    ) &&
    jsonishEqual(
      previousRecord.response_metadata,
      nextRecord.response_metadata
    ) &&
    jsonishEqual(previousRecord.tool_calls, nextRecord.tool_calls) &&
    jsonishEqual(
      previousRecord.tool_call_chunks,
      nextRecord.tool_call_chunks
    ) &&
    jsonishEqual(previousRecord.usage_metadata, nextRecord.usage_metadata)
  );
}

/**
 * Shallow-compare root values while treating equivalent message arrays as stable.
 *
 * Root state can contain arbitrary user payloads, so avoid recursively walking it
 * on every streaming event. Message identity is handled separately by
 * {@link messagesEqualList}; non-message fields are compared by reference.
 *
 * @param previous - Current root values object.
 * @param next - Candidate root values object.
 * @param messagesKey - Key that contains the message array.
 */
function stateValuesShallowEqual(
  previous: object,
  next: object,
  messagesKey: string
): boolean {
  if (previous === next) return true;
  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const previousKeys = Object.keys(previousRecord);
  const nextKeys = Object.keys(nextRecord);
  if (previousKeys.length !== nextKeys.length) return false;
  for (const key of previousKeys) {
    if (!Object.prototype.hasOwnProperty.call(nextRecord, key)) return false;
    const previousValue = previousRecord[key];
    const nextValue = nextRecord[key];
    if (
      key === messagesKey &&
      Array.isArray(previousValue) &&
      Array.isArray(nextValue)
    ) {
      continue;
    }
    if (!Object.is(previousValue, nextValue)) return false;
  }
  return true;
}

/**
 * Compare render-relevant message fields without serializing whole objects.
 *
 * @param previous - Current value.
 * @param next - Candidate value.
 */
function jsonishEqual(previous: unknown, next: unknown): boolean {
  return jsonishEqualAtDepth(previous, next, 0);
}

/**
 * Recursively compare JSON-like values up to a bounded depth.
 *
 * @param previous - Current value.
 * @param next - Candidate value.
 * @param depth - Current recursion depth; comparison stops after a small limit.
 */
function jsonishEqualAtDepth(
  previous: unknown,
  next: unknown,
  depth: number
): boolean {
  if (Object.is(previous, next)) return true;
  if (previous == null || next == null) return false;
  if (typeof previous !== "object" || typeof next !== "object") return false;
  if (depth >= 4) return false;

  if (Array.isArray(previous) || Array.isArray(next)) {
    if (!Array.isArray(previous) || !Array.isArray(next)) return false;
    if (previous.length !== next.length) return false;
    for (let i = 0; i < previous.length; i += 1) {
      if (!jsonishEqualAtDepth(previous[i], next[i], depth + 1)) return false;
    }
    return true;
  }

  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const previousKeys = Object.keys(previousRecord).filter(
    (key) => typeof previousRecord[key] !== "function"
  );
  const nextKeys = Object.keys(nextRecord).filter(
    (key) => typeof nextRecord[key] !== "function"
  );
  if (previousKeys.length !== nextKeys.length) return false;

  for (const key of previousKeys) {
    if (!Object.prototype.hasOwnProperty.call(nextRecord, key)) return false;
    if (!jsonishEqualAtDepth(previousRecord[key], nextRecord[key], depth + 1)) {
      return false;
    }
  }
  return true;
}

/**
 * Stable string key for a `namespace` tuple. Uses `\u0000` as the
 * segment separator so it can't collide with a legitimate namespace
 * segment (which protocol-side is always a printable identifier).
 *
 * @param namespace - Namespace path segments to join.
 */
function namespaceKey(namespace: readonly string[]): string {
  return namespace.join("\u0000");
}

// Unused import guard — `AIMessage` is only referenced by type tests.
void AIMessage;
