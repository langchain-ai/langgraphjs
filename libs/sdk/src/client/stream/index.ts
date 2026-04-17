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
import type { TransportAdapter } from "./transport.js";
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
  // side effects (interrupt tracking, `input.requested` capture). In SSE
  // transport mode, multiple independent server-side streams can deliver
  // the same event via replay; without this dedup the same interrupt
  // would be recorded multiple times.
  readonly #seenEventIds = new Set<string>();
  #closed = false;
  #opened = false;
  #openPromise?: Promise<void>;

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
        const data = coerceStateMessages(
          (event as ValuesEvent).params.data
        );
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
      const data = event.params.data as {
        name?: string;
        payload?: unknown;
      } | undefined;
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
    for (const subscription of this.#subscriptions.values()) {
      subscription.close();
    }
    this.#subscriptions.clear();
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
      return this.#subscribeViaEventStream(params, transform);
    }

    return this.#subscribeViaCommand(params, transform);
  }

  /**
   * Open an independent SSE event stream for this subscription.
   * Used by SSE transports where each subscription = one POST connection.
   * Awaits the underlying connection's ready signal so callers can
   * depend on the subscription being active server-side on return.
   */
  async #subscribeViaEventStream(
    params: SubscribeParams,
    transform?: (event: Event) => unknown
  ): Promise<SubscriptionHandle<Event>> {
    const streamHandle = this.#transportAdapter.openEventStream!(params);
    const subscriptionId = `stream-${this.#nextCommandId++}`;

    const handle = new SubscriptionHandle<Event, unknown>(
      subscriptionId,
      params,
      async (id) => {
        this.#subscriptions.delete(id);
        streamHandle.close();
      },
      transform
    );

    const subscription = Object.assign(handle, { filter: params });
    this.#subscriptions.set(subscriptionId, subscription);

    void (async () => {
      try {
        for await (const message of streamHandle.events) {
          if (this.#closed) break;
          this.#handleIncoming(message, subscription);
        }
      } catch {
        // stream closed or errored — handle already cleaned up
      }
    })();

    await streamHandle.ready;
    return handle as SubscriptionHandle<Event>;
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
    const subscription = Object.assign(handle, { filter: params });
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

  #handleIncoming(
    message: Message,
    ownerSubscription?: InternalEventSubscription
  ): void {
    if (message.type === "event") {
      if (typeof message.seq === "number") {
        this.ordering.lastSeenSeq = message.seq;
      }
      if (message.event_id) {
        this.ordering.lastEventId = message.event_id;
      }

      // Dedup thread-level side-effects across streams. In SSE mode each
      // subscription gets its own filtered server stream, and the server
      // replays buffered events on attach, so the same event (same
      // `event_id`) can reach the client multiple times — once per stream
      // whose filter matches it. Without this guard, an interrupt/input
      // request would be recorded multiple times.
      const eventId = message.event_id ?? undefined;
      const alreadyProcessed =
        eventId != null && this.#seenEventIds.has(eventId);
      if (eventId != null) {
        this.#seenEventIds.add(eventId);
      }

      const TERMINAL_LIFECYCLE_EVENTS = new Set([
        "interrupted",
        "completed",
        "failed",
      ]);

      if (!alreadyProcessed) {
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

      if (ownerSubscription != null) {
        // SSE transport: the server already filtered events for this
        // subscription's stream. Deliver only to the owning subscription
        // so the same event is not pushed multiple times (which would
        // otherwise surface as duplicate subagent/subgraph discovery
        // and out-of-order message assembly on late-attaching streams).
        ownerSubscription.push(message);
      } else if (!alreadyProcessed) {
        // WebSocket transport: a single shared stream delivers all
        // events. Fan-out to every matching subscription. Dedup on
        // `event_id` is a safety net for transports that might redeliver.
        for (const subscription of this.#subscriptions.values()) {
          if (matchesSubscription(message, subscription.filter)) {
            subscription.push(message);
          }
        }
      }

      if (
        message.method === "lifecycle" &&
        message.params.namespace.length === 0 &&
        TERMINAL_LIFECYCLE_EVENTS.has(message.params.data.event)
      ) {
        if (ownerSubscription != null) {
          // SSE transport: each subscription has its own independent
          // server stream, and terminal lifecycle events are replayed
          // on every new stream. Only pause the stream that delivered
          // this terminal event — pausing peer subscriptions would
          // prematurely kill handles (e.g. a freshly-opened extensions
          // dispatcher) whose own stream hasn't delivered its terminal
          // event yet.
          if (ownerSubscription.subscriptionId !== this.#lifecycleSubId) {
            ownerSubscription.pause();
          }
        } else {
          // WebSocket transport: a single shared stream delivers every
          // subscription's events, so a terminal event applies to all
          // currently active non-lifecycle subscriptions.
          for (const [id, subscription] of this.#subscriptions) {
            if (id !== this.#lifecycleSubId) {
              subscription.pause();
            }
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
