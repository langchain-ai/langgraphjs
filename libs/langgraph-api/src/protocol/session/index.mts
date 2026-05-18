import { v7 as uuid7 } from "uuid";

import type { AuthContext } from "../../auth/index.mjs";
import type { Run } from "../../storage/types.mjs";
import { serialiseAsDict, serializeError } from "../../utils/serde.mjs";
import type {
  AgentResult,
  AgentTreeNode,
  CustomData,
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
import {
  guessGraphName,
  isPrefixMatch,
  normalizeNamespace,
  parseEventName,
  toNamespaceKey,
} from "./namespace.mjs";
import { normalizeProtocolStatePayload } from "./state-normalizers.mjs";

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

  private readonly abortController = new AbortController();

  private readonly buffer: ProtocolEvent[] = [];

  private sendQueue = Promise.resolve();

  private sourceTask?: Promise<void>;

  private nextSeq = 0;

  private rootGraphName = "root";

  private terminalLifecycleEmitted = false;

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
   * Emits the terminal root lifecycle event once the underlying run
   * finishes.  Child namespaces are cascaded upstream by core's
   * `LifecycleTransformer` — the session only owns the root because
   * terminal status depends on API-only signals (persisted run
   * status, thread-level pending interrupts).
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
        let threadState: Awaited<
          ReturnType<NonNullable<typeof this.getThreadState>>
        > | null;
        try {
          threadState = (await this.getThreadState?.()) ?? null;
        } catch {
          threadState = null;
        }
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
    this.setNamespaceInfo([], status, { graphName: this.rootGraphName });
    await this.pushEvent(
      this.createEvent("lifecycle", [], {
        event: status,
        graph_name: this.rootGraphName,
      })
    );
  }

  /**
   * Normalizes a single raw source event into protocol events.
   *
   * @param event - Raw source stream event.
   */
  private async handleSourceEvent(event: SourceStreamEvent) {
    if (event.event === "metadata") return;

    if (event.event === "error") {
      // Core's `LifecycleTransformer.fail()` has already cascaded
      // `lifecycle.failed` to every sub-namespace.  The session owns
      // the root lifecycle, so emit only the root here.
      this.terminalLifecycleEmitted = true;
      this.setNamespaceInfo([], "failed", { graphName: this.rootGraphName });
      await this.pushEvent(
        this.createEvent("lifecycle", [], {
          event: "failed",
          graph_name: this.rootGraphName,
          error: serializeError(event.data).message,
        })
      );
      return;
    }

    const { method, namespace: rawNamespace } = parseEventName(event.event);
    const namespace = normalizeNamespace(rawNamespace);

    if (
      event.normalized &&
      (await this.forwardNormalizedSourceEvent(method, namespace, event.data))
    ) {
      return;
    }

    // Authoritative subgraph `lifecycle` events come from core's
    // `LifecycleTransformer`. The session observes them, updates its
    // in-memory namespace tracking for agent-tree queries, and forwards
    // them to subscribers. Root lifecycle events are owned by the
    // session (see `start()` and `emitTerminalLifecycle()`), so root
    // events from core are dropped here.
    if (method === "lifecycle") {
      if (namespace.length === 0) return;
      const data = event.data as ProtocolEventDataMap["lifecycle"];
      this.setNamespaceInfo(namespace, data.event, {
        graphName: data.graph_name,
      });
      await this.pushEvent(this.createEvent("lifecycle", namespace, data));
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
        return;
      case "custom":
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
        await this.pushEvent(
          this.createEvent(
            "tools",
            namespace,
            normalizeToolData(event.data, event.id ?? uuid7())
          )
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
   * Forwards events already converted by core's
   * `streamEvents(..., { version: "v3" })` pipeline.
   *
   * Only events marked by `streamStateV2` after `convertToProtocolEvent` and
   * the built-in stream transformers have run take this path.
   */
  private async forwardNormalizedSourceEvent(
    method: string,
    namespace: Namespace,
    data: unknown
  ): Promise<boolean> {
    switch (method) {
      case "lifecycle": {
        if (namespace.length === 0) return true;
        const lifecycleData = data as ProtocolEventDataMap["lifecycle"];
        this.setNamespaceInfo(namespace, lifecycleData.event, {
          graphName: lifecycleData.graph_name,
        });
        await this.pushEvent(
          this.createEvent("lifecycle", namespace, lifecycleData)
        );
        return true;
      }
      case "messages": {
        if (namespace.length > 0) {
          await this.ensureNamespaces(namespace);
        }
        await this.pushEvent(
          this.createEvent(
            "messages",
            namespace,
            data as ProtocolEventDataMap["messages"]
          )
        );
        return true;
      }
      case "updates": {
        await this.ensureNamespaces(namespace);
        const updatesData = data as { node?: string; values: unknown };
        if (updatesData.node === "__interrupt__") {
          await this.emitInputRequestedEvents(
            namespace,
            normalizeInputRequestedData(updatesData.values)
          );
          return true;
        }
        await this.pushEvent(
          this.createEvent(
            "updates",
            namespace,
            updatesData.values as ProtocolEventDataMap["updates"],
            updatesData.node
          )
        );
        return true;
      }
      case "tools": {
        await this.ensureNamespaces(namespace);
        await this.pushEvent(
          this.createEvent(
            "tools",
            namespace,
            data as ProtocolEventDataMap["tools"]
          )
        );
        return true;
      }
      case "custom": {
        await this.ensureNamespaces(namespace);
        await this.pushEvent(
          this.createEvent(
            "custom",
            namespace,
            data as ProtocolEventDataMap["custom"]
          )
        );
        return true;
      }
      case "checkpoints": {
        await this.ensureNamespaces(namespace);
        await this.pushEvent(
          this.createEvent(
            "checkpoints",
            namespace,
            data as ProtocolEventDataMap["checkpoints"]
          )
        );
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Ensures the session is tracking each prefix of `namespace` so
   * agent-tree queries and message routing can resolve it.
   *
   * Does **not** emit any wire events: authoritative
   * `lifecycle.started` events are produced upstream by core's
   * `LifecycleTransformer` and observed by the session's lifecycle
   * handler in {@link RunProtocolSession.handleSourceEvent}.  This
   * method is a defensive fallback for event paths that reference a namespace
   * before the corresponding `lifecycle` event has been ingested.
   *
   * @param namespace - Namespace whose prefixes should be tracked.
   */
  private async ensureNamespaces(namespace: Namespace) {
    for (let length = 1; length <= namespace.length; length += 1) {
      const partial = namespace.slice(0, length);
      const key = toNamespaceKey(partial);
      if (this.namespaces.has(key)) continue;
      this.setNamespaceInfo(partial, "started", {
        graphName: guessGraphName(partial),
      });
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
