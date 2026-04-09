import type {
  AgentResult,
  CapabilityAdvertisement,
  Channel,
  Command,
  CommandData,
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
  StorePutParams,
  StoreSearchParams,
  StoreSearchResult,
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
  MessageSubscription,
  ProtocolClientOptions,
  SessionModules,
  SessionOrderingState,
} from "./types.js";
import type { AssembledMessage } from "./messages.js";
import type { TransportAdapter } from "./transport.js";

type PendingCommand = {
  resolve: (response: CommandResponse) => void;
  reject: (error: Error) => void;
};

type CommandMethod = CommandData["method"];

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
  "state.storeSearch": StoreSearchResult;
  "state.storePut": Record<string, unknown>;
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
  "subscription.unsubscribe": { subscriptionId: string };
  "subscription.reconnect": ReconnectParams;
  "agent.getTree": { runId?: string };
  "resource.list": ResourceListParams;
  "resource.read": ResourceReadParams;
  "resource.write": ResourceWriteParams;
  "resource.download": ResourceDownloadParams;
  "sandbox.input": SandboxInputParams;
  "sandbox.kill": SandboxKillParams;
  "input.respond": InputRespondParams;
  "input.inject": InputInjectParams;
  "state.get": StateGetParams;
  "state.storeSearch": StoreSearchParams;
  "state.storePut": StorePutParams;
  "state.listCheckpoints": ListCheckpointsParams;
  "state.fork": StateForkParams;
  "usage.setBudget": UsageBudgetParams;
};

type InternalEventSubscription = EventSubscription<Event> & {
  filter: SubscribeParams;
  push(event: Event): void;
  close(): void;
};

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

export class SubscriptionHandle<TEvent extends Event = Event>
  implements AsyncIterable<TEvent>, EventSubscription<TEvent>
{
  readonly subscriptionId: string;
  readonly params: SubscribeParams;
  private readonly queue: TEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<TEvent>) => void> = [];
  private closed = false;
  private readonly onUnsubscribe: (id: string) => Promise<void>;

  constructor(
    subscriptionId: string,
    params: SubscribeParams,
    onUnsubscribe: (id: string) => Promise<void>,
  ) {
    this.subscriptionId = subscriptionId;
    this.params = params;
    this.onUnsubscribe = onUnsubscribe;
  }

  push(event: TEvent): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    this.queue.push(event);
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

  [Symbol.asyncIterator](): AsyncIterator<TEvent> {
    return {
      next: async () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return { done: false, value };
        }
        if (this.closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<TEvent>>((resolve) => {
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

export class MessageSubscriptionHandle
  implements AsyncIterable<AssembledMessage>, MessageSubscription
{
  readonly params: SubscribeParams;
  readonly subscriptionId: string;
  private readonly source: SubscriptionHandle<Event>;
  private readonly assembler = new MessageAssembler();
  private readonly queue: AssembledMessage[] = [];
  private readonly waiters: Array<(value: IteratorResult<AssembledMessage>) => void> = [];
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
        if (update.kind === "message-finish" || update.kind === "message-error") {
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
        return await new Promise<IteratorResult<AssembledMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async () => {
        await this.unsubscribe();
        return { done: true, value: undefined };
      },
    };
  }
}

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
  private readonly eventLoop: Promise<void>;
  private closed = false;

  constructor(
    transportAdapter: TransportAdapter,
    sessionResult: SessionResult,
    options: ProtocolClientOptions = {},
  ) {
    this.transportAdapter = transportAdapter;
    this.sessionId = sessionResult.sessionId;
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
        download: async (params) => await this.send("resource.download", params),
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
        storeSearch: async (params) => await this.send("state.storeSearch", params),
        storePut: async (params) => {
          await this.send("state.storePut", params);
        },
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
    this.eventLoop = this.consumeEvents();
  }

  hasModule(name: string): boolean {
    return this.capabilities.modules.some((module) => module.name === name);
  }

  supportsChannel(channel: Channel): boolean {
    return this.capabilities.modules.some((module) =>
      (module.channels ?? []).includes(channel),
    );
  }

  supportsCommand(method: string): boolean {
    const [moduleName, commandName] = method.split(".");
    return this.capabilities.modules.some(
      (module) =>
        module.name === moduleName &&
        ((module.commands ?? []).includes(method) ||
          (module.commands ?? []).includes(commandName ?? "")),
    );
  }

  assertSupportsChannel(channel: Channel): void {
    if (!this.supportsChannel(channel)) {
      throw new Error(`Channel "${channel}" is not advertised by the session capabilities`);
    }
  }

  assertSupportsCommand(method: string): void {
    if (!this.supportsCommand(method)) {
      throw new Error(`Command "${method}" is not advertised by the session capabilities`);
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

  async subscribe(params: SubscribeParams): Promise<SubscriptionHandle<Event>> {
    for (const channel of params.channels) {
      this.assertSupportsChannel(channel);
    }
    const result = await this.send("subscription.subscribe", params);
    const handle = new SubscriptionHandle<Event>(
      result.subscriptionId,
      params,
      async (id) => {
        this.activeFilters.delete(id);
        this.subscriptions.delete(id);
        if (!this.closed) {
          await this.send("subscription.unsubscribe", { subscriptionId: id });
        }
      },
    );
    const subscription = Object.assign(handle, { filter: params });
    this.activeFilters.set(result.subscriptionId, params);
    this.subscriptions.set(result.subscriptionId, subscription);
    for (const buffered of this.buffer.replay(params)) {
      handle.push(buffered);
    }
    return handle;
  }

  async subscribeMessages(
    params: Omit<SubscribeParams, "channels"> = {},
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
        for (const event of this.buffer.replay(filter, params.lastEventId)) {
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
      const normalized = error instanceof Error ? error : new Error(String(error));
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
      if (message.eventId) {
        this.ordering.lastEventId = message.eventId;
      }
      for (const subscription of this.subscriptions.values()) {
        if (matchesSubscription(message, subscription.filter)) {
          subscription.push(message);
        }
      }
      return;
    }

    const messageId = typeof message.id === "number" ? message.id : undefined;
    const pending = messageId === undefined ? undefined : this.pending.get(messageId);
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
    if (typeof message.meta?.appliedThroughSeq === "number") {
      this.ordering.lastAppliedThroughSeq = message.meta.appliedThroughSeq;
    }
    pending.resolve(message);
  }

  private async send<TMethod extends keyof CommandResultMap>(
    method: TMethod,
    params: CommandParamsMap[TMethod],
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
      if (typeof immediate.meta?.appliedThroughSeq === "number") {
        this.ordering.lastAppliedThroughSeq = immediate.meta.appliedThroughSeq;
      }
      return immediate.result as CommandResultMap[TMethod];
    }
    const response = await responsePromise;
    return response.result as CommandResultMap[TMethod];
  }
}

export class ProtocolClient {
  private readonly transportFactory:
    | TransportAdapter
    | (() => TransportAdapter | Promise<TransportAdapter>);
  private readonly options: ProtocolClientOptions;

  constructor(
    transportFactory: TransportAdapter | (() => TransportAdapter | Promise<TransportAdapter>),
    options: ProtocolClientOptions = {},
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
