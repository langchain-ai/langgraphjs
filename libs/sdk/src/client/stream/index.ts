import type {
  AgentResult,
  CapabilityAdvertisement,
  Channel,
  Command,
  CommandResponse,
  Event,
  InputInjectParams,
  InputRespondParams,
  LifecycleEvent,
  ListCheckpointsParams,
  ListCheckpointsResult,
  Message,
  ReconnectParams,
  ReconnectResult,
  ResourceDownloadParams,
  ResourceDownloadResult,
  ResourceListParams,
  ResourceListResult,
  ResourceReadParams,
  ResourceReadResult,
  ResourceWriteParams,
  RunInputParams,
  RunResult,
  SandboxInputParams,
  SandboxKillParams,
  SessionOpenParams,
  SessionResult,
  StateForkParams,
  StateForkResult,
  StateGetParams,
  StateGetResult,
  SubscribeParams,
  SubscribeResult,
  TransportProfile,
  UsageBudgetParams,
} from "@langchain/protocol";
import { EventBuffer } from "./buffer.js";
import { matchesSubscription } from "./subscription.js";
import {
  ToolSubscriptionHandle,
  ValuesSubscriptionHandle,
  SubgraphDiscoveryHandle,
  SubagentDiscoveryHandle,
  StreamingMessageSubscriptionHandle,
} from "./handles/index.js";
import type {
  EventSubscription,
  EventForChannel,
  EventForChannels,
  InterruptPayload,
  ProtocolClientOptions,
  SessionModules,
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
  "session.open": SessionResult;
  "session.describe": SessionResult;
  "session.close": Record<string, unknown>;
  "run.input": RunResult;
  "subscription.subscribe": SubscribeResult;
  "subscription.unsubscribe": Record<string, unknown>;
  "subscription.reconnect": ReconnectResult;
  "agent.getTree": AgentResult;
  "resource.list": ResourceListResult;
  "resource.read": ResourceReadResult;
  "resource.write": Record<string, unknown>;
  "resource.download": ResourceDownloadResult;
  "sandbox.input": Record<string, unknown>;
  "sandbox.kill": Record<string, unknown>;
  "input.respond": Record<string, unknown>;
  "input.inject": Record<string, unknown>;
  "state.get": StateGetResult;
  "state.listCheckpoints": ListCheckpointsResult;
  "state.fork": StateForkResult;
  "usage.setBudget": Record<string, unknown>;
};

type CommandParamsMap = {
  "session.open": SessionOpenParams;
  "session.describe": Record<string, unknown>;
  "session.close": Record<string, unknown>;
  "run.input": RunInputParams;
  "subscription.subscribe": SubscribeParams;
  "subscription.unsubscribe": { subscription_id: string };
  "subscription.reconnect": ReconnectParams;
  "agent.getTree": { run_id?: string };
  "resource.list": ResourceListParams;
  "resource.read": ResourceReadParams;
  "resource.write": ResourceWriteParams;
  "resource.download": ResourceDownloadParams;
  "sandbox.input": SandboxInputParams;
  "sandbox.kill": SandboxKillParams;
  "input.respond": InputRespondParams;
  "input.inject": InputInjectParams;
  "state.get": StateGetParams;
  "state.listCheckpoints": ListCheckpointsParams;
  "state.fork": StateForkParams;
  "usage.setBudget": UsageBudgetParams;
};

type InternalEventSubscription = EventSubscription<unknown> & {
  filter: SubscribeParams;
  push(event: Event): void;
  close(): void;
};

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
 * High-level session wrapper that exposes capability-aware command modules,
 * subscription management, replay, and ordering metadata.
 */
export class Session {
  readonly sessionId: string;
  readonly capabilities: CapabilityAdvertisement;
  readonly transport: TransportProfile;
  readonly ordering: SessionOrderingState = {};
  readonly run: SessionModules["run"];
  readonly agent: SessionModules["agent"];
  readonly resource?: SessionModules["resource"];
  readonly sandbox?: SessionModules["sandbox"];
  readonly input?: SessionModules["input"];
  readonly state?: SessionModules["state"];
  readonly usage?: SessionModules["usage"];

  /**
   * Whether the run was interrupted (a lifecycle "interrupted" event
   * was received). Mirrors the in-process `run.interrupted`.
   */
  interrupted = false;

  /**
   * Interrupt payloads collected during the session, if any.
   * Mirrors the in-process `run.interrupts`.
   */
  readonly interrupts: InterruptPayload[] = [];

  #nextCommandId: number;
  readonly #transportAdapter: TransportAdapter;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #buffer: EventBuffer;
  readonly #subscriptions = new Map<string, InternalEventSubscription>();
  readonly #activeFilters = new Map<string, SubscribeParams>();
  #closed = false;
  readonly #capabilitiesAdvertised: boolean;
  #lifecycleSubId: string | null = null;

  constructor(
    transportAdapter: TransportAdapter,
    sessionResult: SessionResult,
    options: ProtocolClientOptions = {}
  ) {
    this.#transportAdapter = transportAdapter;
    this.sessionId = sessionResult.session_id;
    this.capabilities = sessionResult.capabilities;
    this.transport = sessionResult.transport;
    this.#capabilitiesAdvertised = this.capabilities.modules.length > 0;
    this.#nextCommandId = options.startingCommandId ?? 1;
    this.#buffer = new EventBuffer(options.eventBufferSize);
    this.run = {
      input: async (params) => {
        this.#prepareForNextRun();
        return await this.#send("run.input", params);
      },
    };
    this.agent = {
      getTree: async (params = {}) => await this.#send("agent.getTree", params),
    };
    if (this.hasModule("resource")) {
      this.resource = {
        list: async (params) => await this.#send("resource.list", params),
        read: async (params) => await this.#send("resource.read", params),
        write: async (params) => {
          await this.#send("resource.write", params);
        },
        download: async (params) =>
          await this.#send("resource.download", params),
      };
    }
    if (this.hasModule("sandbox")) {
      this.sandbox = {
        input: async (params) => {
          await this.#send("sandbox.input", params);
        },
        kill: async (params) => {
          await this.#send("sandbox.kill", params);
        },
      };
    }
    if (this.hasModule("input")) {
      this.input = {
        respond: async (params) => {
          this.#prepareForNextRun();
          await this.#send("input.respond", params);
        },
        inject: async (params) => {
          await this.#send("input.inject", params);
        },
      };
    }
    if (this.hasModule("state")) {
      this.state = {
        get: async (params) => await this.#send("state.get", params),
        listCheckpoints: async (params) =>
          await this.#send("state.listCheckpoints", params),
        fork: async (params) => await this.#send("state.fork", params),
      };
    }
    if (this.hasModule("usage")) {
      this.usage = {
        setBudget: async (params) => {
          await this.#send("usage.setBudget", params);
        },
      };
    }
    void this.#consumeEvents();
  }

  /**
   * Subscribe to lifecycle and input channels so that session-level
   * interrupt tracking works even when the user only subscribes to
   * data channels like `"values"`.  Called automatically by
   * {@link ProtocolClient.open}.
   */
  async initLifecycleTracking(): Promise<void> {
    const channels: Channel[] = [];
    if (this.supportsChannel("lifecycle")) channels.push("lifecycle");
    if (this.supportsChannel("input")) channels.push("input");
    if (channels.length === 0) return;
    const sub = await this.#subscribeRaw({ channels });
    this.#lifecycleSubId = sub.subscriptionId;
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

  hasModule(name: string): boolean {
    if (!this.#capabilitiesAdvertised) {
      return true;
    }
    return this.capabilities.modules.some((module) => module.name === name);
  }

  supportsChannel(channel: Channel): boolean {
    if (!this.#capabilitiesAdvertised) {
      return true;
    }
    return this.capabilities.modules.some((module) =>
      (module.channels ?? []).includes(channel)
    );
  }

  supportsCommand(method: string): boolean {
    if (!this.#capabilitiesAdvertised) {
      return true;
    }
    const [moduleName, commandName] = method.split(".");
    return this.capabilities.modules.some(
      (module) =>
        module.name === moduleName &&
        ((module.commands ?? []).includes(method) ||
          (module.commands ?? []).includes(commandName ?? ""))
    );
  }

  assertSupportsChannel(channel: Channel): void {
    if (!this.supportsChannel(channel)) {
      throw new Error(
        `Channel "${channel}" is not advertised by the session capabilities`
      );
    }
  }

  assertSupportsCommand(method: string): void {
    if (!this.supportsCommand(method)) {
      throw new Error(
        `Command "${method}" is not advertised by the session capabilities`
      );
    }
  }

  async describe(): Promise<SessionResult> {
    return await this.#send("session.describe", {});
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.#send("session.close", {});
    } finally {
      for (const subscription of this.#subscriptions.values()) {
        subscription.close();
      }
      this.#subscriptions.clear();
      await this.#transportAdapter.close();
    }
  }

  /**
   * Subscribe to a projection or raw channel and receive events.
   *
   * **Projection names** return assembled handles matching the
   * in-process `GraphRunStream` property names:
   * - `"toolCalls"` → {@link ToolSubscriptionHandle} (wire: `tools`)
   * - `"values"` → {@link ValuesSubscriptionHandle} with `.output` (wire: `values`)
   * - `"messages"` → {@link StreamingMessageSubscriptionHandle} (wire: `messages`)
   * - `"subgraphs"` → {@link SubgraphDiscoveryHandle} (wire: `lifecycle`)
   * - `"subagents"` → {@link SubagentDiscoveryHandle} (wire: `tools` + `lifecycle`)
   *
   * **Raw wire channels** (via params or array form) return a raw
   * {@link SubscriptionHandle} with protocol events.
   */
  async subscribe(
    projection: "toolCalls",
    options?: SubscribeOptions
  ): Promise<ToolSubscriptionHandle>;
  async subscribe(
    projection: "values",
    options?: SubscribeOptions
  ): Promise<ValuesSubscriptionHandle>;
  async subscribe(
    projection: "messages",
    options?: SubscribeOptions
  ): Promise<StreamingMessageSubscriptionHandle>;
  async subscribe(
    projection: "subgraphs",
    options?: SubscribeOptions
  ): Promise<SubgraphDiscoveryHandle>;
  async subscribe(
    projection: "subagents",
    options?: SubscribeOptions
  ): Promise<SubagentDiscoveryHandle>;
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
    paramsOrChannels: SubscribeParams | Channel | string | readonly Channel[],
    options: SubscribeOptions = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const isSingleString =
      typeof paramsOrChannels === "string" && !Array.isArray(paramsOrChannels);
    const name = isSingleString ? paramsOrChannels : undefined;

    if (name === "subgraphs") {
      const rawHandle = await this.#subscribeRaw({
        ...options,
        channels: ["lifecycle"],
      });
      const parentNamespace = options.namespaces?.[0] ?? [];
      return new SubgraphDiscoveryHandle(rawHandle, this, parentNamespace);
    }

    if (name === "subagents") {
      const rawHandle = await this.#subscribeRaw({
        ...options,
        channels: ["tools", "lifecycle"],
      });
      return new SubagentDiscoveryHandle(rawHandle, this);
    }

    if (name === "toolCalls") {
      const rawHandle = await this.#subscribeRaw({
        ...options,
        channels: ["tools"],
      });
      return new ToolSubscriptionHandle(rawHandle);
    }

    const params = normalizeSubscribeParams(
      paramsOrChannels as SubscribeParams | Channel | readonly Channel[],
      options
    );
    const rawHandle = await this.#subscribeRaw(params);

    if (isSingleString) {
      switch (name) {
        case "values":
          return new ValuesSubscriptionHandle(rawHandle);
        case "messages":
          return new StreamingMessageSubscriptionHandle(rawHandle);
        default:
          break;
      }
    }

    return rawHandle;
  }

  async #subscribeRaw(
    params: SubscribeParams
  ): Promise<SubscriptionHandle<Event>> {
    const hasOnlyNamedCustom =
      params.channels.length > 0 &&
      params.channels.every((ch) => ch.startsWith("custom:"));
    for (const channel of params.channels) {
      if (!channel.startsWith("custom:")) {
        this.assertSupportsChannel(channel);
      }
    }
    const result = await this.#send("subscription.subscribe", params);
    const transform = hasOnlyNamedCustom
      ? (event: Event) =>
          (
            (event.params as Record<string, unknown>).data as {
              payload?: unknown;
            }
          )?.payload ?? event
      : undefined;
    const handle = new SubscriptionHandle<Event, unknown>(
      result.subscription_id,
      params,
      async (id) => {
        this.#activeFilters.delete(id);
        this.#subscriptions.delete(id);
        if (!this.#closed) {
          await this.#send("subscription.unsubscribe", { subscription_id: id })
            .catch((err: unknown) => {
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
    this.#activeFilters.set(result.subscription_id, params);
    this.#subscriptions.set(result.subscription_id, subscription);
    for (const buffered of this.#buffer.replay(params)) {
      handle.push(buffered);
    }
    return handle as SubscriptionHandle<Event>;
  }

  async reconnect(params: ReconnectParams): Promise<ReconnectResult> {
    const result = await this.#send("subscription.reconnect", params);
    if (result.restored) {
      for (const [id, filter] of this.#activeFilters) {
        if (params.subscriptions && !params.subscriptions.includes(id)) {
          continue;
        }
        for (const event of this.#buffer.replay(filter, params.last_event_id)) {
          this.#subscriptions.get(id)?.push(event);
        }
      }
    }
    return result;
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
      this.#buffer.push(message);
      if (typeof message.seq === "number") {
        this.ordering.lastSeenSeq = message.seq;
      }
      if (message.event_id) {
        this.ordering.lastEventId = message.event_id;
      }

      const TERMINAL_LIFECYCLE_EVENTS = new Set([
        "interrupted",
        "completed",
        "failed",
      ]);

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

      for (const subscription of this.#subscriptions.values()) {
        if (matchesSubscription(message, subscription.filter)) {
          subscription.push(message);
        }
      }

      if (
        message.method === "lifecycle" &&
        message.params.namespace.length === 0 &&
        TERMINAL_LIFECYCLE_EVENTS.has(message.params.data.event)
      ) {
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
    if (method !== "session.describe" && method !== "session.close") {
      this.assertSupportsCommand(method);
    }
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

/**
 * Entry point for opening protocol sessions over a transport implementation.
 */
export class ProtocolClient {
  private readonly transportFactory:
    | TransportAdapter
    | (() => TransportAdapter | Promise<TransportAdapter>);
  private readonly options: ProtocolClientOptions;

  constructor(
    transportFactory:
      | TransportAdapter
      | (() => TransportAdapter | Promise<TransportAdapter>),
    options: ProtocolClientOptions = {}
  ) {
    this.transportFactory = transportFactory;
    this.options = options;
  }

  async open(params: SessionOpenParams): Promise<Session> {
    const transport =
      typeof this.transportFactory === "function"
        ? await this.transportFactory()
        : this.transportFactory;
    const response = await transport.open(params);
    const session = new Session(transport, response, this.options);
    await session.initLifecycleTracking();
    return session;
  }
}

export { EventBuffer } from "./buffer.js";
export { MessageAssembler, StreamingMessageAssembler, StreamingMessage } from "./messages.js";
export type { AssembledMessage, MessageAssemblyUpdate } from "./messages.js";
export {
  ToolCallAssembler,
  ToolSubscriptionHandle,
  ValuesSubscriptionHandle,
  SubgraphDiscoveryHandle,
  SubgraphHandle,
  SubagentHandle,
  SubagentDiscoveryHandle,
  MessageSubscriptionHandle,
  StreamingMessageSubscriptionHandle,
} from "./handles/index.js";
export type { AssembledToolCall, ToolCallStatus, Subscribable } from "./handles/index.js";
export { inferChannel, matchesSubscription } from "./subscription.js";
export type { TransportAdapter } from "./transport.js";
export type * from "./types.js";
export { ProtocolError } from "./error.js";