import { v7 as uuid7 } from "uuid";
import { assertGraphExists, getAssistantId } from "../graph/load.mjs";
import type {
  Run,
  RunsRepo,
  ThreadsRepo,
  StreamMode,
} from "../storage/types.mjs";
import type { RunCommand } from "../command.mjs";
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
  SubscribeResult,
  TransportProfile,
  ModuleCapability,
} from "./types.mjs";
import { PROTOCOL_MESSAGES_STREAM_CONFIG_KEY } from "./constants.mjs";
import { RunProtocolSession } from "./session/index.mjs";

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
  "messages",
  "tools",
  "custom",
  "debug",
  "checkpoints",
  "tasks",
];

const STREAM_CHANNEL_CAPABILITIES: ModuleCapability[] = [
  {
    name: "values",
    channels: ["values"],
  },
  {
    name: "updates",
    channels: ["updates"],
  },
  {
    name: "messages",
    channels: ["messages"],
  },
  {
    name: "tools",
    channels: ["tools"],
  },
  {
    name: "custom",
    channels: ["custom"],
  },
  {
    name: "debug",
    channels: ["debug"],
  },
  {
    name: "checkpoints",
    channels: ["checkpoints"],
  },
  {
    name: "tasks",
    channels: ["tasks"],
  },
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
    name: "input",
    commands: ["input.respond"],
    channels: ["input"],
  },
  {
    name: "agent",
    commands: ["agent.getTree"],
    channels: ["lifecycle"],
    events: ["started", "running", "completed", "failed", "interrupted"],
  },
  ...STREAM_CHANNEL_CAPABILITIES,
  {
    name: "state",
    commands: ["state.get", "state.listCheckpoints", "state.fork"],
    channels: ["state"],
  },
];

const CONTENT_BLOCK_TYPES: NonNullable<
  CapabilityAdvertisement["content_block_types"]
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

const PAYLOAD_TYPES: NonNullable<CapabilityAdvertisement["payload_types"]> = [
  "LifecycleEvent",
  "MessagesEvent",
  "ToolsEvent",
  "ValuesEvent",
  "UpdatesEvent",
  "InputRequestedEvent",
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
  event_ordering: "seq",
  command_delivery:
    transportName === "websocket" ? "in-band" : "request-response",
  media_transfer_modes:
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
    if (!("kind" in options.target && options.target.kind === "run")) {
      assertGraphExists(options.target.id);
    }

    const sessionId = uuid7();
    const record: SessionRecord = {
      sessionId,
      protocol_version: PROTOCOL_VERSION,
      transport: defaultTransportProfile(options.transportName),
      auth: options.auth,
      target: options.target,
      capabilities: {
        modules: MODULE_CAPABILITIES.map((module) => ({ ...module })),
        payload_types: PAYLOAD_TYPES.slice(),
        content_block_types: CONTENT_BLOCK_TYPES.slice(),
      },
      seq: 0,
      session: undefined,
      currentRunId: undefined,
      currentThreadId: undefined,
      sendEvent: options.sendEvent,
      queuedEvents: [],
      pendingCommands: [],
      activeSubscriptions: [],
    };
    this.sessions.set(sessionId, record);
    if ("kind" in record.target && record.target.kind === "run") {
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
          session_id: sessionId,
          protocol_version: record.protocol_version,
          transport: record.transport,
          capabilities: record.capabilities,
        } satisfies SessionResult,
        meta: {
          session_id: sessionId,
          applied_through_seq: record.seq,
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
        session_id: record.sessionId,
        protocol_version: record.protocol_version,
        transport: record.transport,
        capabilities: record.capabilities,
      } satisfies SessionResult,
      meta: {
        session_id: record.sessionId,
        applied_through_seq: record.seq,
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
    const record = this.sessions.get(sessionId);
    if (record == null) return;
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
      command.method !== "input.respond" &&
      command.method !== "session.describe" &&
      command.method !== "session.close" &&
      command.method !== "state.get"
    ) {
      record.pendingCommands.push(command);
      return {
        type: "success",
        id: command.id,
        result:
          command.method === "subscription.subscribe"
            ? ({
                subscription_id: uuid7(),
                replayed_events: 0,
              } satisfies SubscribeResult)
            : {},
        meta: {
          session_id: record.sessionId,
          applied_through_seq: record.seq,
        },
      };
    }

    switch (command.method) {
      case "session.describe":
        return {
          type: "success",
          id: command.id,
          result: {
            session_id: record.sessionId,
            protocol_version: record.protocol_version,
            transport: record.transport,
            capabilities: record.capabilities,
          } satisfies SessionResult,
          meta: {
            session_id: record.sessionId,
            applied_through_seq: record.seq,
          },
        };
      case "session.close":
        await this.closeSession(sessionId);
        return {
          type: "success",
          id: command.id,
          result: {},
          meta: {
            session_id: sessionId,
            applied_through_seq: record.seq,
          },
        };
      case "run.input":
        return await this.handleRunInput(record, command);
      case "input.respond":
        return await this.handleInputRespond(record, command);
      case "state.get":
        return await this.handleStateGet(record, command);
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
    const params = normalizeRunInput(command.params);
    const run = await this.createOrResumeRun(record, params);

    return {
      type: "success",
      id: command.id,
      result: { run_id: run.run_id } satisfies RunResult,
      meta: {
        session_id: record.sessionId,
        applied_through_seq: record.seq,
      },
    };
  }

  private async handleInputRespond(
    record: SessionRecord,
    command: ProtocolCommandByMethod<"input.respond">
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = isRecord(command.params)
      ? (command.params as Partial<
          ProtocolCommandByMethod<"input.respond">["params"]
        >)
      : {};

    if (typeof params.interrupt_id !== "string") {
      return this.error(
        command.id,
        "invalid_argument",
        "input.respond requires an interrupt_id."
      );
    }

    const currentRun =
      record.currentRunId != null
        ? await this.bindings.runs.get(
            record.currentRunId,
            record.currentThreadId,
            record.auth
          )
        : null;
    const hasPendingInterrupts = await this.hasPendingInterrupts(record);
    if (currentRun == null && !hasPendingInterrupts) {
      return this.error(
        command.id,
        "no_such_run",
        "No interrupted run is bound to this session."
      );
    }
    if (!hasPendingInterrupts) {
      return this.error(
        command.id,
        "invalid_argument",
        "input.respond can only be used while the run is interrupted."
      );
    }

    await this.createOrResumeRun(record, {
      input: { [params.interrupt_id]: params.response },
      config: undefined,
      metadata: undefined,
    });

    return {
      type: "success",
      id: command.id,
      result: {},
      meta: {
        session_id: record.sessionId,
        applied_through_seq: record.seq,
      },
    };
  }

  private async createOrResumeRun(
    record: SessionRecord,
    params: RunInputParams
  ) {
    const targetId = record.target.id;
    const configuredThreadId = getThreadIdFromConfig(params.config);

    const currentRun =
      record.currentRunId != null
        ? await this.bindings.runs.get(
            record.currentRunId,
            record.currentThreadId,
            record.auth
          )
        : null;
    const assistantId = currentRun?.assistant_id ?? getAssistantId(targetId);
    const currentStatus = currentRun?.status;
    const resolvedThreadId = record.currentThreadId ?? configuredThreadId;
    const hasPendingInterrupts =
      params.input != null && resolvedThreadId != null
        ? await this.hasPendingInterruptsForThread(
            resolvedThreadId,
            record.auth
          )
        : false;
    const isResume =
      params.input != null &&
      ((currentRun != null && currentStatus === "interrupted") ||
        hasPendingInterrupts);

    /**
     * We need to set the PROTOCOL_MESSAGES_STREAM_CONFIG_KEY to true to ensure that
     * the message stream uses the new protocol messages stream.
     */
    const runConfig = {
      ...params.config,
      configurable: {
        ...params.config?.configurable,
        [PROTOCOL_MESSAGES_STREAM_CONFIG_KEY]: true,
      },
    };

    const runPayload = {
      assistant_id: assistantId,
      input: isResume ? null : params.input,
      command: isResume
        ? ({ resume: params.input } satisfies RunCommand)
        : undefined,
      config: runConfig,
      metadata: params.metadata,
      stream_mode: DEFAULT_RUN_STREAM_MODES,
      stream_subgraphs: true,
      stream_resumable: true,
      if_not_exists: "create" as const,
      multitask_strategy: "interrupt" as const,
    };

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

    await this.ensureRunSession(record, run);
    record.currentRunId = run.run_id;
    record.currentThreadId = run.thread_id;
    const pending = record.pendingCommands.splice(0);
    for (const cmd of pending) {
      if (cmd.method === "subscription.subscribe") {
        record.activeSubscriptions.push(cmd);
      }
      await record.session?.handleProtocolCommand(cmd, {
        session_id: record.sessionId,
        applied_through_seq: record.seq,
      });
    }

    return run;
  }

  private async hasPendingInterrupts(record: SessionRecord) {
    const threadId = record.currentThreadId;
    if (threadId == null) return false;
    return this.hasPendingInterruptsForThread(threadId, record.auth);
  }

  private async hasPendingInterruptsForThread(
    threadId: string,
    auth: SessionRecord["auth"]
  ) {
    try {
      const state = await this.bindings.threads.state.get(
        { configurable: { thread_id: threadId } },
        { subgraphs: true },
        auth
      );
      return (state.tasks ?? []).some(
        (task) => Array.isArray(task.interrupts) && task.interrupts.length > 0
      );
    } catch {
      return false;
    }
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
      ? (command.params as Partial<
          ProtocolCommandByMethod<"state.get">["params"]
        >)
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
        session_id: record.sessionId,
        applied_through_seq: record.seq,
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
    if (command.method === "subscription.subscribe") {
      record.activeSubscriptions.push(command);
    }
    return await runSession.handleProtocolCommand(command, {
      session_id: record.sessionId,
      applied_through_seq: record.seq,
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
      getThreadState: async () =>
        await this.bindings.threads.state.get(
          { configurable: { thread_id: run.thread_id } },
          { subgraphs: true },
          record.auth
        ),
      source,
      startSeq: record.seq,
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

    for (const cmd of record.activeSubscriptions) {
      await session.handleProtocolCommand(cmd, {
        session_id: record.sessionId,
        applied_through_seq: record.seq,
      });
    }
  }

  private requireSession(sessionId: string) {
    const record = this.sessions.get(sessionId);
    if (record == null) {
      throw new Error(`No session found for ${sessionId}`);
    }
    return record;
  }

  error(
    id: number | null,
    code: ProtocolError["error"],
    message: string
  ): ProtocolError {
    return {
      type: "error",
      id,
      error: code,
      message,
    };
  }
}
