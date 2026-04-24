import { v7 as uuid7 } from "uuid";

import type { AuthContext } from "../../auth/index.mjs";
import type { Run } from "../../storage/types.mjs";
import { serialiseAsDict, serializeError } from "../../utils/serde.mjs";
import type {
  AgentResult,
  AgentTreeNode,
  CustomData,
  FlowStrategy,
  LifecycleCause,
  Namespace,
  ProtocolCommand,
  ProtocolCommandByMethod,
  ProtocolError,
  ProtocolEvent,
  ProtocolEventByMethod,
  ProtocolResponseMeta,
  ProtocolSuccess,
  SourceStreamEvent,
  SubscribeParams,
  SubscribeResult,
  SupportedChannel,
  UnsubscribeParams,
} from "../types.mjs";
import {
  normalizeInputRequestedData,
  normalizeToolData,
  normalizeUpdatesData,
  stripInterruptsFromValues,
  toLifecycleStatus,
} from "./event-normalizers.mjs";
import type {
  NamespaceInfo,
  ProtocolEventDataMap,
  Subscription,
  SubscriptionChannel,
} from "./internal-types.mjs";
import {
  SUPPORTED_CHANNELS,
  isRecord,
  isSupportedChannel,
} from "./internal-types.mjs";
import { SessionMessageProcessor } from "./message-processor.mjs";
import {
  guessGraphName,
  isPrefixMatch,
  normalizeNamespace,
  parseEventName,
  toNamespaceKey,
} from "./namespace.mjs";
import { normalizeProtocolStatePayload } from "./state-normalizers.mjs";
import { isMessageTuplePayload } from "./tool-calls.mjs";

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

  private readonly getThreadState?:
    | (() => Promise<{
        tasks?: Array<{ interrupts?: unknown[] }>;
      } | null>)
    | undefined;

  private readonly send: (payload: string) => Promise<void> | void;

  private readonly source?: AsyncIterable<SourceStreamEvent>;

  private readonly subscriptions = new Map<string, Subscription>();

  private readonly namespaces = new Map<string, NamespaceInfo>();

  /**
   * Per-namespace `cause` learned from upstream `lifecycle.started` events
   * — populated by product-specific stream transformers (e.g. deepagents'
   * `SubagentTransformer`). Read when synthesizing the wire
   * `lifecycle.started` in {@link RunProtocolSession.ensureNamespaces}.
   *
   * The session itself is product-agnostic and never fabricates a
   * `cause`; it only forwards what upstream supplied.
   */
  private readonly namespaceCause = new Map<string, LifecycleCause>();

  private readonly messageProcessor: SessionMessageProcessor;

  private readonly abortController = new AbortController();

  private readonly buffer: ProtocolEvent[] = [];

  private sendQueue = Promise.resolve();

  private sourceTask?: Promise<void>;

  private nextSeq = 0;

  private maxBufferSize = 1000;

  private flowStrategy: FlowStrategy = "drop-oldest";

  private sampleCounter = 0;

  private pauseGate: Promise<void> | undefined;

  private resumePause: (() => void) | undefined;

  private rootGraphName = "root";

  private terminalLifecycleEmitted = false;

  #loggedEvents = new Set<string>();

  private readonly pendingInterruptIds = new Set<string>();

  /**
   * When true, every event is sent unconditionally via {@link sendJson}
   * regardless of subscription state. Used for SSE transports where
   * per-connection filtering is handled by the outer service layer.
   */
  private readonly passthrough: boolean;

  /**
   * Creates a run-scoped protocol session.
   *
   * @param options - Session construction options and transport bindings.
   */
  constructor(options: {
    runId: string;
    threadId?: string;
    auth?: AuthContext;
    initialRun: Run;
    getRun: () => Promise<Run | null>;
    getThreadState?: () => Promise<{
      tasks?: Array<{ interrupts?: unknown[] }>;
    } | null>;
    send: (payload: string) => Promise<void> | void;
    source?: AsyncIterable<SourceStreamEvent>;
    startSeq?: number;
    passthrough?: boolean;
  }) {
    this.initialRun = options.initialRun;
    this.getRun = options.getRun;
    this.getThreadState = options.getThreadState;
    this.send = options.send;
    this.source = options.source;
    this.passthrough = options.passthrough ?? false;
    if (options.startSeq != null) {
      this.nextSeq = options.startSeq;
    }
    this.messageProcessor = new SessionMessageProcessor({
      ensureNamespaces: async (namespace) => this.ensureNamespaces(namespace),
      pushEvent: async (event) => this.pushEvent(event),
      emitLifecycleEvent: async (namespace, status, options) =>
        this.emitNamespaceLifecycle(namespace, status, options),
      createMessagesEvent: (namespace, data) =>
        this.createEvent("messages", namespace, data),
      createValuesEvent: (namespace, data) =>
        this.createEvent("values", namespace, data),
    });
  }

  #logOnce(message: string) {
    if (this.#loggedEvents.has(message)) return;
    this.#loggedEvents.add(message);
    console.log(`[RunProtocolSession] ${message}`);
  }

  /**
   * Starts consuming the bound run source and seeds the root lifecycle state.
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
        graph_name: this.rootGraphName,
      })
    );

    if (this.source != null) {
      this.sourceTask = this.consumeSource();
    }
  }

  /**
   * Stops consuming the run source and waits for queued writes to settle.
   */
  async close() {
    this.abortController.abort();
    this.resumePause?.();
    this.pauseGate = undefined;
    this.resumePause = undefined;
    await this.sourceTask?.catch(() => undefined);
    await this.sendQueue.catch(() => undefined);
  }

  /**
   * Parses and handles a raw JSON command coming from the transport.
   *
   * @param rawPayload - Raw JSON protocol command payload.
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
          } satisfies AgentResult);
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
   * Handles a structured protocol command and returns a typed response.
   *
   * When `options.deliverResponseInline` is `true`, a
   * `subscription.subscribe` resolves to `null` — the success response
   * has already been written through the shared transport queue ahead
   * of the replay events (see `handleSubscribeForResponse` for
   * rationale). Callers that forward the response onto a separate wire
   * (the WS `onMessage` handler) must treat `null` as
   * "nothing more to send".
   *
   * @param command - Parsed protocol command.
   * @param meta - Optional response metadata from the outer transport.
   * @param options - Server-internal delivery flags.
   * @returns A typed success/error response, or `null` when the
   *     response was already sent inline.
   */
  async handleProtocolCommand(
    command: ProtocolCommand,
    meta?: ProtocolResponseMeta,
    options?: { deliverResponseInline?: boolean }
  ): Promise<ProtocolSuccess | ProtocolError | null> {
    try {
      switch (command.method) {
        case "subscription.subscribe":
          return await this.handleSubscribeForResponse(command, meta, options);
        case "subscription.unsubscribe":
          return await this.handleUnsubscribeForResponse(command, meta);
        case "agent.getTree":
          return this.success(command.id, { tree: this.buildTree([]) }, meta);
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
   * Injects a raw run stream event into the protocol session.
   *
   * @param event - Raw source stream event to normalize.
   */
  async ingestSourceEvent(event: SourceStreamEvent) {
    await this.handleSourceEvent(event);
  }

  /**
   * Consumes the bound source stream until completion or cancellation.
   */
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
        error instanceof Error
          ? error.message
          : "Failed to consume run stream.",
        error instanceof Error ? error.stack : undefined
      );
    } finally {
      await this.emitTerminalLifecycle();
    }
  }

  /**
   * Emits a terminal lifecycle event once the underlying run finishes.
   */
  private async emitTerminalLifecycle() {
    if (this.terminalLifecycleEmitted) return;
    const currentRun = await this.getRun();
    if (currentRun == null) {
      this.terminalLifecycleEmitted = true;
      return;
    }

    let status: NamespaceInfo["status"] = toLifecycleStatus(currentRun.status);
    if (status === "completed") {
      if (this.pendingInterruptIds.size > 0) {
        status = "interrupted";
      } else {
        const threadState = await this.getThreadState?.();
        const hasPendingInterrupts = (threadState?.tasks ?? []).some(
          (task) => Array.isArray(task.interrupts) && task.interrupts.length > 0
        );
        if (hasPendingInterrupts) {
          status = "interrupted";
        }
      }
    }
    if (status === "running") return;

    this.terminalLifecycleEmitted = true;

    // Cascade terminal status to child namespaces still in "started" state.
    const childStatus = status === "interrupted" ? "interrupted" : status;
    for (const info of this.namespaces.values()) {
      if (info.namespace.length > 0 && info.status === "started") {
        await this.emitNamespaceLifecycle(info.namespace, childStatus, {
          graphName: info.graphName,
        });
      }
    }

    await this.emitNamespaceLifecycle([], status, {
      graphName: this.rootGraphName,
    });
  }

  /**
   * Normalizes a single raw source event into protocol events.
   *
   * @param event - Raw source stream event.
   */
  private async handleSourceEvent(event: SourceStreamEvent) {
    if (event.event === "metadata") return;

    if (event.event === "error") {
      this.terminalLifecycleEmitted = true;
      for (const info of this.namespaces.values()) {
        if (info.namespace.length > 0 && info.status === "started") {
          await this.emitNamespaceLifecycle(info.namespace, "failed", {
            graphName: info.graphName,
          });
        }
      }
      await this.emitNamespaceLifecycle([], "failed", {
        graphName: this.rootGraphName,
        error: serializeError(event.data).message,
      });
      return;
    }

    const { method, namespace: rawNamespace } = parseEventName(event.event);
    const namespace = normalizeNamespace(rawNamespace);

    // Upstream `lifecycle` events: stash any `cause` that a product-
    // specific stream transformer (e.g. deepagents' `SubagentTransformer`)
    // attached upstream, then defer to {@link RunProtocolSession.ensureNamespaces}
    // to emit the session's authoritative wire `lifecycle.started`. The
    // session is product-agnostic and never fabricates a `cause`; it
    // only forwards what upstream supplied.
    if (method === "lifecycle") {
      this.recordUpstreamCause(namespace, event.data);
      await this.ensureNamespaces(namespace);
      return;
    }

    if (method !== "messages") {
      await this.ensureNamespaces(namespace);
    }

    switch (method) {
      case "values": {
        const normalizedValues = stripInterruptsFromValues(event.data);
        await this.emitInputRequestedEvents(
          namespace,
          normalizedValues.inputRequests
        );
        if (!this.hasStatePayload(normalizedValues.values)) {
          return;
        }
        await this.pushEvent(
          this.createEvent("values", namespace, normalizedValues.values)
        );
        return;
      }
      case "checkpoints": {
        await this.pushEvent(
          this.createEvent(
            "checkpoints",
            namespace,
            event.data as ProtocolEventDataMap["checkpoints"]
          )
        );
        return;
      }
      case "messages":
        if (namespace.length > 0) {
          await this.ensureNamespaces(namespace);
        }
        if (isRecord(event.data) && typeof event.data.event === "string") {
          this.#logOnce(`model supports v2 stream mode`);
          await this.pushEvent(
            this.createEvent(
              "messages",
              namespace,
              event.data as ProtocolEventDataMap["messages"]
            )
          );
          return;
        }
        if (isMessageTuplePayload(event.data)) {
          this.#logOnce(`model uses legacy stream mode`);
          await this.messageProcessor.normalizeTupleMessageEvent(
            namespace,
            event.data[0],
            event.data[1]
          );
        }
        return;
      case "updates": {
        if (event.normalized) {
          const data = event.data as { node?: string; values: unknown };
          if (data.node === "__interrupt__") {
            await this.emitInputRequestedEvents(
              namespace,
              normalizeInputRequestedData(data.values)
            );
            return;
          }
          await this.pushEvent(
            this.createEvent(
              "updates",
              namespace,
              data.values as ProtocolEventDataMap["updates"],
              data.node
            )
          );
          if (data.node != null) {
            await this.emitChildNodeCompleted(namespace, data.node);
          }
          return;
        }

        const normalized = normalizeUpdatesData(event.data);
        if (normalized.node === "__interrupt__") {
          await this.emitInputRequestedEvents(
            namespace,
            normalizeInputRequestedData(event.data)
          );
          return;
        }

        const strippedUpdates = stripInterruptsFromValues(normalized.values);
        await this.emitInputRequestedEvents(
          namespace,
          strippedUpdates.inputRequests
        );
        if (!this.hasStatePayload(strippedUpdates.values)) {
          if (normalized.node != null) {
            await this.emitChildNodeCompleted(namespace, normalized.node);
          }
          return;
        }
        await this.pushEvent(
          this.createEvent(
            "updates",
            namespace,
            strippedUpdates.values as ProtocolEventDataMap["updates"],
            normalized.node
          )
        );
        if (normalized.node != null) {
          await this.emitChildNodeCompleted(namespace, normalized.node);
        }
        return;
      }
      case "custom":
        if (event.normalized) {
          await this.pushEvent(
            this.createEvent(
              "custom",
              namespace,
              event.data as ProtocolEventDataMap["custom"]
            )
          );
          return;
        }
        await this.pushEvent(
          this.createEvent("custom", namespace, {
            payload: event.data,
          } satisfies CustomData)
        );
        return;
      case "tasks":
        await this.pushEvent(this.createEvent("tasks", namespace, event.data));
        return;
      case "tools":
        if (event.normalized) {
          await this.pushEvent(
            this.createEvent(
              "tools",
              namespace,
              event.data as ProtocolEventDataMap["tools"]
            )
          );
          return;
        }
        await this.pushEvent(
          this.createEvent(
            "tools",
            namespace,
            normalizeToolData(event.data, event.id ?? uuid7())
          )
        );
        return;
      case "messages/metadata":
      case "messages/partial":
      case "messages/complete":
        await this.messageProcessor.normalizeLegacyMessageEvent(
          method,
          namespace,
          event.data
        );
        return;
      default:
        // Route unknown methods as named custom events. This allows
        // reducers to emit("a2a", data) and have it appear on the
        // custom channel with name set for client-side filtering.
        await this.pushEvent(
          this.createEvent("custom", namespace, {
            name: method,
            payload: event.data,
          } satisfies CustomData)
        );
        return;
    }
  }

  /**
   * Ensures lifecycle state exists for each namespace prefix.
   *
   * @param namespace - Namespace whose prefixes should be materialized.
   */
  private async ensureNamespaces(namespace: Namespace) {
    for (let length = 1; length <= namespace.length; length += 1) {
      const partial = namespace.slice(0, length);
      const key = toNamespaceKey(partial);
      if (this.namespaces.has(key)) continue;

      const graphName = guessGraphName(partial);
      this.setNamespaceInfo(partial, "started", { graphName });
      // Optional CDDL `cause` — correlates this subgraph's
      // `lifecycle.started` with whatever caused it to spawn on the parent
      // namespace. Populated by product-specific stream transformers
      // upstream and stashed on first sight by {@link RunProtocolSession.recordUpstreamCause}.
      // The session is product-agnostic and only forwards what upstream
      // supplied.
      const cause = this.namespaceCause.get(key);
      await this.pushEvent(
        this.createEvent("lifecycle", partial, {
          event: "started",
          graph_name: graphName,
          ...(cause != null ? { cause } : {}),
        })
      );
    }
  }

  /**
   * Stash the upstream `cause` for a `lifecycle.started` event.
   *
   * Product-specific stream transformers (e.g. deepagents'
   * `SubagentTransformer`) populate `data.cause` before the event reaches
   * the session. We squirrel the value away per namespace so
   * {@link RunProtocolSession.ensureNamespaces} can emit the wire
   * `lifecycle.started` with the correlation in place. Only `started`
   * events contribute — terminal transitions don't carry a fresh cause.
   *
   * Shape validation is intentionally loose: any object with a string
   * `type` is accepted, so future variants added to the protocol flow
   * through pinned servers unchanged.
   */
  private recordUpstreamCause(namespace: Namespace, data: unknown) {
    if (!isRecord(data)) return;
    if (data.event !== "started") return;
    const cause = (data as { cause?: unknown }).cause;
    if (cause == null || typeof cause !== "object") return;
    if (typeof (cause as { type?: unknown }).type !== "string") return;
    this.namespaceCause.set(
      toNamespaceKey(namespace),
      cause as LifecycleCause
    );
  }

  /**
   * Emits a `completed` lifecycle for the child namespace corresponding
   * to a node that just finished executing. LangGraph emits an `updates`
   * event on the PARENT namespace with `node: <name>` after a node's
   * task completes, which is our cue that `[...parent, "<name>:<uuid>"]`
   * is done — otherwise child namespaces stay in `"started"` until the
   * run terminates and the whole tree is cascade-completed at once.
   *
   * For parallel fan-outs of the same node name, we mark the oldest
   * still-started matching child first; LangGraph emits one `updates`
   * per completed task, so repeated calls drain the bucket in order.
   *
   * @param parentNamespace - Namespace carrying the `updates` event.
   * @param nodeName - Name of the node that just finished.
   */
  private async emitChildNodeCompleted(
    parentNamespace: Namespace,
    nodeName: string
  ) {
    if (nodeName.startsWith("__")) return; // skip __start__, __end__, etc.
    const prefix = `${nodeName}:`;
    // `this.namespaces` is a Map, iterated in insertion order. The first
    // still-started match is therefore the oldest pending invocation.
    for (const info of this.namespaces.values()) {
      const ns = info.namespace;
      if (ns.length !== parentNamespace.length + 1) continue;
      if (info.status !== "started") continue;
      let parentMatches = true;
      for (let i = 0; i < parentNamespace.length; i += 1) {
        if (ns[i] !== parentNamespace[i]) {
          parentMatches = false;
          break;
        }
      }
      if (!parentMatches) continue;
      const last = ns[ns.length - 1];
      if (last !== nodeName && !last.startsWith(prefix)) continue;
      await this.emitNamespaceLifecycle(ns, "completed", {
        graphName: info.graphName,
      });
      return;
    }
  }

  /**
   * Updates cached namespace metadata used for lifecycle and tree responses.
   *
   * @param namespace - Namespace to update.
   * @param status - New lifecycle status for the namespace.
   * @param options - Optional graph name override.
   */
  private setNamespaceInfo(
    namespace: Namespace,
    status: NamespaceInfo["status"],
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
        (namespace.length === 0
          ? this.rootGraphName
          : guessGraphName(namespace)),
    });
  }

  /**
   * Updates cached lifecycle state for a namespace and emits the matching event.
   *
   * @param namespace - Namespace to update.
   * @param status - Lifecycle status to emit.
   * @param options - Optional graph name override and error payload.
   */
  private async emitNamespaceLifecycle(
    namespace: Namespace,
    status: NamespaceInfo["status"],
    options?: { graphName?: string; error?: string }
  ) {
    const key = toNamespaceKey(namespace);
    if (namespace.length > 0 && !this.namespaces.has(key)) {
      await this.ensureNamespaces(namespace);
    }

    const current = this.namespaces.get(key);
    const graphName =
      options?.graphName ??
      current?.graphName ??
      (namespace.length === 0 ? this.rootGraphName : guessGraphName(namespace));

    if (
      current?.status === status &&
      current.graphName === graphName &&
      options?.error == null
    ) {
      return;
    }

    this.setNamespaceInfo(namespace, status, { graphName });
    await this.pushEvent(
      this.createEvent("lifecycle", namespace, {
        event: status,
        graph_name: graphName,
        ...(options?.error != null ? { error: options.error } : {}),
      })
    );
  }

  private createEvent(
    method: "values",
    namespace: Namespace,
    data: ProtocolEventDataMap["values"]
  ): ProtocolEventByMethod<"values">;
  private createEvent(
    method: "updates",
    namespace: Namespace,
    data: ProtocolEventDataMap["updates"],
    node?: string
  ): ProtocolEventByMethod<"updates">;
  private createEvent(
    method: "checkpoints",
    namespace: Namespace,
    data: ProtocolEventDataMap["checkpoints"]
  ): ProtocolEventByMethod<"checkpoints">;
  private createEvent(
    method: "input",
    namespace: Namespace,
    data: ProtocolEventDataMap["input"]
  ): ProtocolEventByMethod<"input">;
  private createEvent(
    method: "messages",
    namespace: Namespace,
    data: ProtocolEventDataMap["messages"],
    node?: string
  ): ProtocolEventByMethod<"messages">;
  private createEvent(
    method: "tools",
    namespace: Namespace,
    data: ProtocolEventDataMap["tools"],
    node?: string
  ): ProtocolEventByMethod<"tools">;
  private createEvent(
    method: "custom",
    namespace: Namespace,
    data: ProtocolEventDataMap["custom"]
  ): ProtocolEventByMethod<"custom">;
  private createEvent(
    method: "lifecycle",
    namespace: Namespace,
    data: ProtocolEventDataMap["lifecycle"]
  ): ProtocolEventByMethod<"lifecycle">;
  private createEvent(
    method: "tasks",
    namespace: Namespace,
    data: ProtocolEventDataMap["tasks"]
  ): ProtocolEventByMethod<"tasks">;

  /**
   * Creates a protocol event with sequencing and payload normalization applied.
   *
   * @param method - Event channel to emit.
   * @param namespace - Namespace associated with the event.
   * @param data - Event payload.
   * @param node - Optional node name for updates and messages.
   * @returns A fully-formed protocol event.
   */
  private createEvent(
    method: SupportedChannel,
    namespace: Namespace,
    data: ProtocolEventDataMap[SupportedChannel],
    node?: string
  ): ProtocolEvent {
    this.nextSeq += 1;
    const eventMethod = method === "input" ? "input.requested" : method;
    const normalizedData =
      method === "values" || method === "updates"
        ? normalizeProtocolStatePayload(data)
        : data;
    return {
      type: "event",
      event_id: String(this.nextSeq),
      seq: this.nextSeq,
      method: eventMethod,
      params: {
        namespace,
        timestamp: Date.now(),
        ...(node != null ? { node } : {}),
        data: normalizedData,
      },
    } as ProtocolEvent;
  }

  /**
   * Buffers an event and delivers it to all matching subscriptions.
   * Applies the active flow-control strategy when the buffer is at capacity.
   *
   * @param event - Protocol event to buffer and fan out.
   */
  private async pushEvent(event: ProtocolEvent) {
    if (this.pauseGate != null) {
      await this.pauseGate;
    }

    const atCapacity = this.buffer.length >= this.maxBufferSize;

    if (atCapacity) {
      switch (this.flowStrategy) {
        case "pause-producer": {
          this.pauseGate = new Promise<void>((resolve) => {
            this.resumePause = resolve;
          });
          break;
        }
        case "sample": {
          this.sampleCounter += 1;
          const isLifecycle = event.method === "lifecycle";
          if (!isLifecycle && this.sampleCounter % 2 !== 0) {
            return;
          }
          this.buffer.splice(0, 1);
          break;
        }
        case "drop-oldest":
        default:
          this.buffer.splice(0, this.buffer.length - this.maxBufferSize + 1);
          break;
      }
    }

    this.buffer.push(event);

    if (this.passthrough) {
      await this.sendJson(event);
    } else {
      for (const subscription of this.subscriptions.values()) {
        if (
          !subscription.active ||
          !this.matchesSubscription(subscription, event)
        ) {
          continue;
        }
        await this.sendJson(event);
      }
    }
  }

  /**
   * Checks whether an event should be delivered to a subscription.
   *
   * @param subscription - Subscription to test.
   * @param event - Candidate protocol event.
   * @returns Whether the event matches channel and namespace filters.
   */
  private matchesSubscription(
    subscription: Subscription,
    event: ProtocolEvent
  ): boolean {
    const channel =
      event.method === "input.requested"
        ? "input"
        : isSupportedChannel(event.method)
          ? event.method
          : undefined;
    if (channel == null) return false;

    // Support "custom:name" subscriptions: "custom:a2a" matches custom
    // events with data.name === "a2a", while "custom" matches all.
    let channelMatched = subscription.channels.has(channel);
    if (!channelMatched && channel === "custom") {
      const params = event.params as Record<string, unknown>;
      const eventName =
        isRecord(params.data) && typeof params.data.name === "string"
          ? params.data.name
          : undefined;
      if (eventName != null) {
        channelMatched = subscription.channels.has(`custom:${eventName}`);
      }
    }
    if (!channelMatched) return false;

    if (
      subscription.namespaces == null ||
      subscription.namespaces.length === 0
    ) {
      return true;
    }

    return subscription.namespaces.some((prefix) => {
      if (!isPrefixMatch(event.params.namespace, prefix)) return false;
      if (subscription.depth == null) return true;
      return (
        event.params.namespace.length - prefix.length <= subscription.depth
      );
    });
  }

  private hasStatePayload(value: unknown) {
    return !isRecord(value) || Object.keys(value).length > 0;
  }

  private async emitInputRequestedEvents(
    namespace: Namespace,
    requests: ProtocolEventDataMap["input"][]
  ) {
    for (const request of requests) {
      if (this.pendingInterruptIds.has(request.interrupt_id)) {
        continue;
      }
      this.pendingInterruptIds.add(request.interrupt_id);
      await this.pushEvent(this.createEvent("input", namespace, request));
    }
  }

  /**
   * Builds the agent tree view rooted at a namespace.
   *
   * @param namespace - Namespace to build from.
   * @returns A recursively assembled agent tree node.
   */
  private buildTree(namespace: Namespace): AgentTreeNode {
    const key = toNamespaceKey(namespace);
    const current =
      this.namespaces.get(key) ??
      ({
        namespace,
        status: "started",
        graphName:
          namespace.length === 0
            ? this.rootGraphName
            : guessGraphName(namespace),
      } satisfies NamespaceInfo);

    const children = [...this.namespaces.values()]
      .filter((candidate) => {
        if (candidate.namespace.length !== namespace.length + 1) return false;
        return isPrefixMatch(candidate.namespace, namespace);
      })
      .sort((left, right) =>
        JSON.stringify(left.namespace).localeCompare(
          JSON.stringify(right.namespace)
        )
      )
      .map((child) => this.buildTree(child.namespace));

    return {
      namespace: current.namespace,
      status: current.status,
      graph_name: current.graphName,
      ...(children.length > 0 ? { children } : {}),
    } satisfies AgentTreeNode;
  }

  /**
   * Handles a subscribe command and writes the response to the transport.
   *
   * @param command - Subscribe command to process.
   */
  private async handleSubscribe(
    command: ProtocolCommandByMethod<"subscription.subscribe">
  ) {
    const params = isRecord(command.params)
      ? (command.params as Partial<SubscribeParams>)
      : undefined;
    const rawChannels = params?.channels as unknown[] | undefined;
    if (!Array.isArray(rawChannels) || rawChannels.length === 0) {
      await this.sendError(
        command.id,
        "invalid_argument",
        "subscription.subscribe requires a non-empty channels array."
      );
      return;
    }

    const channels = rawChannels.filter(
      (value): value is SubscriptionChannel =>
        typeof value === "string" &&
        (SUPPORTED_CHANNELS.has(value as SupportedChannel) ||
          value.startsWith("custom:"))
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
        ? (params.namespaces as Namespace[])
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
        (event.seq ?? 0) <= snapshotSeq &&
        this.matchesSubscription(subscription, event)
    );

    await this.sendSuccess(command.id, {
      subscription_id: subscription.id,
      replayed_events: snapshot.length,
    } satisfies SubscribeResult);

    for (const event of snapshot) {
      await this.sendJson(event);
    }

    let cursor = snapshotSeq;
    while (true) {
      const drain = this.buffer.filter(
        (event) =>
          (event.seq ?? 0) > cursor &&
          this.matchesSubscription(subscription, event)
      );
      if (drain.length === 0) break;
      for (const event of drain) {
        await this.sendJson(event);
      }
      cursor = drain.at(-1)?.seq ?? cursor;
    }

    subscription.active = true;
  }

  /**
   * Handles a subscribe command and (optionally) writes the
   * success/error response inline through the shared transport
   * queue, signalling to callers (via a `null` return) that no
   * further send is required.
   *
   * When `options.deliverResponseInline` is `true`, the success
   * response is emitted via `sendJson` BEFORE the replay events and
   * the method returns `null`. This ordering is critical on
   * single-channel transports like WebSocket where the command
   * response and event frames share one ordered wire: if events
   * preceded the response, the client would receive events whose
   * `subscription_id` it hasn't yet registered (the awaiter in
   * `#subscribeViaCommand` only adds the subscription to its local
   * map after the response resolves) and drop them in the per-sub
   * fan-out.
   *
   * When `deliverResponseInline` is absent/`false` (the default, used
   * by HTTP `/commands`), the response is returned so the caller can
   * place it in the HTTP response body, matching the prior behaviour.
   * Input-validation errors always return normally regardless of the
   * flag so they surface consistently in both modes.
   *
   * @param command - Subscribe command to process.
   * @param meta - Optional response metadata from the outer transport.
   * @param options - Server-internal delivery flags.
   * @returns `null` when the response was sent inline; a typed
   *     success/error response otherwise.
   */
  private async handleSubscribeForResponse(
    command: ProtocolCommandByMethod<"subscription.subscribe">,
    meta?: ProtocolResponseMeta,
    options?: { deliverResponseInline?: boolean }
  ): Promise<ProtocolSuccess | ProtocolError | null> {
    const deliverResponseInline = options?.deliverResponseInline === true;
    const params = isRecord(command.params)
      ? (command.params as Partial<SubscribeParams>)
      : undefined;
    const rawChannels = params?.channels as unknown[] | undefined;
    if (!Array.isArray(rawChannels) || rawChannels.length === 0) {
      return this.error(
        command.id,
        "invalid_argument",
        "subscription.subscribe requires a non-empty channels array.",
        meta
      );
    }

    const channels = rawChannels.filter(
      (value): value is SubscriptionChannel =>
        typeof value === "string" &&
        (SUPPORTED_CHANNELS.has(value as SupportedChannel) ||
          value.startsWith("custom:"))
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
        ? (params.namespaces as Namespace[])
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
        (event.seq ?? 0) <= snapshotSeq &&
        this.matchesSubscription(subscription, event)
    );

    const responsePayload: ProtocolSuccess = {
      type: "success",
      id: command.id,
      result: {
        subscription_id: subscription.id,
        replayed_events: snapshot.length,
      } satisfies SubscribeResult,
      ...(meta != null ? { meta } : {}),
    };

    if (deliverResponseInline) {
      // Response first, replay events second — see method-level
      // comment on why the ordering matters for ordered transports.
      await this.sendJson(responsePayload);
    }

    for (const event of snapshot) {
      await this.sendJson(event);
    }

    let cursor = snapshotSeq;
    while (true) {
      const drain = this.buffer.filter(
        (event) =>
          (event.seq ?? 0) > cursor &&
          this.matchesSubscription(subscription, event)
      );
      if (drain.length === 0) break;
      for (const event of drain) {
        await this.sendJson(event);
      }
      cursor = drain.at(-1)?.seq ?? cursor;
    }

    subscription.active = true;
    return deliverResponseInline ? null : responsePayload;
  }

  /**
   * Handles an unsubscribe command and writes the response to the transport.
   *
   * @param command - Unsubscribe command to process.
   */
  private async handleUnsubscribe(
    command: ProtocolCommandByMethod<"subscription.unsubscribe">
  ) {
    const params = isRecord(command.params)
      ? (command.params as Partial<UnsubscribeParams>)
      : undefined;
    const subscriptionId = params?.subscription_id;
    if (typeof subscriptionId !== "string") {
      await this.sendError(
        command.id,
        "invalid_argument",
        "subscription.unsubscribe requires a subscription_id."
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

  /**
   * Handles an unsubscribe command and returns a typed response.
   *
   * @param command - Unsubscribe command to process.
   * @param meta - Optional response metadata from the outer transport.
   * @returns A typed success or error response.
   */
  private async handleUnsubscribeForResponse(
    command: ProtocolCommandByMethod<"subscription.unsubscribe">,
    meta?: ProtocolResponseMeta
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = isRecord(command.params)
      ? (command.params as Partial<UnsubscribeParams>)
      : undefined;
    const subscriptionId = params?.subscription_id;
    if (typeof subscriptionId !== "string") {
      return this.error(
        command.id,
        "invalid_argument",
        "subscription.unsubscribe requires a subscription_id.",
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

  /**
   * Sends a success response over the bound transport.
   *
   * @param id - Command identifier being acknowledged.
   * @param result - Typed success payload.
   */
  private async sendSuccess<Result extends ProtocolSuccess["result"]>(
    id: number,
    result: Result
  ) {
    await this.sendJson({
      type: "success",
      id,
      result,
    } satisfies ProtocolSuccess);
  }

  /**
   * Sends an error response over the bound transport.
   *
   * @param id - Command identifier, when available.
   * @param error - Protocol error code.
   * @param message - Human-readable error message.
   * @param stacktrace - Optional stack trace for debugging.
   */
  private async sendError(
    id: number | null,
    error: ProtocolError["error"],
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

  /**
   * Serializes and writes a protocol payload using the session transport queue.
   *
   * @param message - Protocol message to send.
   */
  private async sendJson(
    message: ProtocolEvent | ProtocolSuccess | ProtocolError
  ) {
    this.sendQueue = this.sendQueue
      .then(() => this.send(serialiseAsDict(message)))
      .catch(() => undefined);
    await this.sendQueue;
  }

  /**
   * Creates a typed success response object.
   *
   * @param id - Command identifier being acknowledged.
   * @param result - Typed success payload.
   * @param meta - Optional response metadata from the outer transport.
   * @returns A typed protocol success response.
   */
  private success<Result extends ProtocolSuccess["result"]>(
    id: number,
    result: Result,
    meta?: ProtocolResponseMeta
  ): ProtocolSuccess {
    return {
      type: "success",
      id,
      result,
      ...(meta != null ? { meta } : {}),
    };
  }

  /**
   * Creates a typed error response object.
   *
   * @param id - Command identifier, when available.
   * @param error - Protocol error code.
   * @param message - Human-readable error message.
   * @param meta - Optional response metadata from the outer transport.
   * @param stacktrace - Optional stack trace for debugging.
   * @returns A typed protocol error response.
   */
  private error(
    id: number | null,
    error: ProtocolError["error"],
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
