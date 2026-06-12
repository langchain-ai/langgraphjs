import type {
  Channel,
  Command,
  CommandResponse,
  Event,
  InputRespondParams,
  LifecycleEvent,
  ListCheckpointsResult,
  Message,
  MessagesEvent,
  Namespace,
  RunResult,
  StateForkResult,
  StateGetResult,
  SubscribeParams,
  SubscribeResult,
  ToolsEvent,
  ValuesEvent,
} from "@langchain/protocol";
import { matchesSubscription } from "./subscription.js";
import { MultiCursorBuffer } from "./multi-cursor-buffer.js";
import { ensureMessageInstances } from "../../ui/messages.js";
import {
  ToolCallAssembler,
  toClientAssembledToolCall,
  SubgraphDiscoveryHandle,
  SubgraphHandle,
  SubagentDiscoveryHandle,
  SubagentHandle,
} from "./handles/index.js";
import type { ClientAssembledToolCall } from "./handles/tools.js";
import {
  StreamingMessageAssembler,
  toStreamingMessageHandle,
} from "./messages.js";
import type { StreamingMessageHandle } from "./messages.js";
import { MediaAssembler } from "./media.js";
import type {
  AnyMediaHandle,
  AudioMedia,
  FileMedia,
  ImageMedia,
  VideoMedia,
} from "./media.js";
import type {
  EventSubscription,
  EventForChannel,
  EventForChannels,
  InterruptPayload,
  ThreadExtension,
  ThreadExtensions,
  ThreadModules,
  ThreadStreamOptions,
  SessionOrderingState,
  SubscribeOptions,
  YieldForChannel,
  YieldForChannels,
} from "./types.js";
import type { EventStreamHandle, TransportAdapter } from "./transport.js";
import { ProtocolError } from "./error.js";
import { NAMESPACE_SEPARATOR } from "../../stream/constants.js";
import { isHeadlessToolInterrupt } from "../../headless-tools.js";

type PendingCommand = {
  resolve: (response: CommandResponse) => void;
  reject: (error: Error) => void;
};

type CommandResultMap = {
  "run.start": RunResult;
  "subscription.subscribe": SubscribeResult;
  "subscription.unsubscribe": Record<string, unknown>;
  "agent.getTree": Record<string, unknown>;
  "input.respond": Record<string, unknown>;
  "input.inject": Record<string, unknown>;
  "state.get": StateGetResult;
  "state.listCheckpoints": ListCheckpointsResult;
  "state.fork": StateForkResult;
};

type CommandParamsMap = {
  "run.start": Record<string, unknown>;
  "subscription.subscribe": SubscribeParams;
  "subscription.unsubscribe": { subscription_id: string };
  "agent.getTree": { run_id?: string };
  "input.respond": InputRespondParams;
  "input.inject": Record<string, unknown>;
  "state.get": Record<string, unknown>;
  "state.listCheckpoints": Record<string, unknown>;
  "state.fork": Record<string, unknown>;
};

type InternalEventSubscription = EventSubscription<unknown> & {
  filter: SubscribeParams;
  push(event: Event): void;
  close(): void;
  pause(): void;
  resume(): void;
  /**
   * Highest sequence observed by the thread before this subscription was
   * registered. Replayed terminal events at or before this point belong to a
   * run that already ended before the subscription existed, so they must not
   * pause the subscription before it can drain server replay.
   */
  registeredAfterSeq: number | undefined;
  /**
   * Per-subscription dedup window. Guards against redelivery during
   * shared-stream rotation overlap and from WebSocket server-side
   * fan-out, while still letting newly-registered subs receive the
   * replayed events that existing subs already consumed. Event IDs
   * are session-local but stable across sessions for the same run
   * (the session's monotonic `_next_seq` processes events in order),
   * so a set-per-sub is sufficient.
   */
  seenEventIds: Set<string>;
};

type PendingSubResolve = {
  filter: SubscribeParams;
  resolve: () => void;
  reject: (err: unknown) => void;
};

const MESSAGE_LIKE_TYPES = new Set([
  "human",
  "user",
  "ai",
  "assistant",
  "tool",
  "system",
  "function",
  "remove",
]);

/**
 * When the state payload has a `messages` array containing plain
 * serialized messages (objects with a recognized `type` field), coerce
 * them into `@langchain/core/messages` class instances so remote runs
 * expose the same shape as in-process runs.
 *
 * Returns the input unchanged when the payload is not an object, does
 * not include a `messages` key, or contains entries that are already
 * class instances / not message-like.
 */
function coerceStateMessages(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const state = value as Record<string, unknown>;
  const messages = state.messages;
  if (!Array.isArray(messages) || messages.length === 0) return value;

  const needsCoercion = messages.some((msg) => {
    if (msg == null || typeof msg !== "object") return false;
    if (typeof (msg as { getType?: () => string }).getType === "function") {
      return false;
    }
    const type = (msg as { type?: unknown }).type;
    return typeof type === "string" && MESSAGE_LIKE_TYPES.has(type);
  });
  if (!needsCoercion) return value;

  return {
    ...state,
    messages: ensureMessageInstances(
      messages as Parameters<typeof ensureMessageInstances>[0]
    ),
  };
}

function namespaceKey(ns: Namespace): string {
  return ns.join(NAMESPACE_SEPARATOR);
}

function maxSeq(
  current: number | undefined,
  next: number | undefined
): number | undefined {
  if (next == null) return current;
  if (current == null) return next;
  return Math.max(current, next);
}

const ROOT_TERMINAL_LIFECYCLE_EVENTS = new Set([
  "completed",
  "failed",
  "interrupted",
]);

/**
 * Detect a root-namespace terminal lifecycle event. Used by
 * `#startProjection`'s `endOnRootTerminal` guard to settle per-run
 * dispatchers regardless of whether the shared-stream pause logic
 * applies to their underlying subscription.
 */
function isRootTerminalLifecycle(event: Event): boolean {
  if (event.method !== "lifecycle") return false;
  if (event.params.namespace.length !== 0) return false;
  const data = event.params.data as { event?: string } | undefined;
  return data?.event != null && ROOT_TERMINAL_LIFECYCLE_EVENTS.has(data.event);
}

function namespaceListsEqual(
  a: readonly Namespace[] | undefined,
  b: readonly Namespace[] | undefined
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  const aKeys = new Set<string>();
  for (const ns of a) aKeys.add(namespaceKey(ns));
  for (const ns of b) {
    if (!aKeys.has(namespaceKey(ns))) return false;
  }
  return true;
}

/**
 * Structural equality on filters. Two filters are equal iff they
 * request the same channel set, the same namespace prefix set
 * (with `undefined` meaning wildcard), and the same depth
 * (with `undefined` meaning unbounded).
 */
function filterEqual(
  a: SubscribeParams | null,
  b: SubscribeParams | null
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.channels.length !== b.channels.length) return false;
  const aChannels = new Set(a.channels as Channel[]);
  for (const ch of b.channels as Channel[]) {
    if (!aChannels.has(ch)) return false;
  }
  if (!namespaceListsEqual(a.namespaces, b.namespaces)) return false;
  const aDepth = a.depth ?? null;
  const bDepth = b.depth ?? null;
  if (aDepth !== bDepth) return false;
  return true;
}

function isPrefix(prefix: Namespace, candidate: Namespace): boolean {
  if (prefix.length > candidate.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== candidate[i]) return false;
  }
  return true;
}

/**
 * Whether the `coverer` filter delivers every event a subscription
 * opened with `target` could want.
 *
 * Rules:
 *  - Channels: target.channels must be a subset of coverer.channels.
 *  - Namespaces:
 *    - coverer wildcard (`undefined`) → coverer covers all prefixes.
 *    - coverer explicit + target wildcard → not covered.
 *    - both explicit → every target prefix must have some coverer
 *      prefix that is its ancestor (coverer's prefix delivers events
 *      for all descendants, modulo depth).
 *  - Depth:
 *    - coverer unbounded (`undefined`) → depth is covered.
 *    - otherwise, for each target prefix `tp` covered by coverer
 *      prefix `cp`, the maximum event depth target wants
 *      (`tp.length + (target.depth ?? ∞) - cp.length`) must be
 *      `<= coverer.depth`. For a wildcard target with bounded depth,
 *      target's max absolute depth is `target.depth` (prefix is `[]`).
 */
function filterCovers(
  coverer: SubscribeParams,
  target: SubscribeParams
): boolean {
  const covererChannels = new Set(coverer.channels as Channel[]);
  for (const ch of target.channels as Channel[]) {
    if (!covererChannels.has(ch)) return false;
  }

  const covererDepth = coverer.depth;
  const targetDepth = target.depth;

  if (coverer.namespaces == null) {
    if (covererDepth == null) return true;
    if (targetDepth == null) return false;
    return targetDepth <= covererDepth;
  }

  if (target.namespaces == null) return false;

  for (const tp of target.namespaces) {
    const covered = coverer.namespaces.some((cp) => {
      if (!isPrefix(cp, tp)) return false;
      if (covererDepth == null) return true;
      if (targetDepth == null) return false;
      return tp.length - cp.length + targetDepth <= covererDepth;
    });
    if (!covered) return false;
  }
  return true;
}

function normalizeSubscribeParams(
  paramsOrChannels: SubscribeParams | Channel | readonly Channel[],
  options: SubscribeOptions = {}
): SubscribeParams {
  if (
    typeof paramsOrChannels === "object" &&
    !Array.isArray(paramsOrChannels) &&
    "channels" in paramsOrChannels
  ) {
    return paramsOrChannels;
  }

  const channels = Array.isArray(paramsOrChannels)
    ? ([...paramsOrChannels] as Channel[])
    : ([paramsOrChannels] as Channel[]);
  return {
    ...options,
    channels,
  };
}

/**
 * Fold the ergonomic top-level `forkFrom` checkpoint id into
 * `config.configurable.checkpoint_id` and strip `forkFrom` from the
 * outgoing params.
 *
 * `forkFrom` is purely an SDK-side convenience: callers say
 * `submit(input, { forkFrom })` instead of hand-building a nested
 * RunnableConfig. The agent server only ever accepts the fork target via
 * `config.configurable.checkpoint_id` (the same field the legacy run
 * endpoints use), so we translate here — before the `run.start` message
 * hits the wire — keeping a single, legacy-compliant way to provide it.
 *
 * `forkFrom` takes precedence over any `checkpoint_id` the caller already
 * placed in `config.configurable`, matching the prior server-side merge.
 */
function foldForkFromIntoConfig<
  T extends { forkFrom?: string; config?: unknown },
>(params: T): Omit<T, "forkFrom"> {
  const { forkFrom, ...rest } = params;
  if (typeof forkFrom !== "string" || forkFrom.length === 0) {
    return rest;
  }
  const config =
    rest.config != null && typeof rest.config === "object"
      ? (rest.config as Record<string, unknown>)
      : {};
  const configurable =
    config.configurable != null && typeof config.configurable === "object"
      ? (config.configurable as Record<string, unknown>)
      : {};
  return {
    ...rest,
    config: {
      ...config,
      configurable: {
        ...configurable,
        checkpoint_id: forkFrom,
      },
    },
  } as Omit<T, "forkFrom">;
}

/**
 * Async iterable handle for raw event subscriptions.
 *
 * An optional `transform` maps each incoming event before it is queued
 * or delivered to a waiting consumer. This is used by named custom
 * channel subscriptions (e.g. `"custom:a2a"`) to unwrap the payload
 * so callers receive the raw emitted data instead of the protocol
 * event envelope.
 */
export class SubscriptionHandle<TEvent extends Event = Event, TYield = TEvent>
  implements AsyncIterable<TYield>, EventSubscription<TYield>
{
  // Mutated by `#subscribeViaCommand` on WS once the server-assigned
  // subscription id arrives — see the placeholder→resolved transition
  // there. SSE paths set this once at construction and never change it.
  subscriptionId: string;
  readonly params: SubscribeParams;
  private readonly queue: TYield[] = [];
  private readonly waiters: Array<(value: IteratorResult<TYield>) => void> = [];
  private closed = false;
  private paused = false;
  private resumeResolve?: () => void;
  private readonly onUnsubscribe: (id: string) => Promise<void>;
  private readonly transform: (event: TEvent) => TYield;

  constructor(
    subscriptionId: string,
    params: SubscribeParams,
    onUnsubscribe: (id: string) => Promise<void>,
    transform?: (event: TEvent) => TYield
  ) {
    this.subscriptionId = subscriptionId;
    this.params = params;
    this.onUnsubscribe = onUnsubscribe;
    this.transform = transform ?? ((event) => event as unknown as TYield);
  }

  push(event: TEvent): void {
    if (this.closed) {
      return;
    }
    const value = this.transform(event);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.queue.push(value);
  }

  /**
   * Pause the subscription: resolve all waiting iterators with `done: true`
   * so `for await` loops exit, but keep the subscription alive. New events
   * arriving while paused are still buffered. Call `resume()` to allow
   * iterators to consume again.
   */
  pause(): void {
    if (this.closed) return;
    this.paused = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  /**
   * Resume a paused subscription so new `for await` loops can consume
   * buffered and future events.
   */
  resume(): void {
    this.paused = false;
    this.resumeResolve?.();
    this.resumeResolve = undefined;
  }

  /**
   * Returns a promise that resolves when `resume()` is called. Resolves
   * immediately if not currently paused.
   */
  waitForResume(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resumeResolve = resolve;
    });
  }

  get isPaused(): boolean {
    return this.paused;
  }

  close(): void {
    this.closed = true;
    this.paused = false;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
    // A paused iterator may be parked on `waitForResume()` instead of
    // on a regular iterator waiter. Resolving here prevents closed
    // subscriptions from stranding pumps that observe `isPaused` and
    // block on `waitForResume()` (e.g. the root pump in
    // `StreamController`).
    this.resumeResolve?.();
    this.resumeResolve = undefined;
  }

  async unsubscribe(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.close();
    await this.onUnsubscribe(this.subscriptionId);
  }

  [Symbol.asyncIterator](): AsyncIterator<TYield> {
    return {
      next: async () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return { done: false, value };
        }
        if (this.closed || this.paused) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<TYield>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

/**
 * High-level wrapper around a protocol connection to a specific thread.
 *
 * In the thread-centric protocol, threads are durable (backed by
 * checkpoints) and connections are ephemeral. A `ThreadStream` is the
 * client-side handle for interacting with a thread: starting runs,
 * subscribing to events, consuming assembled projections (`messages`,
 * `values`, `toolCalls`, etc.), and responding to interrupts.
 *
 * Construct via `client.threads.stream(threadId?, { assistantId? })`.
 *
 * @typeParam TExtensions - Optional map of `{ name: payload }` pairs
 *   describing the transformer projections the bound assistant exposes
 *   on `custom:<name>` channels. Narrows `thread.extensions.<name>` to
 *   `ThreadExtension<payload>`. Defaults to `Record<string, unknown>`.
 */
export class ThreadStream<
  TExtensions extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly threadId: string;
  readonly ordering: SessionOrderingState = {};
  readonly run: ThreadModules["run"];
  readonly agent: ThreadModules["agent"];
  readonly input: ThreadModules["input"];
  readonly state: ThreadModules["state"];

  /**
   * Whether the run was interrupted (a lifecycle "interrupted" event
   * was received). Mirrors the in-process `run.interrupted`.
   */
  interrupted = false;

  /**
   * Interrupt payloads collected during the run, if any.
   * Mirrors the in-process `run.interrupts`.
   */
  readonly interrupts: InterruptPayload[] = [];

  readonly assistantId: string;

  #nextCommandId: number;
  readonly #transportAdapter: TransportAdapter;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #subscriptions = new Map<string, InternalEventSubscription>();
  // Tracks `event_id`s that have already been processed for thread-level
  // side effects (interrupt tracking, `input.requested` capture) AND to
  // drop duplicate fan-outs during the overlap window of SSE stream
  // rotation (see `#reconcileStream`): the old stream and the new stream
  // are both pumping briefly, and the server replays buffered events on
  // new streams, so the same `event_id` can arrive twice.
  //
  // The set grows at the rate of unique events per thread, but its
  // lifetime is bounded by `ThreadStream` (it's GC'd when the run
  // completes and the stream is disposed), and each entry is a short
  // numeric string. A bounded sliding-window alternative was considered
  // and rejected: any cap smaller than the server's replay buffer
  // (`maxBufferSize` in `protocol/session`) would risk evicting still-
  // live ids and re-processing real events, which trades a hypothetical
  // memory win for a real correctness failure mode and cross-repo
  // coupling. Revisit only if a concrete long-run memory profile
  // justifies the added complexity.
  readonly #seenEventIds = new Set<string>();
  /**
   * Headless tool interrupts can be auto-resumed by the React hook before
   * the shared SSE content pump has processed the root `interrupted`
   * lifecycle event. `respondInput()` clears `interrupts`, so keep a
   * short-lived marker here until that stale terminal passes through the
   * content pump and we can avoid pausing it.
   */
  readonly #headlessInterruptsAwaitingTerminal = new Set<string>();
  #closed = false;
  #opened = false;
  #openPromise?: Promise<void>;

  // ---------- Shared SSE stream state ----------
  // Under the SSE transport a single connection is shared across all
  // subscriptions. Its filter is the union of every active subscription's
  // filter (`#computeUnionFilter`); the client fans out incoming events
  // to matching subscriptions via `matchesSubscription` in
  // `#handleIncoming`. The stream rotates (open-before-close) whenever
  // `subscribe`/`unsubscribe` changes the channel union.
  #sharedStream: EventStreamHandle | null = null;
  #sharedStreamFilter: SubscribeParams | null = null;
  #rotationState: "idle" | "scheduled" | "rotating" = "idle";
  /** Pending `subscribe()` promises waiting for a covering rotation. */
  readonly #pendingSubResolves: PendingSubResolve[] = [];
  #terminalPauseTimer: ReturnType<typeof setTimeout> | undefined;
  #terminalPauseSeq: number | null | undefined;

  #lifecycleSubId: string | null = null;
  #lifecycleStartPromise?: Promise<void>;

  // Set to the in-flight `run.start` send while it is awaiting the
  // server response, then cleared. Sites that open server-side
  // resources against `/threads/{id}/stream/events` (the SSE content
  // pump, the SSE lifecycle watcher, and the WS `subscription.subscribe`
  // command) await this so they don't race the thread's server-side
  // creation and trip a `404: Thread not found`. Subscribers that
  // arrive after `run.start` resolves see `null` and proceed
  // immediately — `await null` is a microtask, not a real wait — so
  // late selector-hook mounts (`useToolCalls` after subagent discovery)
  // take no extra latency.
  #runStartReady: Promise<void> | null = null;

  // ---------- v2 lifecycle watcher ----------
  // Dedicated wildcard `{channels: ["lifecycle", "input"]}` stream
  // opened by `submitRun` / `respondInput` (v2 entry points). Carries
  // every interrupt and lifecycle event at any depth so consumers of
  // `onEvent` (discovery runners, nested HITL capture) don't depend
  // on the content pump's narrow filter.
  //
  //  - SSE: opened via `openEventStream` as an independent stream
  //    that sits outside `#computeUnionFilter`, so the shared SSE
  //    content pump stays narrow. Tracked in `#lifecycleWatcherHandle`
  //    so `close()` can tear it down.
  //  - WebSocket: opened via `#subscribeRaw` on the shared command
  //    connection. The resulting `SubscriptionHandle` is managed by
  //    the normal `#subscriptions` lifecycle, so no separate handle
  //    reference is needed — `close()` fans `SubscriptionHandle.close`
  //    across all registered subs.
  #lifecycleWatcherHandle: EventStreamHandle | null = null;
  #lifecycleWatcherStartPromise?: Promise<void>;

  // ---------- v2 unified event fan-out ----------
  // Listeners invoked once per globally-unique event across BOTH the
  // content pump and the lifecycle watcher. Used by `StreamController`
  // to consume discovery and interrupt events without opening extra
  // server subscriptions.
  readonly #onEventListeners = new Set<(event: Event) => void>();

  #messagesIterable?: AsyncIterable<StreamingMessageHandle>;
  #valuesProjection?: AsyncIterable<unknown> & PromiseLike<unknown>;
  #toolCallsIterable?: AsyncIterable<ClientAssembledToolCall>;
  #subgraphsIterable?: AsyncIterable<SubgraphHandle>;
  #subagentsIterable?: AsyncIterable<SubagentHandle>;
  #outputPromise?: Promise<unknown>;
  #extensionsProxy?: ThreadExtensions<TExtensions>;
  readonly #extensionsCache = new Map<string, ThreadExtension<unknown>>();

  /**
   * Shared state for the single `"custom"` channel subscription that
   * backs every `thread.extensions.<name>` handle.
   *
   * One subscription is opened eagerly from {@link run.start} (mirroring
   * the {@link values} eager-start pattern) so that per-name handles
   * created before, during, or after the run can all resolve correctly.
   *
   *  - `events` retains every custom event for backfill into
   *    late-constructed handles.
   *  - `eventListeners` fan new events out to live per-name handlers.
   *  - `endListeners` fire when the dispatcher's run terminates, so each
   *    handle can resolve its `PromiseLike` side with its last-seen
   *    payload.
   */
  #extensionsDispatcherStarted = false;
  #extensionsEnded = false;
  readonly #extensionsEvents: Event[] = [];
  readonly #extensionsEventListeners: Array<(event: Event) => void> = [];
  readonly #extensionsEndListeners: Array<() => void> = [];

  /**
   * Shared state for the single `messages`-channel subscription that
   * backs every media handle iterable (`thread.audio`, `thread.images`,
   * `thread.video`, `thread.files`). One subscription serves all four
   * iterables; per-type buffers track the handles already emitted so
   * late attachers replay through {@link MultiCursorBuffer}.
   */
  #mediaDispatcherStarted = false;
  #mediaAssembler: MediaAssembler | undefined;
  /** Object URLs minted by media handles, tracked for {@link close} cleanup. */
  readonly #mediaHandles = new Set<AnyMediaHandle>();
  readonly #audioBuffer = new MultiCursorBuffer<AudioMedia>();
  readonly #imagesBuffer = new MultiCursorBuffer<ImageMedia>();
  readonly #videoBuffer = new MultiCursorBuffer<VideoMedia>();
  readonly #filesBuffer = new MultiCursorBuffer<FileMedia>();
  readonly #fetchOption: typeof fetch | undefined;

  constructor(
    transportAdapter: TransportAdapter,
    options: ThreadStreamOptions
  ) {
    if (!options?.assistantId) {
      throw new Error("ThreadStream requires an assistantId option.");
    }
    this.#transportAdapter = transportAdapter;
    this.threadId = transportAdapter.threadId;
    this.assistantId = options.assistantId;
    this.#nextCommandId = options.startingCommandId ?? 1;
    this.#fetchOption = options.fetch;
    this.run = {
      start: async (params) => {
        this.#prepareForNextRun();
        // Kick off the lifecycle watcher and the values projection
        // SYNCHRONOUSLY so the React layer (and any other consumer that
        // races subagent discovery) sees them registered immediately.
        // Both open server-side subscriptions on
        // `/threads/{id}/stream/events`, which would 404 if they landed
        // before `run.start` committed the thread server-side — so we
        // stage them behind `#runStartReady`, a promise resolved when
        // the in-flight `run.start` send completes. Sites that open
        // SSE/WS resources await this gate; everything else (event
        // dispatch, projection bookkeeping) runs without delay.
        return await this.#withRunStartGate(() => {
          this.#ensureLifecycleTracking();
          // Eagerly start the values projection so `thread.output` /
          // `thread.values` resolve with the final state regardless of
          // whether they are accessed before or after the run completes.
          // Without this, late access would open a fresh subscription
          // that misses every `values` event from the run.
          void this.values;
          // NOTE: `thread.extensions.<name>` is NOT eagerly subscribed.
          // The shared custom dispatcher is opened lazily on first
          // extension access and relies on the server's event buffer to
          // replay any custom events that were emitted before the
          // subscription landed. This keeps the zero-extensions hot path
          // free of an unused `custom` subscription per run.
          return this.#send("run.start", {
            ...foldForkFromIntoConfig(params),
            assistant_id: this.assistantId,
          });
        });
      },
    };
    this.agent = {
      getTree: async (params = {}) =>
        (await this.#send("agent.getTree", params)) as {
          tree: unknown;
        } as never,
    };
    this.input = {
      respond: async (params) => {
        this.#prepareForNextRun();
        this.#ensureLifecycleTracking();
        // See note in `run.start` — keep `thread.output` working
        // across resumes regardless of access order.
        void this.values;
        await this.#send("input.respond", params);
      },
      inject: async (params) => {
        await this.#send(
          "input.inject",
          params as unknown as CommandParamsMap["input.inject"]
        );
      },
    };
    this.state = {
      get: async (params) =>
        await this.#send(
          "state.get",
          params as unknown as CommandParamsMap["state.get"]
        ),
      listCheckpoints: async (params) =>
        await this.#send(
          "state.listCheckpoints",
          params as unknown as CommandParamsMap["state.listCheckpoints"]
        ),
      fork: async (params) =>
        await this.#send(
          "state.fork",
          params as unknown as CommandParamsMap["state.fork"]
        ),
    };
    // SSE transports deliver events via openEventStream — the events()
    // iterable is inert. Skip the consumer loop in that case.
    if (this.#transportAdapter.openEventStream == null) {
      const wsTransport = this.#transportAdapter as {
        setOnReconnected?: (handler: () => void | Promise<void>) => void;
      };
      wsTransport.setOnReconnected?.(() =>
        this.#resubscribeWebSocketSubscriptions()
      );
      void this.#consumeEvents();
    }
  }

  /**
   * Ensure the underlying transport is connected.
   *
   * For HTTP/SSE this is a no-op. For WebSocket this performs the
   * handshake. Called lazily on first command; safe to call multiple times.
   */
  async #ensureOpen(): Promise<void> {
    if (this.#opened) return;
    if (this.#openPromise == null) {
      this.#openPromise = this.#transportAdapter.open().then(() => {
        this.#opened = true;
      });
    }
    await this.#openPromise;
  }

  /**
   * Channels bundled into every lazy getter's SSE filter so that
   * interrupt tracking works without a separate lifecycle subscription.
   */
  #lifecycleChannels(): Channel[] {
    return ["lifecycle", "input"];
  }

  /**
   * Lazily start a dedicated lifecycle+input subscription so that
   * `thread.interrupted` / `thread.interrupts` work even when the
   * caller never accesses a lazy getter (e.g. they only call
   * `run.start` and `subscribe({ channels: ["custom:..."] })`).
   *
   * Idempotent and fire-and-forget — invoked from `run.start` and
   * `input.respond`.
   */
  #ensureLifecycleTracking(): void {
    if (this.#lifecycleStartPromise != null) return;
    this.#lifecycleStartPromise = (async () => {
      const sub = await this.#subscribeRaw({
        channels: this.#lifecycleChannels(),
      });
      this.#lifecycleSubId = sub.subscriptionId;
    })().catch(() => undefined);
  }

  /**
   * Run `operation` (a `run.start` send) while holding the run-start
   * gate. Sets `#runStartReady` before invoking `operation` so any
   * subscription kicked off synchronously inside it (e.g. the lifecycle
   * watcher and the values projection) sees the gate when it eventually
   * reaches `#startLifecycleWatcherSse` / `#reconcileStream` /
   * `#subscribeViaCommand` and awaits it. The gate resolves the moment
   * `operation` settles, so server-side subscribes land immediately
   * after the thread is committed.
   */
  async #withRunStartGate<T>(operation: () => Promise<T>): Promise<T> {
    let resolveGate!: () => void;
    let rejectGate!: (err: unknown) => void;
    const gate = new Promise<void>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    this.#runStartReady = gate;
    // Swallow unhandled rejection: gate-awaiters that surface the
    // rejection via their own error path don't need a second log line,
    // and consumers that never await it (the typical case once
    // `run.start` resolves successfully) shouldn't trigger
    // `unhandledrejection` either.
    gate.catch(() => undefined);
    try {
      const result = await operation();
      resolveGate();
      return result;
    } catch (err) {
      rejectGate(err);
      throw err;
    } finally {
      // Only clear the gate if it's still our gate. Concurrent
      // run.start calls (multitaskStrategy: enqueue) would otherwise
      // null out a later call's gate when this earlier call's finally
      // ran, leaving subscribers that raced in after our finally but
      // before the later run.start commits with no gate to wait on.
      if (this.#runStartReady === gate) {
        this.#runStartReady = null;
      }
    }
  }

  /**
   * Reset interrupt state and resume all paused user subscriptions.
   * Called before `run.start()` and `input.respond()` so that
   * iterators on the same handle pick up the next run's events.
   *
   * @param respondedInterruptId - When responding to one of several
   *   pending interrupts, only that entry is removed. Clearing the
   *   full list here would drop other headless-tool interrupts that
   *   are still awaiting client execution.
   */
  #prepareForNextRun(respondedInterruptId?: string | readonly string[]): void {
    this.interrupted = false;
    if (respondedInterruptId != null) {
      const respondedIds = new Set(
        Array.isArray(respondedInterruptId)
          ? respondedInterruptId
          : [respondedInterruptId as string]
      );
      for (let index = this.interrupts.length - 1; index >= 0; index -= 1) {
        if (respondedIds.has(this.interrupts[index].interruptId)) {
          this.interrupts.splice(index, 1);
        }
      }
    } else {
      this.interrupts.length = 0;
    }
    if (this.#terminalPauseTimer != null) {
      clearTimeout(this.#terminalPauseTimer);
      this.#terminalPauseTimer = undefined;
    }
    this.#terminalPauseSeq = undefined;
    for (const [id, subscription] of this.#subscriptions) {
      if (id !== this.#lifecycleSubId) {
        subscription.resume();
      }
    }
  }

  // ---------- Lazy getters mirroring in-process GraphRunStream ----------

  /**
   * Streaming messages. Each `for await` loop gets an independent cursor
   * over the shared buffer; late consumers see all previously emitted
   * messages.  Mirrors the in-process `run.messages`.
   */
  get messages(): AsyncIterable<StreamingMessageHandle> {
    if (this.#messagesIterable) return this.#messagesIterable;
    const buffer = new MultiCursorBuffer<StreamingMessageHandle>();
    this.#messagesIterable = buffer;
    const assembler = new StreamingMessageAssembler();
    void this.#startProjection(
      ["messages", ...this.#lifecycleChannels()],
      (event) => {
        if (event.method !== "messages") return;
        const msg = assembler.consume(event as MessagesEvent);
        if (msg) buffer.push(toStreamingMessageHandle(msg));
      },
      () => buffer.close()
    );
    return buffer;
  }

  /**
   * State values. Iterable for intermediate snapshots; also
   * `PromiseLike` — `await thread.values` resolves with the final
   * state.  Mirrors the in-process `run.values`.
   */
  get values(): AsyncIterable<unknown> & PromiseLike<unknown> {
    if (this.#valuesProjection) return this.#valuesProjection;
    const buffer = new MultiCursorBuffer<unknown>();
    let lastValue: unknown;
    let resolveOutput!: (value: unknown) => void;
    const outputPromise = new Promise<unknown>((resolve) => {
      resolveOutput = resolve;
    });
    this.#outputPromise = outputPromise;
    const projection = Object.assign(buffer, {
      then: <TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null
      ): Promise<TResult1 | TResult2> =>
        outputPromise.then(onfulfilled, onrejected),
    }) as AsyncIterable<unknown> & PromiseLike<unknown>;
    this.#valuesProjection = projection;
    void this.#startProjection(
      ["values", ...this.#lifecycleChannels()],
      (event) => {
        if (event.method !== "values") return;
        const data = coerceStateMessages((event as ValuesEvent).params.data);
        lastValue = data;
        buffer.push(data);
      },
      () => {
        resolveOutput(lastValue);
        buffer.close();
      }
    );
    return projection;
  }

  /**
   * Tool calls with a promise-based {@link output} for script consumers.
   * Mirrors the in-process `run.toolCalls`.
   */
  get toolCalls(): AsyncIterable<ClientAssembledToolCall> {
    if (this.#toolCallsIterable) return this.#toolCallsIterable;
    const buffer = new MultiCursorBuffer<ClientAssembledToolCall>();
    this.#toolCallsIterable = buffer;
    const assembler = new ToolCallAssembler();
    void this.#startProjection(
      ["tools", ...this.#lifecycleChannels()],
      (event) => {
        if (event.method !== "tools") return;
        const tc = assembler.consume(event as ToolsEvent);
        if (tc) buffer.push(toClientAssembledToolCall(tc));
      },
      () => buffer.close()
    );
    return buffer;
  }

  /**
   * Discovered subgraphs. Mirrors the in-process `run.subgraphs`.
   */
  get subgraphs(): AsyncIterable<SubgraphHandle> {
    if (this.#subgraphsIterable) return this.#subgraphsIterable;
    const buffer = new MultiCursorBuffer<SubgraphHandle>();
    this.#subgraphsIterable = buffer;
    void (async () => {
      const rawHandle = await this.#subscribeRaw({
        channels: ["tools", ...this.#lifecycleChannels()],
      });
      const discovery = new SubgraphDiscoveryHandle(rawHandle, this, []);
      for await (const sub of discovery) {
        buffer.push(sub);
      }
      buffer.close();
    })();
    return buffer;
  }

  /**
   * Discovered subagents.
   */
  get subagents(): AsyncIterable<SubagentHandle> {
    if (this.#subagentsIterable) return this.#subagentsIterable;
    const buffer = new MultiCursorBuffer<SubagentHandle>();
    this.#subagentsIterable = buffer;
    void (async () => {
      const rawHandle = await this.#subscribeRaw({
        channels: ["tools", ...this.#lifecycleChannels()],
      });
      const discovery = new SubagentDiscoveryHandle(rawHandle, this);
      for await (const sub of discovery) {
        buffer.push(sub);
      }
      buffer.close();
    })();
    return buffer;
  }

  /**
   * Audio media handles, one per message containing at least one
   * `AudioBlock`. Each `for await` opens an independent cursor over
   * the shared buffer; late consumers replay every previously emitted
   * audio handle.
   *
   * Yields one item per message on the first matching
   * `content-block-start` — messages with no audio blocks are skipped.
   */
  get audio(): AsyncIterable<AudioMedia> {
    this.#ensureMediaDispatcher();
    return this.#audioBuffer;
  }

  /**
   * Image media handles, one per message containing at least one
   * `ImageBlock`. See {@link audio} for shared semantics.
   */
  get images(): AsyncIterable<ImageMedia> {
    this.#ensureMediaDispatcher();
    return this.#imagesBuffer;
  }

  /**
   * Video media handles, one per message containing at least one
   * `VideoBlock`. See {@link audio} for shared semantics.
   */
  get video(): AsyncIterable<VideoMedia> {
    this.#ensureMediaDispatcher();
    return this.#videoBuffer;
  }

  /**
   * File media handles, one per message containing at least one
   * `FileBlock`. See {@link audio} for shared semantics.
   */
  get files(): AsyncIterable<FileMedia> {
    this.#ensureMediaDispatcher();
    return this.#filesBuffer;
  }

  /**
   * Promise that resolves with the final state value when the run
   * completes.  Shares the `values` getter's SSE connection.
   * Mirrors the in-process `run.output`.
   */
  get output(): Promise<unknown> {
    // Accessing `this.values` ensures the projection is started.
    void this.values;
    return this.#outputPromise!;
  }

  /**
   * Proxy over compile-time {@link StreamTransformer} projections
   * exposed by the bound assistant on `custom:<name>` channels.
   *
   * Each access (e.g. `thread.extensions.toolActivity`) lazily opens a
   * dedicated `custom:<name>` subscription, returns a cached
   * {@link ThreadExtension} handle that is both `AsyncIterable<T>`
   * (streaming items as they arrive) and `PromiseLike<T>` (resolves
   * with the final value when the run terminates), and reuses the same
   * handle on subsequent access.
   *
   * Mirrors the in-process `run.extensions.<name>` shape.
   */
  get extensions(): ThreadExtensions<TExtensions> {
    if (this.#extensionsProxy) return this.#extensionsProxy;
    const cache = this.#extensionsCache;
    const createExtension = (name: string) => this.#createExtension(name);
    this.#extensionsProxy = new Proxy(
      Object.create(null) as ThreadExtensions<TExtensions>,
      {
        get: (_target, prop) => {
          if (typeof prop !== "string") return undefined;
          const cached = cache.get(prop);
          if (cached) return cached;
          const extension = createExtension(prop);
          cache.set(prop, extension);
          return extension;
        },
        has: (_target, prop) => typeof prop === "string",
      }
    );
    return this.#extensionsProxy;
  }

  /**
   * Lazily open one shared subscription on the `custom` channel that
   * buffers every custom event for this run and fans it out to any
   * per-name extension handles.
   *
   * Deliberately **lazy**: the dispatcher only starts on first access
   * to `thread.extensions.<name>`. Runs that never touch extensions
   * pay no subscription cost. Runs that touch extensions after events
   * have already fired rely on the server's per-session event buffer,
   * which replays matching events to new subscriptions.
   *
   * Each handle retains a PromiseLike that resolves with the
   * transformer's last-observed payload, independent of when the
   * caller grabs the handle (before, during, or after the run), as
   * long as the server still has the events buffered.
   *
   * Idempotent. Invoked only from {@link #createExtension}.
   */
  #ensureExtensionsDispatcher(): void {
    if (this.#extensionsDispatcherStarted) return;
    this.#extensionsDispatcherStarted = true;
    void this.#startProjection(
      ["custom", ...this.#lifecycleChannels()],
      (event) => {
        if (event.method !== "custom") return;
        this.#extensionsEvents.push(event);
        for (const listener of this.#extensionsEventListeners) {
          listener(event);
        }
      },
      () => {
        this.#extensionsEnded = true;
        const listeners = this.#extensionsEndListeners.splice(0);
        for (const listener of listeners) listener();
      },
      // Late-bound dispatchers (created after the run already terminated)
      // are skipped by the shared-stream pause logic — their
      // `registeredAfterSeq` is already past the terminal seq, which is
      // intended to keep nested replays draining for raw `subscribe()`
      // callers. The dispatcher needs the OPPOSITE: once the run's
      // terminal lifecycle replays through, settle the per-name
      // `PromiseLike`s with their last-observed payload. Detect the
      // terminal explicitly here so a late `thread.extensions.<name>`
      // access still resolves.
      { endOnRootTerminal: true }
    );
  }

  /**
   * Open the single shared `messages`-channel subscription that backs
   * every media iterable (audio/images/video/files). Idempotent.
   *
   * The {@link MediaAssembler} fans out to four per-type
   * {@link MultiCursorBuffer}s; each buffer feeds its corresponding
   * lazy getter. One handle is yielded per `(messageId, blockType)` on
   * the first matching `content-block-start`, so messages without any
   * media blocks of a given type never appear on that iterable.
   */
  #ensureMediaDispatcher(): void {
    if (this.#mediaDispatcherStarted) return;
    this.#mediaDispatcherStarted = true;
    const assembler = new MediaAssembler({
      fetch: this.#fetchOption,
      onAudio: (m) => {
        this.#mediaHandles.add(m);
        this.#audioBuffer.push(m);
      },
      onImage: (m) => {
        this.#mediaHandles.add(m);
        this.#imagesBuffer.push(m);
      },
      onVideo: (m) => {
        this.#mediaHandles.add(m);
        this.#videoBuffer.push(m);
      },
      onFile: (m) => {
        this.#mediaHandles.add(m);
        this.#filesBuffer.push(m);
      },
    });
    this.#mediaAssembler = assembler;
    void this.#startProjection(
      ["messages", ...this.#lifecycleChannels()],
      (event) => {
        if (event.method !== "messages") return;
        assembler.consume(event as MessagesEvent);
      },
      () => {
        assembler.close();
        this.#audioBuffer.close();
        this.#imagesBuffer.close();
        this.#videoBuffer.close();
        this.#filesBuffer.close();
      }
    );
  }

  /**
   * Build a single {@link ThreadExtension} handle for a named
   * `custom:<name>` projection.
   *
   * The handle reads from the shared extensions dispatcher: past events
   * matching {@link name} are backfilled on construction, future events
   * arrive via a registered listener, and the handle's `PromiseLike`
   * side resolves with its last-seen payload once the run terminates
   * (which may already have happened, in which case it resolves on the
   * next microtask).
   */
  #createExtension(name: string): ThreadExtension<unknown> {
    this.#ensureExtensionsDispatcher();

    const buffer = new MultiCursorBuffer<unknown>();
    let lastValue: unknown;
    let resolveFinal!: (value: unknown) => void;
    const finalPromise = new Promise<unknown>((resolve) => {
      resolveFinal = resolve;
    });

    const handleEvent = (event: Event) => {
      const data = event.params.data as
        | {
            name?: string;
            payload?: unknown;
          }
        | undefined;
      if (data?.name !== name) return;
      lastValue = data.payload;
      buffer.push(data.payload);
    };

    // Backfill from events already seen by the dispatcher so handles
    // constructed mid-run or post-run still observe their payload.
    for (const event of this.#extensionsEvents) handleEvent(event);

    // Live events — routed through the shared dispatcher.
    this.#extensionsEventListeners.push(handleEvent);

    const settle = () => {
      resolveFinal(lastValue);
      buffer.close();
    };
    if (this.#extensionsEnded) {
      settle();
    } else {
      this.#extensionsEndListeners.push(settle);
    }

    return Object.assign(buffer, {
      then: <TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null
      ): Promise<TResult1 | TResult2> =>
        finalPromise.then(onfulfilled, onrejected),
    }) as ThreadExtension<unknown>;
  }

  /**
   * Generic projection starter: opens a raw subscription with the given
   * channels, feeds events through the consumer, and calls onDone when
   * the stream ends.
   *
   * When `endOnRootTerminal` is set, the projection unsubscribes its
   * own handle one macrotask after observing a root-namespace terminal
   * lifecycle event. This is needed by projections that may be opened
   * AFTER a run already terminated: the shared-stream pause logic
   * skips subscriptions whose `registeredAfterSeq` is past the
   * terminal so raw `subscribe()` callers can keep draining replayed
   * descendants — but a per-run dispatcher (e.g. the extensions
   * pipeline) needs the projection to settle so its `PromiseLike`
   * surface resolves. The macrotask deferral mirrors the deferred
   * pause in `#handleIncoming`, giving trailing same-tick custom
   * events (transformer `finalize()` flushes) a chance to drain.
   */
  async #startProjection(
    channels: Channel[],
    onEvent: (event: Event) => void,
    onDone: () => void,
    options: { endOnRootTerminal?: boolean } = {}
  ): Promise<void> {
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    let rawHandle: SubscriptionHandle<Event> | undefined;
    try {
      rawHandle = await this.#subscribeRaw({ channels });
      const handle = rawHandle;
      for await (const event of handle) {
        onEvent(event);
        if (
          options.endOnRootTerminal &&
          endTimer == null &&
          isRootTerminalLifecycle(event)
        ) {
          endTimer = setTimeout(() => {
            endTimer = undefined;
            void handle.unsubscribe().catch(() => undefined);
          }, 0);
        }
      }
    } catch {
      // Projection streams are best-effort views over the shared thread
      // stream. Surface-level errors are reflected through the controller
      // state; this background task only needs to settle cleanly.
    } finally {
      if (endTimer != null) clearTimeout(endTimer);
      onDone();
    }
  }

  // ---------- v2 entry points ----------

  /**
   * Start a run without the v1 eager lazy-getter shims.
   *
   * `run.start` (the v1 entry point) eagerly opens a wildcard `values`
   * projection so `thread.output` / `thread.values` resolve regardless
   * of access order, and calls `#ensureLifecycleTracking` which opens
   * another wildcard `["lifecycle", "input"]` subscription. Both
   * subscriptions widen `#computeUnionFilter` to wildcard, defeating
   * the progressive-expansion rotation strategy.
   *
   * `submitRun` skips those shims — callers that manage their own
   * content subscriptions (such as `StreamController`) get the narrow
   * union filter they asked for. Lifecycle / interrupt tracking is
   * instead served by the dedicated `#startLifecycleWatcher`, which
   * opens a wildcard `["lifecycle", "input"]` stream alongside the
   * narrow content pump on both SSE and WebSocket transports.
   */
  async submitRun(params: {
    input?: unknown;
    config?: unknown;
    metadata?: Record<string, unknown>;
    /**
     * Fork the new run from an explicit checkpoint instead of the
     * thread's latest. This is an SDK-side convenience: it is folded into
     * `config.configurable.checkpoint_id` before the `run.start` message
     * is sent, so the agent server only ever sees the single
     * legacy-compliant fork field (`forkFrom` never hits the wire).
     */
    forkFrom?: string;
    /**
     * Controls how concurrent submissions on the same thread are
     * handled by the server (`reject` | `rollback` | `interrupt` |
     * `enqueue`).
     */
    multitaskStrategy?: "reject" | "rollback" | "interrupt" | "enqueue";
  }): Promise<RunResult> {
    this.#prepareForNextRun();
    // See `this.run.start` for the gating rationale — the lifecycle
    // watcher must register synchronously (so subagent discovery and
    // its downstream `useToolCalls` / `useMessages` subscriptions
    // don't race the run), but its server-side SSE/WS open is staged
    // behind `#runStartReady` to avoid a `404: Thread not found`.
    return await this.#withRunStartGate(() => {
      this.#startLifecycleWatcher();
      return this.#send("run.start", {
        ...(foldForkFromIntoConfig(params) as Record<string, unknown>),
        assistant_id: this.assistantId,
      });
    });
  }

  /**
   * Respond to an interrupt without the v1 eager lazy-getter shims.
   * See {@link submitRun} for why this exists alongside
   * {@link input.respond}.
   */
  async respondInput(params: InputRespondParams): Promise<void> {
    // `InputRespondParams` is `InputRespondOne | InputRespondMany`. The
    // batch variant (`responses`) resolves several interrupts pending at
    // the same checkpoint in one command; the single variant carries a
    // top-level `interrupt_id`.
    const respondedIds =
      "responses" in params
        ? params.responses.map((entry) => entry.interrupt_id)
        : params.interrupt_id;
    this.#prepareForNextRun(respondedIds);
    this.#startLifecycleWatcher();
    await this.#send("input.respond", params);
  }

  /**
   * Register a listener for every globally-unique event on the thread.
   *
   * Fires exactly once per `event_id` across both the content pump
   * (user `subscribe()` calls) and the lifecycle watcher. Events
   * without an `event_id` always fire through (dedup is best-effort).
   *
   * Returns an unsubscribe function. Primary consumer is
   * `StreamController`, which uses the listener to feed discovery
   * runners and pick up deeply-nested interrupts that the narrow
   * content pump wouldn't deliver.
   */
  onEvent(listener: (event: Event) => void): () => void {
    this.#onEventListeners.add(listener);
    return () => {
      this.#onEventListeners.delete(listener);
    };
  }

  /**
   * Lazily open the wildcard discovery watcher stream.
   *
   * Idempotent. Used by both transports, but through different
   * mechanisms:
   *
   *  - **SSE**: opens a dedicated event stream via
   *    {@link TransportAdapter.openEventStream}. The stream runs
   *    outside `#computeUnionFilter`, so the shared SSE stream's
   *    content pump can stay narrow (e.g. `depth: 1`) while we still
   *    capture every lifecycle/input event at any depth.
   *  - **WebSocket**: opens a wildcard watcher subscription
   *    subscription via the normal command path. The WS server
   *    delivers matching events on the shared command connection and
   *    `#handleIncoming` dispatches them through `#fireOnEvent` and
   *    the thread-level effects — same downstream semantics as the
   *    SSE watcher, just reusing the transport that's already open.
   *
   * Why this matters: consumers of {@link onEvent} (notably
   * `StreamController`'s subgraph/subagent discovery runners and
   * nested interrupt capture) depend on observing namespaced
   * lifecycle events at any depth. Without this watcher, WS clients
   * would only ever receive events matching the content pump's
   * narrow filter (depth 1 from the root), breaking inference rules
   * that require deeper descendants (e.g. the "has-descendants"
   * signal used to promote a subgraph host).
   */
  #startLifecycleWatcher(): void {
    if (this.#lifecycleWatcherStartPromise != null) return;

    if (this.#transportAdapter.openEventStream != null) {
      this.#lifecycleWatcherStartPromise = this.#startLifecycleWatcherSse();
      return;
    }

    this.#lifecycleWatcherStartPromise = this.#startLifecycleWatcherWebSocket();
  }

  /**
   * Public, idempotent entry point to start the wildcard lifecycle
   * watcher.
   *
   * The watcher is normally started lazily by `submitRun` /
   * `respondInput` because for fresh (self-created) threads the SSE
   * stream would 404 if opened before the server has the thread row.
   * Callers that already know the thread exists server-side
   * (`StreamController.hydrate` of an existing thread) can use this
   * to start the watcher up front. The watcher subscribes to wildcard
   * lifecycle events across every namespace, so it sees arbitrarily-
   * nested subagent lifecycle messages that the narrow root content
   * pump (running at `depth: 1`) wouldn't reach — that's what makes
   * subagent discovery work for historical thread loads.
   *
   * Idempotent — repeat calls reuse the in-flight start promise.
   */
  startLifecycleWatcher(): void {
    this.#startLifecycleWatcher();
  }

  async #startLifecycleWatcherSse(): Promise<void> {
    // Wait for any in-flight `run.start` send to commit the thread
    // server-side. Without this the SSE GET on
    // `/threads/{id}/stream/events` 404s and the watcher tears down
    // before delivering any lifecycle event.
    if (this.#runStartReady != null) {
      try {
        await this.#runStartReady;
      } catch {
        return;
      }
    }
    const filter: SubscribeParams = {
      channels: ["lifecycle", "input"],
    };
    let handle: EventStreamHandle;
    try {
      handle = this.#transportAdapter.openEventStream!(filter);
    } catch {
      return;
    }
    try {
      await handle.ready;
    } catch {
      try {
        handle.close();
      } catch {
        // best-effort
      }
      return;
    }
    if (this.#closed) {
      try {
        handle.close();
      } catch {
        // best-effort
      }
      return;
    }
    this.#lifecycleWatcherHandle = handle;
    try {
      for await (const message of handle.events) {
        if (this.#closed) break;
        this.#handleLifecycleWatcherMessage(message);
      }
    } catch {
      // Best-effort; the content pump handles surface-level errors.
    }
  }

  async #startLifecycleWatcherWebSocket(): Promise<void> {
    // `#subscribeRaw` on WS registers the subscription with the
    // server and buffers incoming events on a `SubscriptionHandle`.
    // All the side effects we care about (global dedup,
    // `#fireOnEvent` fan-out to `onEvent` listeners, interrupt
    // capture) already run in `#handleIncoming` regardless of which
    // subscription matched, so we don't need to process events on
    // the handle itself — we just drain it so its buffer doesn't
    // accumulate.
    let handle: SubscriptionHandle<Event>;
    try {
      handle = await this.#subscribeRaw({
        channels: ["lifecycle", "input"],
      });
    } catch {
      return;
    }
    if (this.#closed) {
      try {
        handle.close();
      } catch {
        // best-effort
      }
      return;
    }
    try {
      for await (const _event of handle) {
        if (this.#closed) break;
      }
    } catch {
      // Best-effort; surface-level errors are reported by the
      // content pump.
    }
  }

  /**
   * Process an event from the dedicated lifecycle watcher stream.
   *
   * Unlike `#handleIncoming`, this does NOT fan out to user
   * subscriptions — user subs with namespace wildcards already widen
   * `#computeUnionFilter` and therefore receive the event on the
   * content pump. Delivering via both streams would only add per-sub
   * dedup churn without expanding what the user can observe.
   *
   * We still run global-dedup thread-level side effects (interrupt
   * capture, `onEvent` fan-out) so deeply-nested interrupts outside
   * the content pump's narrow scope are recorded.
   */
  #handleLifecycleWatcherMessage(message: Message): void {
    if (message.type !== "event") return;
    if (typeof message.seq === "number") {
      this.ordering.lastSeenSeq = maxSeq(
        this.ordering.lastSeenSeq,
        message.seq
      );
    }
    if (message.event_id) {
      this.ordering.lastEventId = message.event_id;
    }
    const eventId = message.event_id ?? undefined;
    const globallyProcessed =
      eventId != null && this.#seenEventIds.has(eventId);
    if (eventId != null) this.#seenEventIds.add(eventId);
    if (globallyProcessed) return;
    this.#applyThreadLevelEffects(message);
    this.#fireOnEvent(message);
  }

  #applyThreadLevelEffects(event: Event): void {
    if (event.method === "lifecycle") {
      const lifecycle = event as LifecycleEvent;
      if (lifecycle.params.data.event === "interrupted") {
        this.interrupted = true;
      }
    }
    if (event.method === "input.requested") {
      const data = event.params.data;
      const interruptId =
        data.interrupt_id ?? `interrupt_${this.interrupts.length}`;
      this.interrupts.push({
        interruptId,
        payload: data.payload,
        namespace: [...event.params.namespace],
      });
      if (isHeadlessToolInterrupt(data.payload)) {
        this.#headlessInterruptsAwaitingTerminal.add(interruptId);
      }
    }
  }

  #fireOnEvent(event: Event): void {
    if (this.#onEventListeners.size === 0) return;
    for (const listener of this.#onEventListeners) {
      try {
        listener(event);
      } catch {
        // Best-effort — a bad listener should not wedge event delivery.
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#terminalPauseTimer != null) {
      clearTimeout(this.#terminalPauseTimer);
      this.#terminalPauseTimer = undefined;
    }
    this.#terminalPauseSeq = undefined;
    // Reject any `subscribe()` promises still waiting for a covering
    // rotation, and tear down the shared SSE stream. A rotation in
    // flight will observe `#closed` after its `await ready` and bail.
    for (const pending of this.#pendingSubResolves) {
      pending.reject(new Error("ThreadStream closed"));
    }
    this.#pendingSubResolves.length = 0;
    if (this.#sharedStream != null) {
      try {
        this.#sharedStream.close();
      } catch {
        // best-effort
      }
      this.#sharedStream = null;
      this.#sharedStreamFilter = null;
    }
    if (this.#lifecycleWatcherHandle != null) {
      try {
        this.#lifecycleWatcherHandle.close();
      } catch {
        // best-effort
      }
      this.#lifecycleWatcherHandle = null;
    }
    const lifecycleWatcherStartPromise = this.#lifecycleWatcherStartPromise;
    this.#lifecycleWatcherStartPromise = undefined;
    this.#onEventListeners.clear();
    for (const subscription of this.#subscriptions.values()) {
      subscription.close();
    }
    this.#subscriptions.clear();
    try {
      await lifecycleWatcherStartPromise;
    } catch {
      // best-effort
    }
    // Safety net: revoke any object URLs minted by media handles so
    // long-lived consumers don't leak after thread teardown.
    for (const handle of this.#mediaHandles) {
      try {
        handle.revoke();
      } catch {
        // best-effort
      }
    }
    this.#mediaHandles.clear();
    this.#mediaAssembler?.close();
    this.#audioBuffer.close();
    this.#imagesBuffer.close();
    this.#videoBuffer.close();
    this.#filesBuffer.close();
    await this.#transportAdapter.close();
  }

  /**
   * Subscribe to raw wire channels and receive protocol events.
   *
   * For assembled projections, use the lazy getters instead:
   * `thread.messages`, `thread.values`, `thread.toolCalls`,
   * `thread.subgraphs`, `thread.subagents`, `thread.output`.
   */
  async subscribe<TChannel extends Channel>(
    channel: TChannel,
    options?: SubscribeOptions
  ): Promise<
    SubscriptionHandle<EventForChannel<TChannel>, YieldForChannel<TChannel>>
  >;
  async subscribe<const TChannels extends readonly Channel[]>(
    channels: TChannels,
    options?: SubscribeOptions
  ): Promise<
    SubscriptionHandle<EventForChannels<TChannels>, YieldForChannels<TChannels>>
  >;
  async subscribe(params: SubscribeParams): Promise<SubscriptionHandle<Event>>;
  async subscribe(
    paramsOrChannels: SubscribeParams | Channel | readonly Channel[],
    options: SubscribeOptions = {}
  ): Promise<unknown> {
    // The string / string-array overloads are typed to unwrap
    // `custom:<name>` payloads for ergonomic single-extension
    // subscriptions (`thread.subscribe("custom:a2a")` yields the
    // raw payload). The `SubscribeParams` object overload, however,
    // is typed as `SubscriptionHandle<Event>` — it must deliver the
    // full event envelope so callers like `channelProjection` (which
    // backs `useChannel`) can see the `method`, `namespace`, and
    // `data.name` fields needed for filtering and rendering.
    const isParamsObject =
      typeof paramsOrChannels === "object" &&
      !Array.isArray(paramsOrChannels) &&
      "channels" in paramsOrChannels;
    const params = normalizeSubscribeParams(
      paramsOrChannels as SubscribeParams | Channel | readonly Channel[],
      options
    );
    return await this.#subscribeRaw(params, {
      unwrapNamedCustom: !isParamsObject,
    });
  }

  async #subscribeRaw(
    params: SubscribeParams,
    options: { unwrapNamedCustom?: boolean } = {}
  ): Promise<SubscriptionHandle<Event>> {
    await this.#ensureOpen();
    const { unwrapNamedCustom = true } = options;
    const hasOnlyNamedCustom =
      params.channels.length > 0 &&
      params.channels.every((ch) => ch.startsWith("custom:"));
    const transform =
      unwrapNamedCustom && hasOnlyNamedCustom
        ? (event: Event) =>
            (
              (event.params as Record<string, unknown>).data as {
                payload?: unknown;
              }
            )?.payload ?? event
        : undefined;

    if (this.#transportAdapter.openEventStream != null) {
      return this.#subscribeViaSharedStream(params, transform);
    }

    return this.#subscribeViaCommand(params, transform);
  }

  /**
   * Subscribe via the single shared SSE connection.
   *
   * The subscription is registered immediately in `#subscriptions` so
   * fan-out can reach it the moment events begin flowing. The returned
   * promise resolves after a stream rotation completes whose union
   * filter covers this subscription's channels — mirroring the per-sub
   * `await streamHandle.ready` semantics callers depended on.
   *
   * Every subscribe schedules a stream rotation, even when the current
   * stream's filter already covers `params`. Rotating opens a fresh
   * server-side session that replays the run's full history from
   * `seq=0`; without it a late-joining sub would only see events that
   * arrive after it registered, because the shared pump's dedup drops
   * events the existing sub already consumed. Per-sub dedup
   * (`seenEventIds`) protects existing subs from receiving the
   * replay as duplicates. Rapid subscribes in the same microtask are
   * coalesced by `#scheduleReconcile` into a single rotation.
   */
  async #subscribeViaSharedStream(
    params: SubscribeParams,
    transform?: (event: Event) => unknown
  ): Promise<SubscriptionHandle<Event>> {
    const subscriptionId = `sse-${this.#nextCommandId++}`;
    const handle = new SubscriptionHandle<Event, unknown>(
      subscriptionId,
      params,
      async (id) => {
        this.#subscriptions.delete(id);
        this.#scheduleReconcile();
      },
      transform
    );
    const subscription = Object.assign(handle, {
      filter: params,
      registeredAfterSeq: this.ordering.lastSeenSeq,
      seenEventIds: new Set<string>(),
    });
    this.#subscriptions.set(subscriptionId, subscription);

    const covered = new Promise<void>((resolve, reject) => {
      this.#pendingSubResolves.push({ filter: params, resolve, reject });
    });
    this.#scheduleReconcile();

    try {
      await covered;
    } catch (err) {
      this.#subscriptions.delete(subscriptionId);
      throw err;
    }
    return handle as SubscriptionHandle<Event>;
  }

  /**
   * Progressive-expansion union of every currently-registered
   * subscription's filter. The server receives the narrowest filter
   * that still covers every active sub so deeply-namespaced or
   * selectively-opened projections don't pull down the entire thread's
   * event firehose.
   *
   * Unioning rules (matching the server's matching semantics in
   * `matchesSinkFilter`):
   *  - Channels: set union.
   *  - Namespaces: if any subscription requests a wildcard
   *    (`namespaces === undefined`) the union is wildcard; otherwise
   *    the union is the deduplicated list of every explicit prefix.
   *  - Depth: if any subscription is unbounded (`depth === undefined`)
   *    the union is unbounded; otherwise the union is the maximum
   *    depth across all subscriptions (matching the per-sub "max
   *    reach below the prefix" semantics).
   *
   * Returns `null` when there are no subscriptions.
   */
  #computeUnionFilter(): SubscribeParams | null {
    if (this.#subscriptions.size === 0) return null;

    const channels = new Set<Channel>();
    let wildcardNamespaces = false;
    const namespaceMap = new Map<string, Namespace>();
    let unboundedDepth = false;
    let maxDepth = 0;

    for (const sub of this.#subscriptions.values()) {
      for (const ch of sub.filter.channels) channels.add(ch);

      if (sub.filter.namespaces == null) {
        wildcardNamespaces = true;
      } else if (!wildcardNamespaces) {
        for (const ns of sub.filter.namespaces) {
          namespaceMap.set(namespaceKey(ns), ns);
        }
      }

      if (sub.filter.depth == null) {
        unboundedDepth = true;
      } else if (!unboundedDepth && sub.filter.depth > maxDepth) {
        maxDepth = sub.filter.depth;
      }
    }

    const result: SubscribeParams = {
      channels: [...channels] as Channel[],
    };
    if (!wildcardNamespaces) {
      result.namespaces = [...namespaceMap.values()];
    }
    if (!unboundedDepth) {
      result.depth = maxDepth;
    }
    return result;
  }

  /**
   * Schedule a stream reconciliation for the next microtask.
   *
   * Coalesces multiple subscribe/unsubscribe calls in the same tick
   * into a single rotation, and serializes across ticks (no two
   * rotations ever run concurrently).
   */
  #scheduleReconcile(): void {
    if (this.#closed) return;
    if (this.#rotationState !== "idle") return;
    this.#rotationState = "scheduled";
    queueMicrotask(() => {
      if (this.#closed) {
        this.#rotationState = "idle";
        return;
      }
      this.#rotationState = "idle";
      void this.#reconcileStream().catch(() => {
        this.#rotationState = "idle";
      });
    });
  }

  /**
   * Reconcile the shared SSE stream to match the desired union filter.
   *
   * Rotation strategy: open the new stream first, await its `ready`,
   * then close the old one. Overlap is absorbed by `#seenEventIds`
   * dedup in `#handleIncoming`.
   *
   * Error handling:
   *   - Failure before `ready` resolves: reject all pending `subscribe`
   *     promises whose filter isn't covered by the existing stream,
   *     and keep the existing stream running for other subscriptions.
   *   - Failure mid-pump on the active stream: close the thread via
   *     {@link #failThreadWithError} so higher layers can rebind.
   */
  async #reconcileStream(): Promise<void> {
    if (this.#closed) return;
    if (this.#rotationState === "rotating") return;

    const desired = this.#computeUnionFilter();
    if (desired == null) return;

    // Wait for any in-flight `run.start` send so the SSE GET on
    // `/threads/{id}/stream/events` doesn't 404 against a thread the
    // server hasn't created yet. Late subscribers (after `run.start`
    // resolves) see a null gate and proceed immediately. The
    // `openEventStream` adapter contract requires implementations to
    // buffer events and replay them on new opens, so the rotation
    // doesn't lose events that were emitted during the wait.
    if (this.#runStartReady != null) {
      try {
        await this.#runStartReady;
      } catch (err) {
        // The pending `run.start` failed; abandon this rotation and
        // let the rejected `run.start` surface the error to callers.
        // Forward the original cause so pending subscribers see the
        // real reason rather than a generic "run.start failed".
        const normalized =
          // oxlint-disable-next-line no-instanceof/no-instanceof
          err instanceof Error ? err : new Error("run.start failed");
        this.#rejectUncoveredPending(normalized);
        return;
      }
      if (this.#closed) return;
      // Re-read through a local — TS narrowed `#rotationState` above
      // and doesn't widen it back across the await, but another
      // reconcile may have set it in the interim.
      const stateNow: string = this.#rotationState;
      if (stateNow === "rotating") return;
    }

    // Bail only when nothing structurally changed AND nobody is
    // waiting on a fresh replay. A pending sub always needs a
    // rotation even when the filter is unchanged, because the server
    // replays buffered events only at the moment the SSE connection
    // is opened.
    if (
      this.#sharedStreamFilter != null &&
      filterEqual(desired, this.#sharedStreamFilter) &&
      this.#pendingSubResolves.length === 0
    ) {
      this.#resolvePending();
      return;
    }

    this.#rotationState = "rotating";
    let newHandle: EventStreamHandle;
    try {
      newHandle = this.#transportAdapter.openEventStream!(desired);
    } catch (err) {
      this.#rotationState = "idle";
      this.#rejectUncoveredPending(err);
      return;
    }

    try {
      await newHandle.ready;
    } catch (err) {
      this.#rotationState = "idle";
      try {
        newHandle.close();
      } catch {
        // best-effort
      }
      this.#rejectUncoveredPending(err);
      return;
    }

    if (this.#closed) {
      try {
        newHandle.close();
      } catch {
        // best-effort
      }
      this.#rotationState = "idle";
      return;
    }

    void this.#pumpStream(newHandle);

    const oldHandle = this.#sharedStream;
    this.#sharedStream = newHandle;
    this.#sharedStreamFilter = desired;
    if (oldHandle != null) {
      try {
        oldHandle.close();
      } catch {
        // best-effort
      }
    }

    this.#rotationState = "idle";
    this.#resolvePending();

    const next = this.#computeUnionFilter();
    if (next != null && !filterEqual(next, this.#sharedStreamFilter)) {
      this.#scheduleReconcile();
    }
  }

  /**
   * Pump events from a shared-stream handle into `#handleIncoming`.
   * One pump task runs per open stream; during rotation overlap two
   * pumps may be active briefly, with `#seenEventIds` deduping.
   */
  async #pumpStream(handle: EventStreamHandle): Promise<void> {
    try {
      for await (const message of handle.events) {
        if (this.#closed) {
          break;
        }
        this.#handleIncoming(message);
      }
    } catch (err) {
      if (handle === this.#sharedStream && !this.#closed) {
        this.#failThreadWithError(err);
      }
      // Errors on an old (being-rotated-out) stream are ignored —
      // the new stream is already pumping and holds authoritative state.
    }
  }

  /**
   * Resolve any pending `subscribe()` promises whose filter is now
   * covered by the active shared stream. Called after every successful
   * rotation (and after no-op reconciliations).
   */
  #resolvePending(): void {
    if (this.#sharedStreamFilter == null) return;
    const current = this.#sharedStreamFilter;
    if (this.#pendingSubResolves.length === 0) return;
    const stillPending: PendingSubResolve[] = [];
    for (const pending of this.#pendingSubResolves) {
      if (filterCovers(current, pending.filter)) {
        pending.resolve();
      } else {
        stillPending.push(pending);
      }
    }
    this.#pendingSubResolves.length = 0;
    this.#pendingSubResolves.push(...stillPending);
  }

  /**
   * Reject pending `subscribe()` promises whose filter isn't covered
   * by the existing stream (they're the ones that triggered the
   * failed rotation). Covered pending subs are resolved normally —
   * they didn't need the new stream.
   */
  #rejectUncoveredPending(err: unknown): void {
    if (this.#pendingSubResolves.length === 0) return;
    const current = this.#sharedStreamFilter;
    const stillPending: PendingSubResolve[] = [];
    for (const pending of this.#pendingSubResolves) {
      if (current != null && filterCovers(current, pending.filter)) {
        pending.resolve();
      } else {
        stillPending.push(pending);
      }
    }
    this.#pendingSubResolves.length = 0;
    for (const pending of stillPending) pending.reject(err);
  }

  /**
   * Terminate the thread due to an unrecoverable shared-stream error.
   * Rejects pending commands, closes subscriptions, and marks the
   * thread closed so no further rotations occur.
   */
  #failThreadWithError(err: unknown): void {
    const normalized =
      // oxlint-disable-next-line no-instanceof/no-instanceof
      err instanceof Error ? err : new Error(String(err));
    for (const pending of this.#pending.values()) {
      pending.reject(normalized);
    }
    this.#pending.clear();
    for (const pending of this.#pendingSubResolves) {
      pending.reject(normalized);
    }
    this.#pendingSubResolves.length = 0;
    for (const subscription of this.#subscriptions.values()) {
      subscription.close();
    }
  }

  /**
   * Command-based subscription (WebSocket fallback). The server replays
   * matching buffered events on subscribe via the same WebSocket stream.
   */
  async #subscribeViaCommand(
    params: SubscribeParams,
    transform?: (event: Event) => unknown
  ): Promise<SubscriptionHandle<Event>> {
    // Register the subscription on the client BEFORE sending the
    // ``subscription.subscribe`` command. The WebSocket server replays
    // buffered events through ``install_subscription_with_replay``
    // *before* returning the success response that carries the
    // ``subscription_id``. If we waited for the response and only then
    // ran ``this.#subscriptions.set(...)``, those replayed events would
    // arrive at ``#handleIncoming`` while no matching subscription is
    // registered — they would never reach the iterator, so
    // namespace-scoped projections (``useMessages``) would render
    // empty after click-to-expand on the WebSocket transport.
    //
    // ``#handleIncoming``'s fan-out matches purely on
    // ``subscription.filter`` (channels + namespaces + depth), so a
    // pre-registered entry under any temporary key already catches
    // every replayed event. Once the server-assigned id arrives, we
    // re-key the entry so a later ``unsubscribe`` finds it.
    // ``#nextCommandId`` is post-incremented inside ``#send``; reading
    // it here doesn't reserve the value, so two concurrent subscribes
    // (typical under React StrictMode's mount→unmount→mount) would
    // collide on the same placeholder. Mint a UUID-like suffix instead.
    const placeholderId = `pending:${this.#nextCommandId}:${Math.random().toString(36).slice(2, 10)}`;
    let resolvedId = placeholderId;
    const handle = new SubscriptionHandle<Event, unknown>(
      placeholderId,
      params,
      async () => {
        // Use the server-assigned id once we have it; fall back to the
        // placeholder while the subscribe command is still in flight
        // (unsubscribe before subscribe-response is unusual but
        // possible — disposing a projection that mounted and unmounted
        // in the same React tick).
        this.#subscriptions.delete(resolvedId);
        if (!this.#closed && resolvedId !== placeholderId) {
          await this.#send("subscription.unsubscribe", {
            subscription_id: resolvedId,
          }).catch((err: unknown) => {
            if (
              // oxlint-disable-next-line no-instanceof/no-instanceof
              err instanceof ProtocolError &&
              err.code === "no_such_subscription"
            ) {
              return;
            }
            throw err;
          });
        }
      },
      transform
    );
    const subscription = Object.assign(handle, {
      filter: params,
      registeredAfterSeq: this.ordering.lastSeenSeq,
      seenEventIds: new Set<string>(),
    });
    this.#subscriptions.set(placeholderId, subscription);
    // Wait for any in-flight `run.start` send to commit the thread
    // server-side. WS `subscription.subscribe` is rejected with
    // `404: Thread not found` if it arrives before the thread is
    // created — mirroring the SSE gates in `#startLifecycleWatcherSse`
    // and `#reconcileStream`.
    if (this.#runStartReady != null) {
      try {
        await this.#runStartReady;
      } catch (err) {
        this.#subscriptions.delete(placeholderId);
        throw err;
      }
    }
    let result: SubscribeResult;
    try {
      result = await this.#send("subscription.subscribe", params);
    } catch (err) {
      this.#subscriptions.delete(placeholderId);
      throw err;
    }
    this.#subscriptions.delete(placeholderId);
    resolvedId = result.subscription_id;
    // Re-key the map AND update the handle's public id. Without the
    // second write, `#lifecycleSubId === handle.subscriptionId` checks
    // (see `#prepareForNextRun` and the terminal-pause logic) compare
    // the cached placeholder against the live map key and silently
    // fail, causing the lifecycle subscription to be paused at
    // terminal events on the WS transport.
    handle.subscriptionId = resolvedId;
    this.#subscriptions.set(resolvedId, subscription);
    return handle as SubscriptionHandle<Event>;
  }

  /**
   * Re-issue `subscription.subscribe` for every active WS subscription
   * after the transport reconnects. The server replays buffered events on
   * the new socket; client-side `event_id` dedup suppresses duplicates.
   */
  async #resubscribeWebSocketSubscriptions(): Promise<void> {
    if (this.#transportAdapter.openEventStream != null || this.#closed) {
      return;
    }

    const entries = [...this.#subscriptions.entries()];
    await Promise.all(
      entries.map(async ([id, subscription]) => {
        if (id.startsWith("pending:")) {
          return;
        }
        try {
          const result = await this.#send(
            "subscription.subscribe",
            subscription.filter
          );
          const nextId = result.subscription_id;
          if (nextId === id) {
            return;
          }
          this.#subscriptions.delete(id);
          (
            subscription as unknown as SubscriptionHandle<Event>
          ).subscriptionId = nextId;
          this.#subscriptions.set(nextId, subscription);
          if (this.#lifecycleSubId === id) {
            this.#lifecycleSubId = nextId;
          }
        } catch {
          // Best-effort; the content pump may still receive replayed events.
        }
      })
    );
  }

  async #consumeEvents(): Promise<void> {
    try {
      for await (const message of this.#transportAdapter.events()) {
        this.#handleIncoming(message);
      }
      for (const subscription of this.#subscriptions.values()) {
        subscription.close();
      }
    } catch (error) {
      const normalized =
        // oxlint-disable-next-line no-instanceof/no-instanceof
        error instanceof Error ? error : new Error(String(error));
      for (const pending of this.#pending.values()) {
        pending.reject(normalized);
      }
      for (const subscription of this.#subscriptions.values()) {
        subscription.close();
      }
      this.#pending.clear();
    }
  }

  /**
   * Pause non-lifecycle subscriptions after a root terminal lifecycle.
   *
   * The pause is deferred one macrotask so same-run trailing events
   * emitted immediately after terminal (for example final `values`)
   * can still drain. `terminalSeq` lets replay attachers skip terminals
   * that happened before they registered, so late subscribers can keep
   * consuming the replayed history they joined for.
   */
  #scheduleTerminalPause(terminalSeq: number | undefined): void {
    if (this.#terminalPauseTimer != null) {
      clearTimeout(this.#terminalPauseTimer);
    }
    this.#terminalPauseSeq = terminalSeq ?? null;
    this.#terminalPauseTimer = setTimeout(() => {
      this.#terminalPauseTimer = undefined;
      if (this.#closed) return;
      for (const [id, subscription] of this.#subscriptions) {
        if (id === this.#lifecycleSubId) continue;
        if (
          terminalSeq != null &&
          subscription.registeredAfterSeq != null &&
          subscription.registeredAfterSeq >= terminalSeq
        ) {
          continue;
        }
        subscription.pause();
      }
    }, 0);
  }

  #handleIncoming(message: Message): void {
    if (message.type === "event") {
      if (typeof message.seq === "number") {
        this.ordering.lastSeenSeq = maxSeq(
          this.ordering.lastSeenSeq,
          message.seq
        );
      }
      if (message.event_id) {
        this.ordering.lastEventId = message.event_id;
      }

      // Two flavors of dedup live here:
      //   1. Thread-level side effects (interrupt state, interrupt
      //      capture) — must run AT MOST ONCE per unique event_id
      //      regardless of how many times the event is redelivered
      //      (rotation overlap, WebSocket fan-out). Gated by the
      //      global `#seenEventIds`.
      //   2. Per-subscription fan-out — gated by each sub's own
      //      `seenEventIds`. This is what lets a rotation-triggered
      //      replay (the server opens a fresh session that replays
      //      from seq=0) reach newly-registered subs while NOT
      //      redelivering events to subs that have already consumed
      //      them. Event IDs are stable across sessions for the same
      //      run, so per-sub set membership is the correct predicate.
      const eventId = message.event_id ?? undefined;
      const globallyProcessed =
        eventId != null && this.#seenEventIds.has(eventId);
      if (eventId != null) {
        this.#seenEventIds.add(eventId);
      }

      const TERMINAL_LIFECYCLE_EVENTS = new Set([
        "interrupted",
        "completed",
        "failed",
      ]);

      if (!globallyProcessed) {
        this.#applyThreadLevelEffects(message);
        this.#fireOnEvent(message);
      }

      // Unified fan-out: both SSE (shared stream) and WebSocket paths
      // deliver every event through a single connection; the client
      // dispatches to matching subscriptions based on each sub's
      // advertised filter, with per-sub dedup.
      let fannedToAny = false;
      for (const subscription of this.#subscriptions.values()) {
        if (!matchesSubscription(message, subscription.filter)) continue;
        if (eventId != null) {
          if (subscription.seenEventIds.has(eventId)) {
            continue;
          }
          subscription.seenEventIds.add(eventId);
        }
        subscription.push(message);
        fannedToAny = true;
      }

      // A root terminal schedules subscription pause on a macrotask,
      // but reconnect/replay can still deliver same-run trailing state
      // afterward (for example the final `values` snapshot). Drain that
      // event, briefly resume any paused consumers, then re-arm the
      // terminal pause so idle subscriptions still settle.
      if (
        fannedToAny &&
        this.#terminalPauseSeq !== undefined &&
        !(
          message.method === "lifecycle" &&
          message.params.namespace.length === 0
        )
      ) {
        const eventSeq =
          typeof message.seq === "number" ? message.seq : undefined;
        const terminalSeq = this.#terminalPauseSeq;
        if (
          terminalSeq === null ||
          eventSeq == null ||
          eventSeq > terminalSeq
        ) {
          if (this.#terminalPauseTimer != null) {
            clearTimeout(this.#terminalPauseTimer);
            this.#terminalPauseTimer = undefined;
          }
          for (const [id, subscription] of this.#subscriptions) {
            if (id !== this.#lifecycleSubId) {
              subscription.resume();
            }
          }
          this.#scheduleTerminalPause(
            terminalSeq === null ? undefined : terminalSeq
          );
        }
      }

      if (
        fannedToAny &&
        message.method === "lifecycle" &&
        message.params.namespace.length === 0 &&
        TERMINAL_LIFECYCLE_EVENTS.has(message.params.data.event)
      ) {
        const shouldSkipPause =
          message.params.data.event === "interrupted" &&
          this.#headlessInterruptsAwaitingTerminal.size > 0;
        if (shouldSkipPause) {
          this.#headlessInterruptsAwaitingTerminal.clear();
          return;
        }
        // A single shared stream delivers every subscription's events,
        // so a terminal event applies to all currently active
        // non-lifecycle subscriptions. Defer the pause one macrotask:
        // transformer `finalize()` hooks can emit trailing custom events
        // immediately after root lifecycle completion, and pausing
        // synchronously would buffer those same-run events until the
        // next submit resumes subscriptions.
        this.#scheduleTerminalPause(
          typeof message.seq === "number" ? message.seq : undefined
        );
      }
      return;
    }

    const messageId = typeof message.id === "number" ? message.id : undefined;
    const pending =
      messageId === undefined ? undefined : this.#pending.get(messageId);
    if (!pending) {
      return;
    }
    if (messageId !== undefined) {
      this.#pending.delete(messageId);
    }
    if (message.type === "error") {
      pending.reject(new ProtocolError(message));
      return;
    }
    if (typeof message.meta?.applied_through_seq === "number") {
      this.ordering.lastAppliedThroughSeq = message.meta.applied_through_seq;
    }
    pending.resolve(message);
  }

  async #send<TMethod extends keyof CommandResultMap>(
    method: TMethod,
    params: CommandParamsMap[TMethod]
  ): Promise<CommandResultMap[TMethod]> {
    await this.#ensureOpen();
    const id = this.#nextCommandId++;
    const command = {
      id,
      method,
      params,
    } as Command;
    const responsePromise = new Promise<CommandResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    const immediate = await this.#transportAdapter.send(command);
    if (immediate) {
      this.#pending.delete(id);
      if (immediate.type === "error") {
        throw new ProtocolError(immediate);
      }
      if (typeof immediate.meta?.applied_through_seq === "number") {
        this.ordering.lastAppliedThroughSeq =
          immediate.meta.applied_through_seq;
      }
      return immediate.result as CommandResultMap[TMethod];
    }
    const response = await responsePromise;
    return response.result as CommandResultMap[TMethod];
  }
}

export {
  MessageAssembler,
  StreamingMessageAssembler,
  StreamingMessage,
} from "./messages.js";
export type { AssembledMessage, MessageAssemblyUpdate } from "./messages.js";
export {
  ToolCallAssembler,
  toClientAssembledToolCall,
  SubgraphDiscoveryHandle,
  SubgraphHandle,
  SubagentHandle,
  SubagentDiscoveryHandle,
} from "./handles/index.js";
export type {
  ClientAssembledToolCall,
  ClientAssembledToolCall as AssembledToolCall,
  ToolCallStatus,
  Subscribable,
} from "./handles/index.js";
export { inferChannel, matchesSubscription } from "./subscription.js";
export type { TransportAdapter, AgentServerAdapter } from "./transport.js";
export type * from "./types.js";
export { ProtocolError, MaxWebSocketReconnectAttemptsError } from "./error.js";
export { MediaAssembler, MediaAssemblyError } from "./media.js";
export type {
  AnyMediaHandle,
  AudioMedia,
  FileMedia,
  ImageMedia,
  MediaAssemblerCallbacks,
  MediaAssemblerOptions,
  MediaAssemblyErrorKind,
  MediaBase,
  MediaBlockType,
  VideoMedia,
} from "./media.js";
