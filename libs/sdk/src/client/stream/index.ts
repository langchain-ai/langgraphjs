import type {
  Channel,
  Command,
  CommandResponse,
  Event,
  LifecycleEvent,
  ListCheckpointsResult,
  Message,
  MessagesEvent,
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
  SubgraphDiscoveryHandle,
  SubgraphHandle,
  SubagentDiscoveryHandle,
  SubagentHandle,
} from "./handles/index.js";
import { StreamingMessageAssembler } from "./messages.js";
import type { StreamingMessage } from "./messages.js";
import type { AssembledToolCall } from "./handles/tools.js";
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

type PendingCommand = {
  resolve: (response: CommandResponse) => void;
  reject: (error: Error) => void;
};

type CommandResultMap = {
  "run.input": RunResult;
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
  "run.input": Record<string, unknown>;
  "subscription.subscribe": SubscribeParams;
  "subscription.unsubscribe": { subscription_id: string };
  "agent.getTree": { run_id?: string };
  "input.respond": Record<string, unknown>;
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

/**
 * Channel-set equality. The shared-stream filter is always permissive
 * (no namespaces/depth), so comparing channel membership is sufficient
 * to decide whether a rotation is needed.
 */
function filterEqual(
  a: SubscribeParams | null,
  b: SubscribeParams | null
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.channels.length !== b.channels.length) return false;
  const aSet = new Set(a.channels as Channel[]);
  for (const ch of b.channels as Channel[]) {
    if (!aSet.has(ch)) return false;
  }
  return true;
}

/**
 * Whether the permissive shared-stream filter covers a narrower
 * subscription filter. Coverage means "every event the subscription
 * could want will be delivered on the stream"; per-subscription
 * namespace/depth narrowing happens client-side in
 * {@link matchesSubscription}.
 */
function filterCovers(
  coverer: SubscribeParams,
  target: SubscribeParams
): boolean {
  const channels = new Set(coverer.channels as Channel[]);
  return (target.channels as Channel[]).every((ch) => channels.has(ch));
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
  readonly subscriptionId: string;
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
  // TODO(perf): this set grows at the rate of unique events per thread.
  // For long-lived threads we could replace with a seq high-watermark
  // plus `event_id` fallback for events missing a `seq` field.
  readonly #seenEventIds = new Set<string>();
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

  #lifecycleSubId: string | null = null;
  #lifecycleStartPromise?: Promise<void>;

  #messagesIterable?: AsyncIterable<StreamingMessage>;
  #valuesProjection?: AsyncIterable<unknown> & PromiseLike<unknown>;
  #toolCallsIterable?: AsyncIterable<AssembledToolCall>;
  #subgraphsIterable?: AsyncIterable<SubgraphHandle>;
  #subagentsIterable?: AsyncIterable<SubagentHandle>;
  #outputPromise?: Promise<unknown>;
  #extensionsProxy?: ThreadExtensions<TExtensions>;
  readonly #extensionsCache = new Map<string, ThreadExtension<unknown>>();

  /**
   * Shared state for the single `"custom"` channel subscription that
   * backs every `thread.extensions.<name>` handle.
   *
   * One subscription is opened eagerly from {@link run.input} (mirroring
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
      input: async (params) => {
        this.#prepareForNextRun();
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
        return await this.#send("run.input", {
          ...params,
          assistant_id: this.assistantId,
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
        // See note in `run.input` — keep `thread.output` working
        // across resumes regardless of access order.
        void this.values;
        await this.#send(
          "input.respond",
          params as unknown as CommandParamsMap["input.respond"]
        );
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
   * `run.input` and `subscribe({ channels: ["custom:..."] })`).
   *
   * Idempotent and fire-and-forget — invoked from `run.input` and
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
   * Reset interrupt state and resume all paused user subscriptions.
   * Called before `run.input()` and `input.respond()` so that
   * iterators on the same handle pick up the next run's events.
   */
  #prepareForNextRun(): void {
    this.interrupted = false;
    this.interrupts.length = 0;
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
  get messages(): AsyncIterable<StreamingMessage> {
    if (this.#messagesIterable) return this.#messagesIterable;
    const buffer = new MultiCursorBuffer<StreamingMessage>();
    this.#messagesIterable = buffer;
    const assembler = new StreamingMessageAssembler();
    void this.#startProjection(
      ["messages", ...this.#lifecycleChannels()],
      (event) => {
        if (event.method !== "messages") return;
        const msg = assembler.consume(event as MessagesEvent);
        if (msg) buffer.push(msg);
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
   * Tool calls with promise-based output/status/error.
   * Mirrors the in-process `run.toolCalls`.
   */
  get toolCalls(): AsyncIterable<AssembledToolCall> {
    if (this.#toolCallsIterable) return this.#toolCallsIterable;
    const buffer = new MultiCursorBuffer<AssembledToolCall>();
    this.#toolCallsIterable = buffer;
    const assembler = new ToolCallAssembler();
    void this.#startProjection(
      ["tools", ...this.#lifecycleChannels()],
      (event) => {
        if (event.method !== "tools") return;
        const tc = assembler.consume(event as ToolsEvent);
        if (tc) buffer.push(tc);
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
        channels: ["lifecycle", ...this.#lifecycleChannels()],
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
   * Discovered subagents. Mirrors the in-process deep-agent pattern.
   */
  get subagents(): AsyncIterable<SubagentHandle> {
    if (this.#subagentsIterable) return this.#subagentsIterable;
    const buffer = new MultiCursorBuffer<SubagentHandle>();
    this.#subagentsIterable = buffer;
    void (async () => {
      const rawHandle = await this.#subscribeRaw({
        channels: ["tools", "lifecycle", ...this.#lifecycleChannels()],
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
      }
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
   */
  async #startProjection(
    channels: Channel[],
    onEvent: (event: Event) => void,
    onDone: () => void
  ): Promise<void> {
    try {
      const rawHandle = await this.#subscribeRaw({ channels });
      for await (const event of rawHandle) {
        onEvent(event);
      }
    } finally {
      onDone();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
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
    for (const subscription of this.#subscriptions.values()) {
      subscription.close();
    }
    this.#subscriptions.clear();
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const params = normalizeSubscribeParams(
      paramsOrChannels as SubscribeParams | Channel | readonly Channel[],
      options
    );
    return await this.#subscribeRaw(params);
  }

  async #subscribeRaw(
    params: SubscribeParams
  ): Promise<SubscriptionHandle<Event>> {
    await this.#ensureOpen();
    const hasOnlyNamedCustom =
      params.channels.length > 0 &&
      params.channels.every((ch) => ch.startsWith("custom:"));
    const transform = hasOnlyNamedCustom
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
   * Permissive channel-union of every currently-registered subscription.
   * Namespaces and depth are intentionally dropped: the server-side
   * filter widens to "all events on these channels", and client-side
   * `matchesSubscription` performs per-subscription narrowing.
   *
   * Returns `null` when there are no subscriptions.
   */
  #computeUnionFilter(): SubscribeParams | null {
    const channels = new Set<Channel>();
    for (const sub of this.#subscriptions.values()) {
      for (const ch of sub.filter.channels) channels.add(ch);
    }
    if (channels.size === 0) return null;
    return { channels: [...channels] as Channel[] };
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
      void this.#reconcileStream();
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
        if (this.#closed) break;
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
    const result = await this.#send("subscription.subscribe", params);
    const handle = new SubscriptionHandle<Event, unknown>(
      result.subscription_id,
      params,
      async (id) => {
        this.#subscriptions.delete(id);
        if (!this.#closed) {
          await this.#send("subscription.unsubscribe", {
            subscription_id: id,
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
      seenEventIds: new Set<string>(),
    });
    this.#subscriptions.set(result.subscription_id, subscription);
    return handle as SubscriptionHandle<Event>;
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

  #handleIncoming(message: Message): void {
    if (message.type === "event") {
      if (typeof message.seq === "number") {
        this.ordering.lastSeenSeq = message.seq;
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
        if (message.method === "lifecycle") {
          const lifecycle = message as LifecycleEvent;
          if (lifecycle.params.data.event === "interrupted") {
            this.interrupted = true;
          }
        }

        if (message.method === "input.requested") {
          const data = message.params.data;
          this.interrupts.push({
            interruptId:
              data.interrupt_id ?? `interrupt_${this.interrupts.length}`,
            payload: data.payload,
            namespace: [...message.params.namespace],
          });
        }
      }

      // Unified fan-out: both SSE (shared stream) and WebSocket paths
      // deliver every event through a single connection; the client
      // dispatches to matching subscriptions based on each sub's
      // advertised filter, with per-sub dedup.
      let fannedToAny = false;
      for (const subscription of this.#subscriptions.values()) {
        if (!matchesSubscription(message, subscription.filter)) continue;
        if (eventId != null) {
          if (subscription.seenEventIds.has(eventId)) continue;
          subscription.seenEventIds.add(eventId);
        }
        subscription.push(message);
        fannedToAny = true;
      }

      if (
        fannedToAny &&
        message.method === "lifecycle" &&
        message.params.namespace.length === 0 &&
        TERMINAL_LIFECYCLE_EVENTS.has(message.params.data.event)
      ) {
        // A single shared stream delivers every subscription's events,
        // so a terminal event applies to all currently active
        // non-lifecycle subscriptions. Only fire when we actually
        // delivered the terminal event to at least one sub this tick
        // — a pure dedup re-arrival must not re-pause subs.
        for (const [id, subscription] of this.#subscriptions) {
          if (id !== this.#lifecycleSubId) {
            subscription.pause();
          }
        }
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
  SubgraphDiscoveryHandle,
  SubgraphHandle,
  SubagentHandle,
  SubagentDiscoveryHandle,
} from "./handles/index.js";
export type {
  AssembledToolCall,
  ToolCallStatus,
  Subscribable,
} from "./handles/index.js";
export { inferChannel, matchesSubscription } from "./subscription.js";
export type { TransportAdapter } from "./transport.js";
export type * from "./types.js";
export { ProtocolError } from "./error.js";
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
