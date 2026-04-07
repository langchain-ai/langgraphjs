import { v7 as uuid7 } from "uuid";

import type { AuthContext } from "../auth/index.mjs";
import type { Run } from "../storage/types.mjs";
import type {
  AgentResult,
  AgentStatus,
  AgentTreeNode,
  ContentBlockDeltaData,
  ContentBlockFinishData,
  ContentBlockStartData,
  CustomData,
  DebugEvent,
  FlowCapacityParams,
  MessageFinishData,
  MessageMetadata,
  MessageStartData,
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
  ToolErrorData,
  ToolFinishedData,
  ToolOutputDeltaData,
  ToolStartedData,
  ToolsData,
  UnsubscribeParams,
  UpdatesEvent,
} from "./types.mjs";
import { serialiseAsDict, serializeError } from "../utils/serde.mjs";

type Subscription = {
  id: string;
  channels: Set<SupportedChannel>;
  namespaces?: Namespace[];
  depth?: number;
  active: boolean;
};

type NamespaceInfo = {
  namespace: Namespace;
  status: AgentStatus;
  graphName: string;
};

type ProtocolMetadataScalar = string | number | boolean | null;

type ProtocolCompatibleMessageMetadata = MessageMetadata &
  Record<string, ProtocolMetadataScalar>;

type MessageState = {
  metadata?: ProtocolCompatibleMessageMetadata;
  namespace?: Namespace;
  started: boolean;
  lastText: string;
  finished: boolean;
};

type SyntheticSubagentState = {
  namespace: Namespace;
  messages: Array<Record<string, unknown>>;
  completed: boolean;
};

type NormalizedUpdatesData = {
  node?: string;
  values: UpdatesEvent["params"]["data"]["values"];
};

type ProtocolEventDataMap = {
  values: ProtocolEventByMethod<"values">["params"]["data"];
  updates:
    | ProtocolEventByMethod<"updates">["params"]["data"]
    | UpdatesEvent["params"]["data"]["values"];
  messages:
    | ProtocolEventByMethod<"messages">["params"]["data"]
    | Record<string, unknown>
    | unknown[];
  tools: ProtocolEventByMethod<"tools">["params"]["data"];
  custom: ProtocolEventByMethod<"custom">["params"]["data"];
  lifecycle: ProtocolEventByMethod<"lifecycle">["params"]["data"];
  debug: ProtocolEventByMethod<"debug">["params"]["data"];
  checkpoints: ProtocolEventByMethod<"checkpoints">["params"]["data"];
  tasks: ProtocolEventByMethod<"tasks">["params"]["data"];
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

const isSupportedChannel = (value: string): value is SupportedChannel =>
  SUPPORTED_CHANNELS.has(value as SupportedChannel);

const isMetadataScalar = (
  value: unknown
): value is ProtocolMetadataScalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const PROTOCOL_METADATA_KEY_MAP = {
  provider: ["provider", "ls_provider"],
  model: ["model", "model_name", "ls_model_name"],
  modelType: ["modelType", "model_type", "ls_model_type"],
  runId: ["runId", "run_id"],
  threadId: ["threadId", "thread_id"],
  systemFingerprint: ["systemFingerprint", "system_fingerprint"],
  serviceTier: ["serviceTier", "service_tier"],
} as const satisfies Record<string, readonly string[]>;

const PROTOCOL_METADATA_SOURCE_KEYS = new Set<string>(
  Object.values(PROTOCOL_METADATA_KEY_MAP).flat()
);

const PROTOCOL_METADATA_EXCLUDED_KEYS = new Set<string>([
  "assistant_id",
  "checkpoint_ns",
  "created_by",
  "graph_id",
  "langgraph_api_url",
  "langgraph_checkpoint_ns",
  "langgraph_host",
  "langgraph_node",
  "langgraph_path",
  "langgraph_plan",
  "langgraph_step",
  "langgraph_triggers",
  "langgraph_version",
  "ls_integration",
  "run_attempt",
  "tags",
  "versions",
  "__pregel_task_id",
]);

const toProtocolMessageMetadata = (
  value: unknown
): ProtocolCompatibleMessageMetadata | undefined => {
  if (!isRecord(value)) return undefined;

  const metadata = isRecord(value.metadata) ? value.metadata : value;
  const concise: ProtocolCompatibleMessageMetadata = {};

  for (const [targetKey, sourceKeys] of Object.entries(PROTOCOL_METADATA_KEY_MAP)) {
    const mappedValue = sourceKeys
      .map((sourceKey) => metadata[sourceKey])
      .find((candidate) => isMetadataScalar(candidate));
    if (mappedValue !== undefined) {
      concise[targetKey] = mappedValue;
    }
  }

  for (const [key, rawValue] of Object.entries(metadata)) {
    if (
      key in PROTOCOL_METADATA_KEY_MAP ||
      PROTOCOL_METADATA_SOURCE_KEYS.has(key) ||
      PROTOCOL_METADATA_EXCLUDED_KEYS.has(key) ||
      key.startsWith("langgraph_") ||
      key.startsWith("__pregel_") ||
      key.startsWith("checkpoint_")
    ) {
      continue;
    }

    if (isMetadataScalar(rawValue)) {
      concise[key] = rawValue;
    }
  }

  return Object.keys(concise).length > 0 ? concise : undefined;
};

const toProtocolMessageNamespace = (value: unknown): Namespace | undefined => {
  if (!isRecord(value)) return undefined;

  const metadata = isRecord(value.metadata) ? value.metadata : value;
  const checkpointNs =
    typeof metadata.langgraph_checkpoint_ns === "string"
      ? metadata.langgraph_checkpoint_ns
      : typeof metadata.checkpoint_ns === "string"
        ? metadata.checkpoint_ns
        : undefined;

  if (!checkpointNs) return undefined;

  return checkpointNs.split("|").filter((segment) => segment.length > 0);
};

const toNamespaceKey = (namespace: Namespace) => namespace.join("\0");

const normalizeNamespaceSegment = (segment: string) => segment.split(":")[0];

// Preserve raw namespace segments in protocol events so clients can distinguish
// parallel subgraphs such as `tools:<task-id>`. We only strip dynamic suffixes
// when deriving display-oriented graph names.
const normalizeNamespace = (namespace: string[]): Namespace => namespace;

const parseEventName = (event: string) => {
  const [method, ...namespace] = event.split("|");
  return { method, namespace };
};

const isPrefixMatch = (namespace: Namespace, prefix: Namespace) => {
  if (prefix.length > namespace.length) return false;
  return prefix.every((segment, index) => namespace[index] === segment);
};

const guessGraphName = (namespace: Namespace) => {
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

const asUpdateValues = (value: unknown): UpdatesEvent["params"]["data"]["values"] =>
  isRecord(value) ? value : { value };

const normalizeUpdatesData = (
  value: unknown
): NormalizedUpdatesData => {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [node, nodeValues] = entries[0];
      return { node, values: asUpdateValues(nodeValues) };
    }
  }
  return { values: asUpdateValues(value) };
};

const getToolCallId = (
  value: Record<string, unknown>,
  fallbackToolCallId: string
): string => {
  if (typeof value.toolCallId === "string") return value.toolCallId;
  if (typeof value.tool_call_id === "string") return value.tool_call_id;
  if (typeof value.id === "string") return value.id;
  return fallbackToolCallId;
};

const normalizeToolData = (
  value: unknown,
  fallbackToolCallId: string
): ToolsData => {
  if (!isRecord(value) || typeof value.event !== "string") {
    return {
      event: "tool-output-delta",
      toolCallId: fallbackToolCallId,
      delta: extractErrorMessage(value),
    } satisfies ToolOutputDeltaData;
  }

  const toolCallId = getToolCallId(value, fallbackToolCallId);

  switch (value.event) {
    case "on_tool_start":
      return {
        event: "tool-started",
        toolCallId,
        toolName: typeof value.name === "string" ? value.name : "tool",
        input: value.input,
      } satisfies ToolStartedData;
    case "on_tool_event":
      return {
        event: "tool-output-delta",
        toolCallId,
        delta:
          typeof value.data === "string"
            ? value.data
            : safeStringify(value.data ?? null),
      } satisfies ToolOutputDeltaData;
    case "on_tool_end":
      return {
        event: "tool-finished",
        toolCallId,
        output: value.output,
      } satisfies ToolFinishedData;
    case "on_tool_error":
      return {
        event: "tool-error",
        toolCallId,
        message: extractErrorMessage(value.error),
      } satisfies ToolErrorData;
    default:
      return {
        event: "tool-output-delta",
        toolCallId,
        delta: safeStringify(value),
      } satisfies ToolOutputDeltaData;
  }
};

const isDebugChunkType = (
  value: unknown
): value is DebugEvent["params"]["data"]["type"] =>
  value === "checkpoint" || value === "task" || value === "task_result";

const normalizeDebugData = (
  value: unknown
): DebugEvent["params"]["data"] => {
  if (
    isRecord(value) &&
    typeof value.step === "number" &&
    isDebugChunkType(value.type)
  ) {
    return {
      step: value.step,
      type: value.type,
      payload: value.payload,
    };
  }
  return {
    step: -1,
    type: "task",
    payload: value,
  };
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

  private readonly syntheticSubagents = new Map<string, SyntheticSubagentState>();

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
          } satisfies AgentResult);
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
    if (method !== "messages") {
      await this.ensureNamespaces(namespace);
    }

    switch (method) {
      case "values":
        await this.pushEvent(this.createEvent("values", namespace, event.data));
        await this.emitSyntheticSubagentEvents(namespace, event.data);
        return;
      case "messages":
        if (namespace.length > 0) {
          await this.ensureNamespaces(namespace);
        }
        await this.pushEvent(
          this.createEvent(
            "messages",
            namespace,
            event.data as ProtocolEventDataMap["messages"]
          )
        );
        return;
      case "updates": {
        const normalized = normalizeUpdatesData(event.data);
        await this.pushEvent(
          this.createEvent("updates", namespace, normalized.values, normalized.node)
        );
        await this.emitSyntheticSubagentEvents(namespace, normalized.values);
        return;
      }
      case "custom":
        await this.pushEvent(
          this.createEvent("custom", namespace, {
            payload: event.data,
          } satisfies CustomData)
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
        await this.normalizeLegacyMessageEvent(
          method,
          namespace,
          event.data
        );
        return;
      default:
        return;
    }
  }

  private parseToolCallArgs(args: unknown): Record<string, unknown> {
    if (isRecord(args)) return args;
    if (typeof args === "string") {
      try {
        const parsed = JSON.parse(args);
        return isRecord(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }

  private createSyntheticMessageMetadata(namespace: Namespace) {
    const checkpointNs = namespace.join("|");
    return {
      checkpoint_ns: checkpointNs,
      langgraph_checkpoint_ns: checkpointNs,
    };
  }

  private async emitSyntheticSubagentEvents(
    namespace: Namespace,
    values: unknown
  ): Promise<void> {
    if (namespace.length > 0 || !isRecord(values) || !Array.isArray(values.messages)) {
      return;
    }

    for (const rawMessage of values.messages) {
      if (!isRecord(rawMessage)) continue;

      if (rawMessage.type === "ai" && Array.isArray(rawMessage.tool_calls)) {
        for (const rawToolCall of rawMessage.tool_calls) {
          if (!isRecord(rawToolCall)) continue;
          if (rawToolCall.name !== "task" || typeof rawToolCall.id !== "string") continue;

          const toolCallId = rawToolCall.id;
          const toolNamespace = [`tools:${toolCallId}`] satisfies Namespace;
          const parsedArgs = this.parseToolCallArgs(rawToolCall.args);
          const description =
            typeof parsedArgs.description === "string"
              ? parsedArgs.description
              : "Task delegated to subagent.";

          if (this.syntheticSubagents.has(toolCallId)) {
            continue;
          }

          await this.ensureNamespaces(toolNamespace);
          const humanMessage = {
            id: `subagent:${toolCallId}:human`,
            type: "human",
            content: description,
            additional_kwargs: {},
            response_metadata: {},
          };
          const syntheticState: SyntheticSubagentState = {
            namespace: toolNamespace,
            messages: [humanMessage],
            completed: false,
          };
          this.syntheticSubagents.set(toolCallId, syntheticState);

          await this.pushEvent(
            this.createEvent("messages", toolNamespace, [
              humanMessage,
              this.createSyntheticMessageMetadata(toolNamespace),
            ])
          );
          await this.pushEvent(
            this.createEvent("values", toolNamespace, {
              messages: syntheticState.messages,
            })
          );
        }
      }

      if (
        rawMessage.type === "tool" &&
        typeof rawMessage.tool_call_id === "string" &&
        rawMessage.name === "task"
      ) {
        const syntheticState = this.syntheticSubagents.get(rawMessage.tool_call_id);
        if (syntheticState == null || syntheticState.completed) {
          continue;
        }

        const aiMessage = {
          id:
            typeof rawMessage.id === "string"
              ? `subagent:${rawMessage.id}`
              : `subagent:${rawMessage.tool_call_id}:ai`,
          type: "ai",
          content:
            typeof rawMessage.content === "string"
              ? rawMessage.content
              : safeStringify(rawMessage.content),
          additional_kwargs: {},
          response_metadata: {},
        };

        syntheticState.messages.push(aiMessage);
        syntheticState.completed = true;

        await this.pushEvent(
          this.createEvent("messages", syntheticState.namespace, [
            aiMessage,
            this.createSyntheticMessageMetadata(syntheticState.namespace),
          ])
        );
        await this.pushEvent(
          this.createEvent("values", syntheticState.namespace, {
            messages: syntheticState.messages,
          })
        );
      }
    }
  }

  private async normalizeLegacyMessageEvent(
    method: string,
    namespace: Namespace,
    data: unknown
  ) {
    if (method === "messages/metadata") {
      if (!isRecord(data)) return;
      for (const [messageId, value] of Object.entries(data)) {
        const state = this.messageState.get(messageId) ?? {
          started: false,
          lastText: "",
          finished: false,
        };
        state.metadata = toProtocolMessageMetadata(value);
        state.namespace = toProtocolMessageNamespace(value) ?? state.namespace;
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
      const messageNamespace = namespace.length > 0 ? namespace : (state.namespace ?? []);

      if (messageNamespace.length > 0) {
        await this.ensureNamespaces(messageNamespace);
      }

      if (!state.started) {
        await this.pushEvent(
          this.createEvent(
            "messages",
            messageNamespace,
            {
              event: "message-start",
              messageId,
              ...(state.metadata != null ? { metadata: state.metadata } : {}),
            } satisfies MessageStartData
          )
        );
        await this.pushEvent(
          this.createEvent(
            "messages",
            messageNamespace,
            {
              event: "content-block-start",
              index: 0,
              contentBlock: { type: "text", text: "" },
            } satisfies ContentBlockStartData
          )
        );
        state.started = true;
      }

      const previousText = state.lastText;
      if (typeof text === "string" && text.length >= previousText.length) {
        const delta = text.slice(previousText.length);
        if (delta.length > 0) {
          await this.pushEvent(
            this.createEvent(
              "messages",
              messageNamespace,
              {
                event: "content-block-delta",
                index: 0,
                contentBlock: { type: "text", text: delta },
              } satisfies ContentBlockDeltaData
            )
          );
        }
        state.lastText = text;
      }

      if (method === "messages/complete" && !state.finished) {
        await this.pushEvent(
          this.createEvent(
            "messages",
            messageNamespace,
            {
              event: "content-block-finish",
              index: 0,
              contentBlock: { type: "text", text: state.lastText },
            } satisfies ContentBlockFinishData
          )
        );
        await this.pushEvent(
          this.createEvent(
            "messages",
            messageNamespace,
            {
              event: "message-finish",
              reason: "stop",
            } satisfies MessageFinishData
          )
        );
        state.finished = true;
      }

      this.messageState.set(messageId, state);
    }
  }

  private async ensureNamespaces(namespace: Namespace) {
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
    namespace: Namespace,
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
    method: "debug",
    namespace: Namespace,
    data: ProtocolEventDataMap["debug"]
  ): ProtocolEventByMethod<"debug">;
  private createEvent(
    method: "checkpoints",
    namespace: Namespace,
    data: ProtocolEventDataMap["checkpoints"]
  ): ProtocolEventByMethod<"checkpoints">;
  private createEvent(
    method: "tasks",
    namespace: Namespace,
    data: ProtocolEventDataMap["tasks"]
  ): ProtocolEventByMethod<"tasks">;
  private createEvent(
    method: SupportedChannel,
    namespace: Namespace,
    data: ProtocolEventDataMap[SupportedChannel],
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
    } as ProtocolEvent;
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
    if (!isSupportedChannel(event.method) || !subscription.channels.has(event.method)) {
      return false;
    }

    if (subscription.namespaces == null || subscription.namespaces.length === 0) {
      return true;
    }

    return subscription.namespaces.some((prefix) => {
      if (!isPrefixMatch(event.params.namespace, prefix)) return false;
      if (subscription.depth == null) return true;
      return event.params.namespace.length - prefix.length <= subscription.depth;
    });
  }

  private buildTree(namespace: Namespace): AgentTreeNode {
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
    } satisfies AgentTreeNode;
  }

  private async handleSubscribe(
    command: ProtocolCommandByMethod<"subscription.subscribe">
  ) {
    const params = isRecord(command.params)
      ? (command.params as Partial<SubscribeParams>)
      : undefined;
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
      subscriptionId: subscription.id,
      replayedEvents: snapshot.length,
    } satisfies SubscribeResult);

    for (const event of snapshot) {
      await this.sendJson(event);
    }

    let cursor = snapshotSeq;
    while (true) {
      const drain = this.buffer.filter(
        (event) =>
          (event.seq ?? 0) > cursor && this.matchesSubscription(subscription, event)
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
    command: ProtocolCommandByMethod<"subscription.subscribe">,
    meta?: ProtocolResponseMeta
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = isRecord(command.params)
      ? (command.params as Partial<SubscribeParams>)
      : undefined;
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

    for (const event of snapshot) {
      await this.sendJson(event);
    }

    let cursor = snapshotSeq;
    while (true) {
      const drain = this.buffer.filter(
        (event) =>
          (event.seq ?? 0) > cursor && this.matchesSubscription(subscription, event)
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
      } satisfies SubscribeResult,
      meta
    );
  }

  private async handleUnsubscribe(
    command: ProtocolCommandByMethod<"subscription.unsubscribe">
  ) {
    const params = isRecord(command.params)
      ? (command.params as Partial<UnsubscribeParams>)
      : undefined;
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
    command: ProtocolCommandByMethod<"subscription.unsubscribe">,
    meta?: ProtocolResponseMeta
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = isRecord(command.params)
      ? (command.params as Partial<UnsubscribeParams>)
      : undefined;
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

  private async handleSetCapacity(
    command: ProtocolCommandByMethod<"flow.setCapacity">
  ) {
    const params = isRecord(command.params)
      ? (command.params as Partial<FlowCapacityParams>)
      : undefined;
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
    command: ProtocolCommandByMethod<"flow.setCapacity">,
    meta?: ProtocolResponseMeta
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = isRecord(command.params)
      ? (command.params as Partial<FlowCapacityParams>)
      : undefined;
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

  private async sendJson(message: ProtocolEvent | ProtocolSuccess | ProtocolError) {
    this.sendQueue = this.sendQueue
      .then(() => this.send(serialiseAsDict(message)))
      .catch(() => undefined);
    await this.sendQueue;
  }

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

