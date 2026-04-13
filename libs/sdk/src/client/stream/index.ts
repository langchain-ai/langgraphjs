import type {
  AgentResult,
  CapabilityAdvertisement,
  Channel,
  Command,
  CommandResponse,
  ErrorResponse,
  Event,
  InputInjectParams,
  InputRespondParams,
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
import { MessageAssembler } from "./messages.js";
import { matchesSubscription } from "./subscription.js";
import type {
  EventSubscription,
  EventForChannel,
  EventForChannels,
  MessageSubscription,
  ProtocolClientOptions,
  SessionModules,
  SessionOrderingState,
  SubscribeOptions,
  YieldForChannel,
  YieldForChannels,
} from "./types.js";
import type { AssembledMessage } from "./messages.js";
import type { TransportAdapter } from "./transport.js";

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
 * Error wrapper for protocol-level error responses returned by the server.
 */
export class ProtocolError extends Error {
  readonly code: ErrorResponse["error"];
  readonly response: ErrorResponse;

  constructor(response: ErrorResponse) {
    super(response.message);
    this.name = "ProtocolError";
    this.code = response.error;
    this.response = response;
  }
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

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ done: true, value: undefined });
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
        if (this.closed) {
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
 * Async iterable handle that assembles raw `messages` events into complete
 * `AssembledMessage` instances.
 */
export class MessageSubscriptionHandle
  implements AsyncIterable<AssembledMessage>, MessageSubscription
{
  readonly params: SubscribeParams;
  readonly subscriptionId: string;
  private readonly source: SubscriptionHandle<Event>;
  private readonly assembler = new MessageAssembler();
  private readonly queue: AssembledMessage[] = [];
  private readonly waiters: Array<
    (value: IteratorResult<AssembledMessage>) => void
  > = [];
  private sourcePump?: Promise<void>;
  private closed = false;

  constructor(source: SubscriptionHandle<Event>) {
    this.source = source;
    this.subscriptionId = source.subscriptionId;
    this.params = source.params;
  }

  private start(): void {
    if (this.sourcePump) {
      return;
    }
    this.sourcePump = (async () => {
      for await (const event of this.source) {
        if (event.method !== "messages") {
          continue;
        }
        const update = this.assembler.consume(event);
        if (
          update.kind === "message-finish" ||
          update.kind === "message-error"
        ) {
          const waiter = this.waiters.shift();
          if (waiter) {
            waiter({ done: false, value: update.message });
          } else {
            this.queue.push(update.message);
          }
        }
      }
      this.closed = true;
      while (this.waiters.length > 0) {
        this.waiters.shift()?.({ done: true, value: undefined });
      }
    })();
  }

  async unsubscribe(): Promise<void> {
    this.closed = true;
    await this.source.unsubscribe();
  }

  [Symbol.asyncIterator](): AsyncIterator<AssembledMessage> {
    this.start();
    return {
      next: async () => {
        if (this.queue.length > 0) {
          return { done: false, value: this.queue.shift()! };
        }
        if (this.closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<AssembledMessage>>(
          (resolve) => {
            this.waiters.push(resolve);
          }
        );
      },
      return: async () => {
        await this.unsubscribe();
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

  private nextCommandId: number;
  private readonly transportAdapter: TransportAdapter;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly buffer: EventBuffer;
  private readonly subscriptions = new Map<string, InternalEventSubscription>();
  private readonly activeFilters = new Map<string, SubscribeParams>();
  private closed = false;

  constructor(
    transportAdapter: TransportAdapter,
    sessionResult: SessionResult,
    options: ProtocolClientOptions = {}
  ) {
    this.transportAdapter = transportAdapter;
    this.sessionId = sessionResult.session_id;
    this.capabilities = sessionResult.capabilities;
    this.transport = sessionResult.transport;
    this.nextCommandId = options.startingCommandId ?? 1;
    this.buffer = new EventBuffer(options.eventBufferSize);
    this.run = {
      input: async (params) => await this.send("run.input", params),
    };
    this.agent = {
      getTree: async (params = {}) => await this.send("agent.getTree", params),
    };
    if (this.hasModule("resource")) {
      this.resource = {
        list: async (params) => await this.send("resource.list", params),
        read: async (params) => await this.send("resource.read", params),
        write: async (params) => {
          await this.send("resource.write", params);
        },
        download: async (params) =>
          await this.send("resource.download", params),
      };
    }
    if (this.hasModule("sandbox")) {
      this.sandbox = {
        input: async (params) => {
          await this.send("sandbox.input", params);
        },
        kill: async (params) => {
          await this.send("sandbox.kill", params);
        },
      };
    }
    if (this.hasModule("input")) {
      this.input = {
        respond: async (params) => {
          await this.send("input.respond", params);
        },
        inject: async (params) => {
          await this.send("input.inject", params);
        },
      };
    }
    if (this.hasModule("state")) {
      this.state = {
        get: async (params) => await this.send("state.get", params),
        listCheckpoints: async (params) =>
          await this.send("state.listCheckpoints", params),
        fork: async (params) => await this.send("state.fork", params),
      };
    }
    if (this.hasModule("usage")) {
      this.usage = {
        setBudget: async (params) => {
          await this.send("usage.setBudget", params);
        },
      };
    }
    void this.consumeEvents();
  }

  hasModule(name: string): boolean {
    return this.capabilities.modules.some((module) => module.name === name);
  }

  supportsChannel(channel: Channel): boolean {
    return this.capabilities.modules.some((module) =>
      (module.channels ?? []).includes(channel)
    );
  }

  supportsCommand(method: string): boolean {
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
    return await this.send("session.describe", {});
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.send("session.close", {});
    } finally {
      for (const subscription of this.subscriptions.values()) {
        subscription.close();
      }
      this.subscriptions.clear();
      await this.transportAdapter.close();
    }
  }

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
  ): Promise<SubscriptionHandle<Event, any>> {
    const params = normalizeSubscribeParams(paramsOrChannels, options);
    const hasOnlyNamedCustom =
      params.channels.length > 0 &&
      params.channels.every((ch) => ch.startsWith("custom:"));
    for (const channel of params.channels) {
      if (!channel.startsWith("custom:")) {
        this.assertSupportsChannel(channel);
      }
    }
    const result = await this.send("subscription.subscribe", params);
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
        this.activeFilters.delete(id);
        this.subscriptions.delete(id);
        if (!this.closed) {
          await this.send("subscription.unsubscribe", { subscription_id: id });
        }
      },
      transform
    );
    const subscription = Object.assign(handle, { filter: params });
    this.activeFilters.set(result.subscription_id, params);
    this.subscriptions.set(result.subscription_id, subscription);
    for (const buffered of this.buffer.replay(params)) {
      handle.push(buffered);
    }
    return handle;
  }

  async subscribeMessages(
    params: SubscribeOptions = {}
  ): Promise<MessageSubscriptionHandle> {
    const eventSubscription = await this.subscribe({
      ...params,
      channels: ["messages"],
    });
    return new MessageSubscriptionHandle(eventSubscription);
  }

  async reconnect(params: ReconnectParams): Promise<ReconnectResult> {
    const result = await this.send("subscription.reconnect", params);
    if (result.restored) {
      for (const [id, filter] of this.activeFilters) {
        if (params.subscriptions && !params.subscriptions.includes(id)) {
          continue;
        }
        for (const event of this.buffer.replay(filter, params.last_event_id)) {
          this.subscriptions.get(id)?.push(event);
        }
      }
    }
    return result;
  }

  private async consumeEvents(): Promise<void> {
    try {
      for await (const message of this.transportAdapter.events()) {
        this.handleIncoming(message);
      }
    } catch (error) {
      const normalized =
        // oxlint-disable-next-line no-instanceof/no-instanceof
        error instanceof Error ? error : new Error(String(error));
      for (const pending of this.pending.values()) {
        pending.reject(normalized);
      }
      for (const subscription of this.subscriptions.values()) {
        subscription.close();
      }
      this.pending.clear();
    }
  }

  private handleIncoming(message: Message): void {
    if (message.type === "event") {
      this.buffer.push(message);
      if (typeof message.seq === "number") {
        this.ordering.lastSeenSeq = message.seq;
      }
      if (message.event_id) {
        this.ordering.lastEventId = message.event_id;
      }
      for (const subscription of this.subscriptions.values()) {
        if (matchesSubscription(message, subscription.filter)) {
          subscription.push(message);
        }
      }
      return;
    }

    const messageId = typeof message.id === "number" ? message.id : undefined;
    const pending =
      messageId === undefined ? undefined : this.pending.get(messageId);
    if (!pending) {
      return;
    }
    if (messageId !== undefined) {
      this.pending.delete(messageId);
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

  private async send<TMethod extends keyof CommandResultMap>(
    method: TMethod,
    params: CommandParamsMap[TMethod]
  ): Promise<CommandResultMap[TMethod]> {
    if (method !== "session.describe" && method !== "session.close") {
      this.assertSupportsCommand(method);
    }
    const id = this.nextCommandId++;
    const command = {
      id,
      method,
      params,
    } as Command;
    const responsePromise = new Promise<CommandResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const immediate = await this.transportAdapter.send(command);
    if (immediate) {
      this.pending.delete(id);
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
    return new Session(transport, response, this.options);
  }
}

export { EventBuffer } from "./buffer.js";
export { MessageAssembler } from "./messages.js";
export type { AssembledMessage, MessageAssemblyUpdate } from "./messages.js";
export { inferChannel, matchesSubscription } from "./subscription.js";
export type { TransportAdapter } from "./transport.js";
export type * from "./types.js";
