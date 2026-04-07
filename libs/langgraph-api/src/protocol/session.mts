import { v7 as uuid7 } from "uuid";

import type { AuthContext } from "../auth/index.mjs";
import type { Run } from "../storage/types.mjs";
import type { ProtocolCommand, ProtocolError, ProtocolResponseMeta, ProtocolSuccess } from "./types.mjs";
import { serialiseAsDict, serializeError } from "../utils/serde.mjs";

type SupportedChannel =
  | "values"
  | "updates"
  | "messages"
  | "tools"
  | "custom"
  | "lifecycle"
  | "debug"
  | "checkpoints"
  | "tasks";

type AgentStatus =
  | "spawned"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

type ErrorCode =
  | "invalid_argument"
  | "unknown_command"
  | "unknown_error"
  | "no_such_run"
  | "no_such_subscription"
  | "not_supported";

type SourceStreamEvent = {
  id?: string;
  event: string;
  data: unknown;
};

type ProtocolEvent = {
  type: "event";
  eventId: string;
  seq: number;
  method: SupportedChannel;
  params: {
    namespace: string[];
    timestamp: number;
    data: unknown;
    node?: string;
  };
};

type Subscription = {
  id: string;
  channels: Set<SupportedChannel>;
  namespaces?: string[][];
  depth?: number;
  active: boolean;
};

type NamespaceInfo = {
  namespace: string[];
  status: AgentStatus;
  graphName: string;
};

type MessageState = {
  metadata?: unknown;
  started: boolean;
  lastText: string;
  finished: boolean;
};

const SUPPORTED_CHANNELS = new Set<SupportedChannel>([
  "values",
  "updates",
  "messages",
  "tools",
  "custom",
  "lifecycle",
  "debug",
  "checkpoints",
  "tasks",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const toNamespaceKey = (namespace: string[]) => namespace.join("\0");

const normalizeNamespaceSegment = (segment: string) => segment.split(":")[0];

const normalizeNamespace = (namespace: string[]) =>
  namespace.map(normalizeNamespaceSegment);

const parseEventName = (event: string) => {
  const [method, ...namespace] = event.split("|");
  return { method, namespace };
};

const isPrefixMatch = (namespace: string[], prefix: string[]) => {
  if (prefix.length > namespace.length) return false;
  return prefix.every((segment, index) => namespace[index] === segment);
};

const guessGraphName = (namespace: string[]) => {
  const last = namespace.at(-1);
  if (last == null) return "root";
  return normalizeNamespaceSegment(last);
};

const safeStringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const extractErrorMessage = (value: unknown) => {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return safeStringify(value);
};

const extractTextContent = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (
          isRecord(item) &&
          item.type === "text" &&
          typeof item.text === "string"
        ) {
          return item.text;
        }
        return undefined;
      })
      .filter((part): part is string => part != null);
    if (parts.length > 0) return parts.join("");
  }
  return undefined;
};

const toLifecycleStatus = (status: Run["status"]): AgentStatus => {
  if (status === "success") return "completed";
  if (status === "error") return "failed";
  if (status === "interrupted") return "interrupted";
  return "running";
};

const normalizeUpdatesData = (
  value: unknown
): { node?: string; values: unknown } => {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [node, nodeValues] = entries[0];
      return { node, values: nodeValues };
    }
  }
  return { values: value };
};

const normalizeToolData = (value: unknown) => {
  if (!isRecord(value) || typeof value.event !== "string") {
    return {
      event: "tool-output-delta",
      delta: extractErrorMessage(value),
    };
  }

  switch (value.event) {
    case "on_tool_start":
      return {
        event: "tool-started",
        toolCallId:
          typeof value.toolCallId === "string" ? value.toolCallId : undefined,
        toolName: typeof value.name === "string" ? value.name : "tool",
        input: value.input,
      };
    case "on_tool_event":
      return {
        event: "tool-output-delta",
        toolCallId:
          typeof value.toolCallId === "string" ? value.toolCallId : undefined,
        delta:
          typeof value.data === "string"
            ? value.data
            : safeStringify(value.data ?? null),
      };
    case "on_tool_end":
      return {
        event: "tool-finished",
        toolCallId:
          typeof value.toolCallId === "string" ? value.toolCallId : undefined,
        output: value.output,
      };
    case "on_tool_error":
      return {
        event: "tool-error",
        toolCallId:
          typeof value.toolCallId === "string" ? value.toolCallId : undefined,
        message: extractErrorMessage(value.error),
      };
    default:
      return {
        event: "tool-output-delta",
        toolCallId:
          typeof value.toolCallId === "string" ? value.toolCallId : undefined,
        delta: safeStringify(value),
      };
  }
};

const normalizeDebugData = (value: unknown) => {
  if (
    isRecord(value) &&
    typeof value.step === "number" &&
    typeof value.type === "string"
  ) {
    return {
      step: value.step,
      type: value.type,
      payload: value.payload,
    };
  }
  return value;
};

/**
 * Normalizes one LangGraph run into protocol events and manages per-run
 * subscriptions, buffering, and replay.
 *
 * This class is transport-agnostic: callers provide a `send()` function and an
 * optional source stream, and the session handles command processing plus event
 * fan-out for both direct run-scoped sockets and the shared `v2` session
 * service.
 */
export class RunProtocolSession {
  private readonly initialRun: Run;

  private readonly getRun: () => Promise<Run | null>;

  private readonly send: (payload: string) => Promise<void> | void;

  private readonly source?: AsyncIterable<SourceStreamEvent>;

  private readonly subscriptions = new Map<string, Subscription>();

  private readonly namespaces = new Map<string, NamespaceInfo>();

  private readonly messageState = new Map<string, MessageState>();

  private readonly abortController = new AbortController();

  private readonly buffer: ProtocolEvent[] = [];

  private sendQueue = Promise.resolve();

  private sourceTask?: Promise<void>;

  private nextSeq = 0;

  private maxBufferSize = 1000;

  private rootGraphName = "root";

  private terminalLifecycleEmitted = false;

  constructor(options: {
    runId: string;
    threadId?: string;
    auth?: AuthContext;
    initialRun: Run;
    getRun: () => Promise<Run | null>;
    send: (payload: string) => Promise<void> | void;
    source?: AsyncIterable<SourceStreamEvent>;
  }) {
    this.initialRun = options.initialRun;
    this.getRun = options.getRun;
    this.send = options.send;
    this.source = options.source;
  }

  /**
   * Start consuming the bound run source and emit the initial root lifecycle
   * state into the protocol buffer.
   */
  async start() {
    this.rootGraphName =
      typeof this.initialRun.kwargs.config?.configurable?.graph_id === "string"
        ? this.initialRun.kwargs.config.configurable.graph_id
        : this.initialRun.assistant_id;

    this.setNamespaceInfo([], toLifecycleStatus(this.initialRun.status), {
      graphName: this.rootGraphName,
    });
    await this.pushEvent(
      this.createEvent("lifecycle", [], {
        event: toLifecycleStatus(this.initialRun.status),
        graphName: this.rootGraphName,
      })
    );

    if (this.source != null) {
      this.sourceTask = this.consumeSource();
    }
  }

  /**
   * Stop consuming the run source and wait for queued transport writes to
   * settle.
   */
  async close() {
    this.abortController.abort();
    await this.sourceTask?.catch(() => undefined);
    await this.sendQueue.catch(() => undefined);
  }

  /**
   * Parse and handle a raw JSON command coming directly from a run-scoped
   * transport.
   */
  async handleCommand(rawPayload: string) {
    let payload: unknown;
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      await this.sendError(
        null,
        "invalid_argument",
        "Protocol commands must be valid JSON."
      );
      return;
    }

    if (
      !isRecord(payload) ||
      typeof payload.id !== "number" ||
      !Number.isInteger(payload.id) ||
      payload.id < 0 ||
      typeof payload.method !== "string"
    ) {
      await this.sendError(
        null,
        "invalid_argument",
        "Protocol commands must include an integer id and string method."
      );
      return;
    }

    const command = payload as ProtocolCommand;

    try {
      switch (command.method) {
        case "subscription.subscribe":
          await this.handleSubscribe(command);
          return;
        case "subscription.unsubscribe":
          await this.handleUnsubscribe(command);
          return;
        case "agent.getTree":
          await this.sendSuccess(command.id, {
            tree: this.buildTree([]),
          });
          return;
        case "flow.setCapacity":
          await this.handleSetCapacity(command);
          return;
        case "subscription.reconnect":
          await this.sendError(
            command.id,
            "not_supported",
            "subscription.reconnect is not supported by this server yet."
          );
          return;
        default:
          await this.sendError(
            command.id,
            "unknown_command",
            `Unknown protocol command: ${command.method}`
          );
      }
    } catch (error) {
      await this.sendError(
        command.id,
        "unknown_error",
        error instanceof Error ? error.message : "Unknown protocol error",
        error instanceof Error ? error.stack : undefined
      );
    }
  }

  /**
   * Handle a structured protocol command and return a typed response instead of
   * writing directly to the transport.
   */
  async handleProtocolCommand(
    command: ProtocolCommand,
    meta?: ProtocolResponseMeta
  ): Promise<ProtocolSuccess | ProtocolError> {
    try {
      switch (command.method) {
        case "subscription.subscribe":
          return await this.handleSubscribeForResponse(command, meta);
        case "subscription.unsubscribe":
          return await this.handleUnsubscribeForResponse(command, meta);
        case "agent.getTree":
          return this.success(command.id, { tree: this.buildTree([]) }, meta);
        case "flow.setCapacity":
          return await this.handleSetCapacityForResponse(command, meta);
        case "subscription.reconnect":
          return this.error(
            command.id,
            "not_supported",
            "subscription.reconnect is not supported by this server yet.",
            meta
          );
        default:
          return this.error(
            command.id,
            "unknown_command",
            `Unknown protocol command: ${command.method}`,
            meta
          );
      }
    } catch (error) {
      return this.error(
        command.id,
        "unknown_error",
        error instanceof Error ? error.message : "Unknown protocol error",
        meta,
        error instanceof Error ? error.stack : undefined
      );
    }
  }

  /**
   * Inject a raw run stream event into the protocol session. This is primarily
   * used by tests and by higher-level services that already own the event loop.
   */
  async ingestSourceEvent(event: SourceStreamEvent) {
    await this.handleSourceEvent(event);
  }

  private async consumeSource() {
    try {
      for await (const event of this.source ?? []) {
        if (this.abortController.signal.aborted) break;
        await this.handleSourceEvent(event);
      }
    } catch (error) {
      await this.sendError(
        null,
        "unknown_error",
        error instanceof Error ? error.message : "Failed to consume run stream.",
        error instanceof Error ? error.stack : undefined
      );
    } finally {
      await this.emitTerminalLifecycle();
    }
  }

  private async emitTerminalLifecycle() {
    if (this.terminalLifecycleEmitted) return;
    const currentRun = await this.getRun();
    if (currentRun == null) {
      this.terminalLifecycleEmitted = true;
      return;
    }

    const status = toLifecycleStatus(currentRun.status);
    if (status === "running") return;

    this.terminalLifecycleEmitted = true;
    this.setNamespaceInfo([], status, { graphName: this.rootGraphName });
    await this.pushEvent(
      this.createEvent("lifecycle", [], {
        event: status,
        graphName: this.rootGraphName,
      })
    );
  }

  private async handleSourceEvent(event: SourceStreamEvent) {
    if (event.event === "metadata") return;

    if (event.event === "error") {
      this.terminalLifecycleEmitted = true;
      this.setNamespaceInfo([], "failed", { graphName: this.rootGraphName });
      await this.pushEvent(
        this.createEvent("lifecycle", [], {
          event: "failed",
          graphName: this.rootGraphName,
          error: serializeError(event.data).message,
        })
      );
      return;
    }

    const { method, namespace: rawNamespace } = parseEventName(event.event);
    const namespace = normalizeNamespace(rawNamespace);
    const timestamp = Date.now();

    if (method !== "messages") {
      await this.ensureNamespaces(namespace);
    }

    switch (method) {
      case "values":
        await this.pushEvent(this.createEvent("values", namespace, event.data));
        return;
      case "updates": {
        const normalized = normalizeUpdatesData(event.data);
        await this.pushEvent(
          this.createEvent("updates", namespace, normalized.values, normalized.node)
        );
        return;
      }
      case "custom":
        await this.pushEvent(
          this.createEvent("custom", namespace, { payload: event.data }, undefined)
        );
        return;
      case "debug":
        await this.pushEvent(
          this.createEvent("debug", namespace, normalizeDebugData(event.data))
        );
        return;
      case "tasks":
        await this.pushEvent(this.createEvent("tasks", namespace, event.data));
        return;
      case "checkpoints":
        await this.pushEvent(
          this.createEvent("checkpoints", namespace, event.data)
        );
        return;
      case "tools":
        await this.pushEvent(
          this.createEvent("tools", namespace, normalizeToolData(event.data))
        );
        return;
      case "messages/metadata":
      case "messages/partial":
      case "messages/complete":
        await this.normalizeLegacyMessageEvent(
          method,
          namespace,
          event.data,
          timestamp
        );
        return;
      default:
        return;
    }
  }

  private async normalizeLegacyMessageEvent(
    method: string,
    namespace: string[],
    data: unknown,
    timestamp: number
  ) {
    if (method === "messages/metadata") {
      if (!isRecord(data)) return;
      for (const [messageId, value] of Object.entries(data)) {
        const state = this.messageState.get(messageId) ?? {
          started: false,
          lastText: "",
          finished: false,
        };
        state.metadata = isRecord(value) ? value.metadata : undefined;
        this.messageState.set(messageId, state);
      }
      return;
    }

    if (!Array.isArray(data)) return;

    for (const rawMessage of data) {
      if (!isRecord(rawMessage) || typeof rawMessage.id !== "string") continue;

      const messageId = rawMessage.id;
      const text = extractTextContent(rawMessage.content);
      const state = this.messageState.get(messageId) ?? {
        started: false,
        lastText: "",
        finished: false,
      };

      if (!state.started) {
        await this.pushEvent(
          this.createEvent("messages", namespace, {
            event: "message-start",
            messageId,
            metadata: state.metadata,
          })
        );
        await this.pushEvent(
          this.createEvent("messages", namespace, {
            event: "content-block-start",
            index: 0,
            contentBlock: { type: "text", text: "" },
          })
        );
        state.started = true;
      }

      const previousText = state.lastText;
      if (typeof text === "string" && text.length >= previousText.length) {
        const delta = text.slice(previousText.length);
        if (delta.length > 0) {
          await this.pushEvent(
            this.createEvent("messages", namespace, {
              event: "content-block-delta",
              index: 0,
              contentBlock: { type: "text", text: delta },
            })
          );
        }
        state.lastText = text;
      }

      if (method === "messages/complete" && !state.finished) {
        await this.pushEvent(
          this.createEvent("messages", namespace, {
            event: "content-block-finish",
            index: 0,
            contentBlock: { type: "text", text: state.lastText },
          })
        );
        await this.pushEvent(
          this.createEvent("messages", namespace, {
            event: "message-finish",
            reason: "stop",
          })
        );
        state.finished = true;
      }

      this.messageState.set(messageId, state);
    }
  }

  private async ensureNamespaces(namespace: string[]) {
    for (let length = 1; length <= namespace.length; length += 1) {
      const partial = namespace.slice(0, length);
      const key = toNamespaceKey(partial);
      if (this.namespaces.has(key)) continue;

      const graphName = guessGraphName(partial);
      this.setNamespaceInfo(partial, "spawned", { graphName });
      await this.pushEvent(
        this.createEvent("lifecycle", partial, {
          event: "spawned",
          graphName,
        })
      );
    }
  }

  private setNamespaceInfo(
    namespace: string[],
    status: AgentStatus,
    options?: { graphName?: string }
  ) {
    const key = toNamespaceKey(namespace);
    const existing = this.namespaces.get(key);
    this.namespaces.set(key, {
      namespace,
      status,
      graphName:
        options?.graphName ??
        existing?.graphName ??
        (namespace.length === 0 ? this.rootGraphName : guessGraphName(namespace)),
    });
  }

  private createEvent(
    method: SupportedChannel,
    namespace: string[],
    data: unknown,
    node?: string
  ): ProtocolEvent {
    this.nextSeq += 1;
    return {
      type: "event",
      eventId: String(this.nextSeq),
      seq: this.nextSeq,
      method,
      params: {
        namespace,
        timestamp: Date.now(),
        ...(node != null ? { node } : {}),
        data,
      },
    };
  }

  private async pushEvent(event: ProtocolEvent) {
    this.buffer.push(event);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferSize);
    }

    for (const subscription of this.subscriptions.values()) {
      if (!subscription.active || !this.matchesSubscription(subscription, event)) {
        continue;
      }
      await this.sendJson(event);
    }
  }

  private matchesSubscription(
    subscription: Subscription,
    event: ProtocolEvent
  ): boolean {
    if (!subscription.channels.has(event.method)) return false;

    if (subscription.namespaces == null || subscription.namespaces.length === 0) {
      return true;
    }

    return subscription.namespaces.some((prefix) => {
      if (!isPrefixMatch(event.params.namespace, prefix)) return false;
      if (subscription.depth == null) return true;
      return event.params.namespace.length - prefix.length <= subscription.depth;
    });
  }

  private buildTree(namespace: string[]): Record<string, unknown> {
    const key = toNamespaceKey(namespace);
    const current =
      this.namespaces.get(key) ??
      ({
        namespace,
        status: "spawned",
        graphName:
          namespace.length === 0 ? this.rootGraphName : guessGraphName(namespace),
      } satisfies NamespaceInfo);

    const children = [...this.namespaces.values()]
      .filter((candidate) => {
        if (candidate.namespace.length !== namespace.length + 1) return false;
        return isPrefixMatch(candidate.namespace, namespace);
      })
      .sort((left, right) =>
        safeStringify(left.namespace).localeCompare(safeStringify(right.namespace))
      )
      .map((child) => this.buildTree(child.namespace));

    return {
      namespace: current.namespace,
      status: current.status,
      graphName: current.graphName,
      ...(children.length > 0 ? { children } : {}),
    };
  }

  private async handleSubscribe(command: ProtocolCommand) {
    const params = isRecord(command.params) ? command.params : undefined;
    const rawChannels = params?.channels;
    if (!Array.isArray(rawChannels) || rawChannels.length === 0) {
      await this.sendError(
        command.id,
        "invalid_argument",
        "subscription.subscribe requires a non-empty channels array."
      );
      return;
    }

    const channels = rawChannels.filter(
      (value): value is SupportedChannel =>
        typeof value === "string" && SUPPORTED_CHANNELS.has(value as SupportedChannel)
    );

    if (channels.length !== rawChannels.length) {
      await this.sendError(
        command.id,
        "invalid_argument",
        "subscription.subscribe received an unsupported channel."
      );
      return;
    }

    const namespaces =
      Array.isArray(params?.namespaces) &&
      params.namespaces.every(
        (value) =>
          Array.isArray(value) &&
          value.every((segment) => typeof segment === "string")
      )
        ? (params.namespaces as string[][])
        : undefined;

    const depth =
      typeof params?.depth === "number" &&
      Number.isInteger(params.depth) &&
      params.depth >= 0
        ? params.depth
        : undefined;

    const subscription: Subscription = {
      id: uuid7(),
      channels: new Set(channels),
      namespaces,
      depth,
      active: false,
    };

    this.subscriptions.set(subscription.id, subscription);

    const snapshotSeq = this.nextSeq;
    const snapshot = this.buffer.filter(
      (event) =>
        event.seq <= snapshotSeq && this.matchesSubscription(subscription, event)
    );

    await this.sendSuccess(command.id, {
      subscriptionId: subscription.id,
      replayedEvents: snapshot.length,
    });

    for (const event of snapshot) {
      await this.sendJson(event);
    }

    let cursor = snapshotSeq;
    while (true) {
      const drain = this.buffer.filter(
        (event) =>
          event.seq > cursor && this.matchesSubscription(subscription, event)
      );
      if (drain.length === 0) break;
      for (const event of drain) {
        await this.sendJson(event);
      }
      cursor = drain.at(-1)?.seq ?? cursor;
    }

    subscription.active = true;
  }

  private async handleSubscribeForResponse(
    command: ProtocolCommand,
    meta?: ProtocolResponseMeta
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = isRecord(command.params) ? command.params : undefined;
    const rawChannels = params?.channels;
    if (!Array.isArray(rawChannels) || rawChannels.length === 0) {
      return this.error(
        command.id,
        "invalid_argument",
        "subscription.subscribe requires a non-empty channels array.",
        meta
      );
    }

    const channels = rawChannels.filter(
      (value): value is SupportedChannel =>
        typeof value === "string" && SUPPORTED_CHANNELS.has(value as SupportedChannel)
    );

    if (channels.length !== rawChannels.length) {
      return this.error(
        command.id,
        "invalid_argument",
        "subscription.subscribe received an unsupported channel.",
        meta
      );
    }

    const namespaces =
      Array.isArray(params?.namespaces) &&
      params.namespaces.every(
        (value) =>
          Array.isArray(value) &&
          value.every((segment) => typeof segment === "string")
      )
        ? (params.namespaces as string[][])
        : undefined;

    const depth =
      typeof params?.depth === "number" &&
      Number.isInteger(params.depth) &&
      params.depth >= 0
        ? params.depth
        : undefined;

    const subscription: Subscription = {
      id: uuid7(),
      channels: new Set(channels),
      namespaces,
      depth,
      active: false,
    };

    this.subscriptions.set(subscription.id, subscription);

    const snapshotSeq = this.nextSeq;
    const snapshot = this.buffer.filter(
      (event) =>
        event.seq <= snapshotSeq && this.matchesSubscription(subscription, event)
    );

    for (const event of snapshot) {
      await this.sendJson(event);
    }

    let cursor = snapshotSeq;
    while (true) {
      const drain = this.buffer.filter(
        (event) =>
          event.seq > cursor && this.matchesSubscription(subscription, event)
      );
      if (drain.length === 0) break;
      for (const event of drain) {
        await this.sendJson(event);
      }
      cursor = drain.at(-1)?.seq ?? cursor;
    }

    subscription.active = true;
    return this.success(
      command.id,
      {
        subscriptionId: subscription.id,
        replayedEvents: snapshot.length,
      },
      meta
    );
  }

  private async handleUnsubscribe(command: ProtocolCommand) {
    const params = isRecord(command.params) ? command.params : undefined;
    const subscriptionId = params?.subscriptionId;
    if (typeof subscriptionId !== "string") {
      await this.sendError(
        command.id,
        "invalid_argument",
        "subscription.unsubscribe requires a subscriptionId."
      );
      return;
    }

    if (!this.subscriptions.delete(subscriptionId)) {
      await this.sendError(
        command.id,
        "no_such_subscription",
        `Unknown subscription: ${subscriptionId}`
      );
      return;
    }

    await this.sendSuccess(command.id, {});
  }

  private async handleUnsubscribeForResponse(
    command: ProtocolCommand,
    meta?: ProtocolResponseMeta
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = isRecord(command.params) ? command.params : undefined;
    const subscriptionId = params?.subscriptionId;
    if (typeof subscriptionId !== "string") {
      return this.error(
        command.id,
        "invalid_argument",
        "subscription.unsubscribe requires a subscriptionId.",
        meta
      );
    }

    if (!this.subscriptions.delete(subscriptionId)) {
      return this.error(
        command.id,
        "no_such_subscription",
        `Unknown subscription: ${subscriptionId}`,
        meta
      );
    }

    return this.success(command.id, {}, meta);
  }

  private async handleSetCapacity(command: ProtocolCommand) {
    const params = isRecord(command.params) ? command.params : undefined;
    const maxBufferSize = params?.maxBufferSize;
    if (
      typeof maxBufferSize !== "number" ||
      !Number.isInteger(maxBufferSize) ||
      maxBufferSize < 1
    ) {
      await this.sendError(
        command.id,
        "invalid_argument",
        "flow.setCapacity requires maxBufferSize to be a positive integer."
      );
      return;
    }

    this.maxBufferSize = maxBufferSize;
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferSize);
    }

    await this.sendSuccess(command.id, {});
  }

  private async handleSetCapacityForResponse(
    command: ProtocolCommand,
    meta?: ProtocolResponseMeta
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = isRecord(command.params) ? command.params : undefined;
    const maxBufferSize = params?.maxBufferSize;
    if (
      typeof maxBufferSize !== "number" ||
      !Number.isInteger(maxBufferSize) ||
      maxBufferSize < 1
    ) {
      return this.error(
        command.id,
        "invalid_argument",
        "flow.setCapacity requires maxBufferSize to be a positive integer.",
        meta
      );
    }

    this.maxBufferSize = maxBufferSize;
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferSize);
    }

    return this.success(command.id, {}, meta);
  }

  private async sendSuccess(id: number, result: Record<string, unknown>) {
    await this.sendJson({
      type: "success",
      id,
      result,
    } satisfies ProtocolSuccess);
  }

  private async sendError(
    id: number | null,
    error: ErrorCode,
    message: string,
    stacktrace?: string
  ) {
    await this.sendJson({
      type: "error",
      id,
      error,
      message,
      ...(stacktrace != null ? { stacktrace } : {}),
    } satisfies ProtocolError);
  }

  private async sendJson(message: ProtocolEvent | ProtocolSuccess | ProtocolError) {
    this.sendQueue = this.sendQueue
      .then(() => this.send(serialiseAsDict(message)))
      .catch(() => undefined);
    await this.sendQueue;
  }

  private success(
    id: number,
    result: Record<string, unknown>,
    meta?: ProtocolResponseMeta
  ): ProtocolSuccess {
    return {
      type: "success",
      id,
      result,
      ...(meta != null ? { meta } : {}),
    };
  }

  private error(
    id: number | null,
    error: ErrorCode,
    message: string,
    meta?: ProtocolResponseMeta,
    stacktrace?: string
  ): ProtocolError {
    return {
      type: "error",
      id,
      error,
      message,
      ...(stacktrace != null ? { stacktrace } : {}),
      ...(meta != null ? { meta } : {}),
    };
  }
}

