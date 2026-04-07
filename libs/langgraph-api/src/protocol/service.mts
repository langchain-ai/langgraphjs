import { v7 as uuid7 } from "uuid";
import { getAssistantId } from "../graph/load.mjs";
import type {
  Run,
  RunsRepo,
  ThreadsRepo,
  StreamMode,
} from "../storage/types.mjs";
import type { RunCommand } from "../command.mjs";
import { store as graphStore } from "../storage/store.mjs";
import type {
  CapabilityAdvertisement,
  ProtocolCommand,
  ProtocolCommandByMethod,
  ProtocolError,
  ProtocolEvent,
  ProtocolSuccess,
  ProtocolVersion,
  RunInputParams,
  RunResult,
  SessionRecord,
  SessionResult,
  ProtocolTarget,
  ProtocolTransportName,
  StateGetResult,
  StoreItem,
  StorePutParams,
  StoreSearchParams,
  StoreSearchResult,
  SubscribeResult,
  TransportProfile,
  ModuleCapability,
} from "./types.mjs";
import { RunProtocolSession } from "./session.mjs";

type SessionBindings = {
  runs: RunsRepo;
  threads: ThreadsRepo;
};

/**
 * Transport-agnostic sink used to forward normalized protocol events into a
 * concrete delivery mechanism such as WebSocket or SSE.
 */
type EventSink = (message: ProtocolEvent) => Promise<void> | void;

const PROTOCOL_VERSION: ProtocolVersion = "0.3.0";
const DEFAULT_RUN_STREAM_MODES: StreamMode[] = [
  "values",
  "updates",
  "messages-tuple",
  "tools",
  "custom",
  "debug",
  "checkpoints",
  "tasks",
];

const MODULE_CAPABILITIES: ModuleCapability[] = [
  {
    name: "session",
    commands: ["session.open", "session.describe", "session.close"],
  },
  {
    name: "run",
    commands: ["run.input"],
  },
  {
    name: "subscription",
    commands: [
      "subscription.subscribe",
      "subscription.unsubscribe",
      "subscription.reconnect",
    ],
  },
  {
    name: "agent",
    commands: ["agent.getTree"],
    channels: ["lifecycle"],
    events: ["spawned", "running", "completed", "failed", "interrupted"],
  },
  {
    name: "state",
    commands: ["state.get", "state.storeSearch", "state.storePut"],
    channels: ["state"],
  },
];

const CONTENT_BLOCK_TYPES: NonNullable<
  CapabilityAdvertisement["contentBlockTypes"]
> = [
  "text",
  "reasoning",
  "tool_call",
  "tool_call_chunk",
  "invalid_tool_call",
  "server_tool_call",
  "server_tool_call_chunk",
  "server_tool_call_result",
  "image",
  "audio",
  "video",
  "file",
  "non_standard",
];

const PAYLOAD_TYPES: NonNullable<CapabilityAdvertisement["payloadTypes"]> = [
  "LifecycleEvent",
  "MessagesEvent",
  "ToolsEvent",
  "ValuesEvent",
  "UpdatesEvent",
  "CustomEvent",
  "DebugEvent",
  "CheckpointsEvent",
  "TasksEvent",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const defaultTransportProfile = (
  transportName: ProtocolTransportName
): TransportProfile => ({
  name: transportName,
  eventOrdering: "seq",
  commandDelivery:
    transportName === "websocket" ? "in-band" : "request-response",
  mediaTransferModes:
    transportName === "websocket"
      ? ["artifact-only"]
      : ["artifact-only", "upgrade-to-websocket"],
});

const normalizeRunInput = (value: unknown): RunInputParams => {
  if (isRecord(value)) {
    return {
      input: value.input,
      config: isRecord(value.config) ? value.config : undefined,
      metadata: isRecord(value.metadata) ? value.metadata : undefined,
    };
  }
  return {
    input: undefined,
    config: undefined,
    metadata: undefined,
  };
};

const getThreadIdFromConfig = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const configurable = value.configurable;
  if (!isRecord(configurable)) return undefined;
  return typeof configurable.thread_id === "string"
    ? configurable.thread_id
    : undefined;
};

const normalizeStoreItem = (item: any): StoreItem => ({
  namespace: item.namespace,
  key: item.key,
  value: item.value,
  ...(item.createdAt ? { createdAt: item.createdAt } : {}),
  ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
});

const normalizeStoreNamespace = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === "string")) return undefined;
  return value as string[];
};

const normalizeKeys = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === "string")) return undefined;
  return value as string[];
};

/**
 * Shared session registry and command dispatcher for protocol transports.
 *
 * This service owns the session lifecycle that sits above individual runs. It
 * allows graph/agent-targeted sessions to queue protocol commands before a run
 * exists, then replays those commands into the bound run session once
 * `run.input` starts work.
 */
export class ProtocolService {
  private readonly bindings: SessionBindings;

  private readonly sessions = new Map<string, SessionRecord>();

  constructor(bindings: SessionBindings) {
    this.bindings = bindings;
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  deleteSession(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  /**
   * Create a new protocol session and bind it immediately when the target is an
   * existing run.
   */
  async openSession(options: {
    transportName: ProtocolTransportName;
    auth: SessionRecord["auth"];
    target: ProtocolTarget;
    sendEvent?: EventSink;
  }): Promise<{
    record: SessionRecord;
    response: ProtocolSuccess;
  }> {
    const sessionId = uuid7();
    const record: SessionRecord = {
      sessionId,
      protocolVersion: PROTOCOL_VERSION,
      transport: defaultTransportProfile(options.transportName),
      auth: options.auth,
      target: options.target,
      capabilities: {
        modules: MODULE_CAPABILITIES.map((module) => ({ ...module })),
        payloadTypes: PAYLOAD_TYPES.slice(),
        contentBlockTypes: CONTENT_BLOCK_TYPES.slice(),
      },
      seq: 0,
      session: undefined,
      currentRunId: undefined,
      currentThreadId: undefined,
      sendEvent: options.sendEvent,
      queuedEvents: [],
      pendingCommands: [],
    };
    this.sessions.set(sessionId, record);
    if (record.target.kind === "run") {
      const run = await this.bindings.runs.get(
        record.target.id,
        record.target.threadId,
        record.auth
      );
      if (run == null) {
        this.sessions.delete(sessionId);
        throw new Error(`No run found for target ${record.target.id}`);
      }
      record.currentRunId = run.run_id;
      record.currentThreadId = run.thread_id;
      await this.ensureRunSession(record, run);
    }
    return {
      record,
      response: {
        type: "success",
        id: 0,
        result: {
          sessionId,
          protocolVersion: record.protocolVersion,
          transport: record.transport,
          capabilities: record.capabilities,
        } satisfies SessionResult,
        meta: {
          sessionId,
          appliedThroughSeq: record.seq,
        },
      },
    };
  }

  describeSession(sessionId: string): ProtocolSuccess {
    const record = this.requireSession(sessionId);
    return {
      type: "success",
      id: 0,
      result: {
        sessionId: record.sessionId,
        protocolVersion: record.protocolVersion,
        transport: record.transport,
        capabilities: record.capabilities,
      } satisfies SessionResult,
      meta: {
        sessionId: record.sessionId,
        appliedThroughSeq: record.seq,
      },
    };
  }

  /**
   * Attach a live transport consumer and flush any events buffered before the
   * consumer connected.
   */
  async attachEventSink(
    sessionId: string,
    sendEvent: EventSink
  ): Promise<SessionRecord> {
    const record = this.requireSession(sessionId);
    record.sendEvent = sendEvent;
    for (const event of record.queuedEvents.splice(0)) {
      await sendEvent(event);
    }
    return record;
  }

  async closeSession(sessionId: string) {
    const record = this.requireSession(sessionId);
    await record.session?.close();
    this.sessions.delete(sessionId);
  }

  /**
   * Route a protocol command through the shared session core.
   *
   * Commands that need an active run session are queued for graph/agent targets
   * until `run.input` creates and binds a run.
   */
  async handleCommand(
    sessionId: string,
    command: ProtocolCommand
  ): Promise<ProtocolSuccess | ProtocolError> {
    const record = this.requireSession(sessionId);
    if (
      record.session == null &&
      command.method !== "run.input" &&
      command.method !== "session.describe" &&
      command.method !== "session.close" &&
      command.method !== "state.get" &&
      command.method !== "state.storeSearch" &&
      command.method !== "state.storePut"
    ) {
      record.pendingCommands.push(command);
      return {
        type: "success",
        id: command.id,
        result:
          command.method === "subscription.subscribe"
            ? {
                subscriptionId: uuid7(),
                replayedEvents: 0,
              } satisfies SubscribeResult
            : {},
        meta: {
          sessionId: record.sessionId,
          appliedThroughSeq: record.seq,
        },
      };
    }

    switch (command.method) {
      case "session.describe":
        return {
          type: "success",
          id: command.id,
          result: {
            sessionId: record.sessionId,
            protocolVersion: record.protocolVersion,
            transport: record.transport,
            capabilities: record.capabilities,
          } satisfies SessionResult,
          meta: {
            sessionId: record.sessionId,
            appliedThroughSeq: record.seq,
          },
        };
      case "session.close":
        await this.closeSession(sessionId);
        return {
          type: "success",
          id: command.id,
          result: {},
          meta: {
            sessionId,
            appliedThroughSeq: record.seq,
          },
        };
      case "run.input":
        return await this.handleRunInput(record, command);
      case "state.get":
        return await this.handleStateGet(record, command);
      case "state.storeSearch":
        return await this.handleStoreSearch(record, command);
      case "state.storePut":
        return await this.handleStorePut(record, command);
      default:
        return await this.forwardToRunSession(record, command);
    }
  }

  /**
   * Start a new run, resume an interrupted run, or continue on the current
   * thread depending on the session's bound state.
   */
  private async handleRunInput(
    record: SessionRecord,
    command: ProtocolCommandByMethod<"run.input">
  ): Promise<ProtocolSuccess | ProtocolError> {
    const targetId = record.target.id;
    const assistantId = getAssistantId(targetId);
    const params = normalizeRunInput(command.params);
    const configuredThreadId = getThreadIdFromConfig(params.config);

    const currentRun =
      record.currentRunId != null
        ? await this.bindings.runs.get(
            record.currentRunId,
            record.currentThreadId,
            record.auth
          )
        : null;

    const currentStatus = currentRun?.status;
    const isResume =
      currentRun != null && currentStatus === "interrupted" && params.input != null;

    const runPayload = {
      assistant_id: assistantId,
      input: isResume ? null : params.input,
      command: isResume ? ({ resume: params.input } satisfies RunCommand) : undefined,
      config: params.config,
      metadata: params.metadata,
      stream_mode: DEFAULT_RUN_STREAM_MODES,
      stream_subgraphs: true,
      stream_resumable: true,
      if_not_exists: "create" as const,
      multitask_strategy: "interrupt" as const,
    };
    console.log(
      "[protocol run payload]",
      JSON.stringify({
        assistantId,
        sessionId: record.sessionId,
        runPayload,
      })
    );

    const [run] = await this.bindings.runs.put(
      uuid7(),
      assistantId,
      {
        input: runPayload.input,
        command: runPayload.command,
        config: runPayload.config,
        context: undefined,
        stream_mode: runPayload.stream_mode,
        interrupt_before: undefined,
        interrupt_after: undefined,
        temporary: false,
        subgraphs: runPayload.stream_subgraphs,
        resumable: runPayload.stream_resumable,
      },
      {
        threadId: record.currentThreadId ?? configuredThreadId,
        metadata: runPayload.metadata,
        status: "pending",
        multitaskStrategy: runPayload.multitask_strategy,
        preventInsertInInflight: false,
        ifNotExists: runPayload.if_not_exists,
      },
      record.auth
    );
    console.log(
      "[protocol stored run kwargs]",
      JSON.stringify({
        sessionId: record.sessionId,
        runId: run?.run_id,
        kwargs: run?.kwargs,
      })
    );

    record.currentRunId = run.run_id;
    record.currentThreadId = run.thread_id;
    await this.ensureRunSession(record, run);
    for (const pending of record.pendingCommands.splice(0)) {
      await record.session?.handleProtocolCommand(pending, {
        sessionId: record.sessionId,
        appliedThroughSeq: record.seq,
      });
    }

    return {
      type: "success",
      id: command.id,
      result: { runId: run.run_id } satisfies RunResult,
      meta: {
        sessionId: record.sessionId,
        appliedThroughSeq: record.seq,
      },
    };
  }

  private async handleStateGet(
    record: SessionRecord,
    command: ProtocolCommandByMethod<"state.get">
  ): Promise<ProtocolSuccess | ProtocolError> {
    if (record.currentThreadId == null) {
      return this.error(
        command.id,
        "no_such_run",
        "No active run is bound to this session."
      );
    }
    const params = isRecord(command.params)
      ? (command.params as Partial<ProtocolCommandByMethod<"state.get">["params"]>)
      : {};
    const values = await this.bindings.threads.state.get(
      { configurable: { thread_id: record.currentThreadId } },
      { subgraphs: true },
      record.auth
    );
    const checkpointConfig = isRecord(values.config?.configurable)
      ? values.config.configurable
      : undefined;
    const checkpoint: StateGetResult["checkpoint"] =
      checkpointConfig != null &&
      typeof checkpointConfig.checkpoint_id === "string"
        ? {
            id: checkpointConfig.checkpoint_id,
            ...(typeof checkpointConfig.checkpoint_ns === "string"
              ? { ns: checkpointConfig.checkpoint_ns }
              : {}),
          }
        : undefined;
    const requestedKeys = normalizeKeys(params.keys);
    const filteredValues =
      requestedKeys == null
        ? values.values
        : Object.fromEntries(
            Object.entries(values.values).filter(([key]) =>
              requestedKeys.includes(key)
            )
          );
    return {
      type: "success",
      id: command.id,
      result: {
        values: filteredValues,
        checkpoint,
      } satisfies StateGetResult,
      meta: {
        sessionId: record.sessionId,
        appliedThroughSeq: record.seq,
      },
    };
  }

  private async handleStoreSearch(
    record: SessionRecord,
    command: ProtocolCommandByMethod<"state.storeSearch">
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = isRecord(command.params)
      ? (command.params as Partial<StoreSearchParams>)
      : {};
    const storeNamespace = normalizeStoreNamespace(params.storeNamespace);
    if (storeNamespace == null) {
      return this.error(
        command.id,
        "invalid_argument",
        "state.storeSearch requires storeNamespace as a string array."
      );
    }

    const items = await graphStore.search(storeNamespace, {
      query: typeof params.query === "string" ? params.query : undefined,
      filter: isRecord(params.filter) ? params.filter : undefined,
      limit: typeof params.limit === "number" ? params.limit : 10,
      offset: typeof params.offset === "number" ? params.offset : 0,
    });

    return {
      type: "success",
      id: command.id,
      result: {
        items: items.map(normalizeStoreItem),
      } satisfies StoreSearchResult,
      meta: {
        sessionId: record.sessionId,
        appliedThroughSeq: record.seq,
      },
    };
  }

  private async handleStorePut(
    record: SessionRecord,
    command: ProtocolCommandByMethod<"state.storePut">
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = isRecord(command.params)
      ? (command.params as Partial<StorePutParams>)
      : {};
    const storeNamespace = normalizeStoreNamespace(params.storeNamespace);
    const key = params.key;
    if (storeNamespace == null || typeof key !== "string") {
      return this.error(
        command.id,
        "invalid_argument",
        "state.storePut requires storeNamespace and key."
      );
    }

    await graphStore.put(storeNamespace, key, isRecord(params.value) ? params.value : {});

    return {
      type: "success",
      id: command.id,
      result: {},
      meta: {
        sessionId: record.sessionId,
        appliedThroughSeq: record.seq,
      },
    };
  }

  private async forwardToRunSession(
    record: SessionRecord,
    command: ProtocolCommand
  ): Promise<ProtocolSuccess | ProtocolError> {
    const runSession = record.session;
    if (runSession == null) {
      return this.error(
        command.id,
        "no_such_run",
        "No active run is bound to this session."
      );
    }
    return await runSession.handleProtocolCommand(command, {
      sessionId: record.sessionId,
      appliedThroughSeq: record.seq,
    });
  }

  /**
   * Bind the shared session to a concrete LangGraph run and forward that run's
   * normalized protocol events into the transport-level session buffer.
   */
  private async ensureRunSession(record: SessionRecord, run: Run) {
    if (record.session != null && record.currentRunId === run.run_id) return;

    await record.session?.close();

    const source = this.bindings.runs.stream.join(
      run.run_id,
      run.thread_id,
      {
        signal: undefined,
        cancelOnDisconnect: false,
        lastEventId: run.kwargs.resumable ? "-1" : undefined,
      },
      record.auth
    );

    const session = new RunProtocolSession({
      runId: run.run_id,
      threadId: run.thread_id,
      auth: record.auth,
      initialRun: run,
      getRun: () =>
        this.bindings.runs.get(run.run_id, run.thread_id, record.auth),
      source,
      send: async (payload) => {
        const parsed = JSON.parse(payload) as ProtocolEvent;
        record.seq = Math.max(record.seq, parsed.seq ?? record.seq);
        if (record.sendEvent != null) {
          await record.sendEvent(parsed);
        } else {
          record.queuedEvents.push(parsed);
        }
      },
    });

    record.session = session;
    await session.start();
  }

  private requireSession(sessionId: string) {
    const record = this.sessions.get(sessionId);
    if (record == null) {
      throw new Error(`No session found for ${sessionId}`);
    }
    return record;
  }

  error(id: number | null, code: ProtocolError["error"], message: string): ProtocolError {
    return {
      type: "error",
      id,
      error: code,
      message,
    };
  }
}
