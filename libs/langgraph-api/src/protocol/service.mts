import { v7 as uuid7 } from "uuid";
import { getAssistantId } from "../graph/load.mjs";
import type {
  Run,
  RunsRepo,
  ThreadsRepo,
  StreamMode,
} from "../storage/types.mjs";
import type { RunCommand } from "../command.mjs";
import type {
  EventSinkEntry,
  EventSinkFilter,
  ProtocolCommand,
  ProtocolCommandByMethod,
  ProtocolError,
  ProtocolEvent,
  ProtocolSuccess,
  RunInputParams,
  RunResult,
  ThreadRecord,
  ProtocolTransportName,
  StateGetResult,
} from "./types.mjs";
import {
  isSupportedChannel,
  isRecord as isRecordInternal,
} from "./session/internal-types.mjs";
import { PROTOCOL_MESSAGES_STREAM_CONFIG_KEY } from "./constants.mjs";
import { RunProtocolSession } from "./session/index.mjs";

type ServiceBindings = {
  runs: RunsRepo;
  threads: ThreadsRepo;
};

/**
 * Transport-agnostic sink used to forward normalized protocol events into a
 * concrete delivery mechanism such as WebSocket or SSE.
 */
type EventSink = (message: ProtocolEvent) => Promise<void> | void;

const DEFAULT_RUN_STREAM_MODES: StreamMode[] = [
  "values",
  "updates",
  "messages",
  "tools",
  "custom",
  "tasks",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeRunInput = (value: unknown): RunInputParams => {
  if (isRecord(value)) {
    return {
      assistant_id:
        typeof value.assistant_id === "string" ? value.assistant_id : "",
      input: value.input,
      config: isRecord(value.config) ? value.config : undefined,
      metadata: isRecord(value.metadata) ? value.metadata : undefined,
    };
  }
  return {
    assistant_id: "",
    input: undefined,
    config: undefined,
    metadata: undefined,
  };
};

const normalizeKeys = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === "string")) return undefined;
  return value as string[];
};

/**
 * Thread-scoped connection registry and command dispatcher.
 *
 * In the thread-centric protocol, a `ThreadRecord` holds ephemeral
 * connection state for an active client interacting with a thread. The
 * thread itself is durable (lives in the checkpoint store); records are
 * created lazily on first interaction and dropped when all connections
 * close.
 */
export class ProtocolService {
  private readonly bindings: ServiceBindings;

  private readonly threads = new Map<string, ThreadRecord>();

  constructor(bindings: ServiceBindings) {
    this.bindings = bindings;
  }

  getThread(threadId: string) {
    return this.threads.get(threadId);
  }

  /**
   * Get or create the in-memory record for a thread. Records hold
   * ephemeral connection state (event sinks, current run session) and
   * are created on first use for any thread the client targets.
   */
  ensureThread(options: {
    threadId: string;
    transport: ProtocolTransportName;
    auth?: ThreadRecord["auth"];
    sendEvent?: EventSink;
  }): ThreadRecord {
    let record = this.threads.get(options.threadId);
    if (record == null) {
      record = {
        threadId: options.threadId,
        transport: options.transport,
        auth: options.auth,
        seq: 0,
        session: undefined,
        currentRunId: undefined,
        sendEvent: options.sendEvent,
        eventSinks: new Map(),
        queuedEvents: [],
        activeSubscriptions: [],
      };
      this.threads.set(options.threadId, record);
    } else if (options.sendEvent != null) {
      record.sendEvent = options.sendEvent;
    }
    return record;
  }

  /**
   * Attach a live transport consumer (WebSocket) and flush any buffered
   * events.
   */
  async attachEventSink(
    threadId: string,
    sendEvent: EventSink
  ): Promise<ThreadRecord> {
    const record = this.requireThread(threadId);
    record.sendEvent = sendEvent;
    for (const event of record.queuedEvents.splice(0)) {
      await sendEvent(event);
    }
    return record;
  }

  /**
   * Attach a filtered SSE event sink and replay buffered events that
   * match the filter.
   *
   * The sink is flagged `pendingReplay` while draining so that the live
   * `send` path skips it — preventing live events from interleaving with
   * the replay loop's awaits and producing out-of-order delivery.
   */
  async attachFilteredEventSink(
    threadId: string,
    sink: EventSinkEntry
  ): Promise<ThreadRecord> {
    const record = this.requireThread(threadId);
    sink.pendingReplay = true;
    record.eventSinks.set(sink.id, sink);
    try {
      // Walk the buffer by index so events pushed during an `await`
      // are still picked up in order before we unblock live delivery.
      let cursor = 0;
      while (cursor < record.queuedEvents.length) {
        const event = record.queuedEvents[cursor++];
        if (matchesSinkFilter(sink.filter, event)) {
          await sink.send(event);
        }
      }
    } finally {
      sink.pendingReplay = false;
    }
    return record;
  }

  /**
   * Remove an SSE event sink when the connection closes.
   */
  detachEventSink(threadId: string, sinkId: string): void {
    const record = this.threads.get(threadId);
    record?.eventSinks.delete(sinkId);
  }

  async closeThread(threadId: string) {
    const record = this.threads.get(threadId);
    if (record == null) return;
    await record.session?.close();
    this.threads.delete(threadId);
  }

  /**
   * Route a protocol command on a thread.
   */
  async handleCommand(
    threadId: string,
    command: ProtocolCommand
  ): Promise<ProtocolSuccess | ProtocolError> {
    const record = this.requireThread(threadId);

    switch (command.method) {
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
   * Start a new run, resume an interrupted run, or continue on the
   * thread depending on its current state.
   */
  private async handleRunInput(
    record: ThreadRecord,
    command: ProtocolCommandByMethod<"run.input">
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = normalizeRunInput(command.params);
    if (!params.assistant_id) {
      return this.error(
        command.id,
        "invalid_argument",
        "run.input requires an assistant_id."
      );
    }
    if (
      record.assistantId != null &&
      record.assistantId !== params.assistant_id
    ) {
      return this.error(
        command.id,
        "invalid_argument",
        `Thread ${record.threadId} is bound to assistant ${record.assistantId}; cannot run ${params.assistant_id}.`
      );
    }
    record.assistantId = params.assistant_id;

    const run = await this.createOrResumeRun(record, params);
    return {
      type: "success",
      id: command.id,
      result: { run_id: run.run_id } satisfies RunResult,
      meta: {
        thread_id: record.threadId,
        applied_through_seq: record.seq,
      },
    };
  }

  private async handleInputRespond(
    record: ThreadRecord,
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
    if (record.assistantId == null) {
      return this.error(
        command.id,
        "no_such_run",
        "Thread has no active assistant; call run.input first."
      );
    }

    const currentRun =
      record.currentRunId != null
        ? await this.bindings.runs.get(
            record.currentRunId,
            record.threadId,
            record.auth
          )
        : null;
    const hasPendingInterrupts = await this.hasPendingInterrupts(record);
    if (currentRun == null && !hasPendingInterrupts) {
      return this.error(
        command.id,
        "no_such_run",
        "No interrupted run is bound to this thread."
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
      assistant_id: record.assistantId,
      input: { [params.interrupt_id]: params.response },
      config: undefined,
      metadata: undefined,
    });

    return {
      type: "success",
      id: command.id,
      result: {},
      meta: {
        thread_id: record.threadId,
        applied_through_seq: record.seq,
      },
    };
  }

  private async createOrResumeRun(
    record: ThreadRecord,
    params: RunInputParams
  ) {
    const assistantId = getAssistantId(params.assistant_id);
    const currentRun =
      record.currentRunId != null
        ? await this.bindings.runs.get(
            record.currentRunId,
            record.threadId,
            record.auth
          )
        : null;
    const currentStatus = currentRun?.status;
    const hasPendingInterrupts =
      params.input != null
        ? await this.hasPendingInterruptsForThread(record.threadId, record.auth)
        : false;
    const isResume =
      params.input != null &&
      ((currentRun != null && currentStatus === "interrupted") ||
        hasPendingInterrupts);

    /**
     * We need to set the PROTOCOL_MESSAGES_STREAM_CONFIG_KEY to true to ensure
     * that the message stream uses the new protocol messages stream.
     */
    const runConfig = {
      ...params.config,
      configurable: {
        ...params.config?.configurable,
        thread_id: record.threadId,
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
        threadId: record.threadId,
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

    // For WebSocket transports, replay any sticky subscriptions onto the
    // newly-bound run session so cross-run subscribers keep receiving events.
    if (record.transport === "websocket") {
      for (const cmd of record.activeSubscriptions) {
        await record.session?.handleProtocolCommand(cmd, {
          thread_id: record.threadId,
          applied_through_seq: record.seq,
        });
      }
    }

    return run;
  }

  private async hasPendingInterrupts(record: ThreadRecord) {
    return this.hasPendingInterruptsForThread(record.threadId, record.auth);
  }

  private async hasPendingInterruptsForThread(
    threadId: string,
    auth: ThreadRecord["auth"]
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
    record: ThreadRecord,
    command: ProtocolCommandByMethod<"state.get">
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = isRecord(command.params)
      ? (command.params as Partial<
          ProtocolCommandByMethod<"state.get">["params"]
        >)
      : {};
    const values = await this.bindings.threads.state.get(
      { configurable: { thread_id: record.threadId } },
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
        thread_id: record.threadId,
        applied_through_seq: record.seq,
      },
    };
  }

  private async forwardToRunSession(
    record: ThreadRecord,
    command: ProtocolCommand
  ): Promise<ProtocolSuccess | ProtocolError> {
    const runSession = record.session;
    if (runSession == null) {
      return this.error(
        command.id,
        "no_such_run",
        "No active run is bound to this thread."
      );
    }
    if (
      command.method === "subscription.subscribe" &&
      record.transport === "websocket"
    ) {
      record.activeSubscriptions.push(command);
    }
    return await runSession.handleProtocolCommand(command, {
      thread_id: record.threadId,
      applied_through_seq: record.seq,
    });
  }

  /**
   * Bind the thread record to a concrete LangGraph run and forward
   * normalized protocol events to attached sinks.
   */
  private async ensureRunSession(record: ThreadRecord, run: Run) {
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

    const isSSE = record.transport === "sse-http";

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
      passthrough: isSSE,
      send: async (payload) => {
        const parsed = JSON.parse(payload) as ProtocolEvent;
        record.seq = Math.max(record.seq, parsed.seq ?? record.seq);
        if (isSSE) {
          // Always buffer events so late-attaching sinks can replay
          // matching history via attachFilteredEventSink(). Sinks with
          // `pendingReplay` are skipped here — their replay loop will
          // deliver this event in buffer order.
          record.queuedEvents.push(parsed);
          for (const sink of record.eventSinks.values()) {
            if (sink.pendingReplay) continue;
            if (matchesSinkFilter(sink.filter, parsed)) {
              await sink.send(parsed);
            }
          }
        } else if (record.sendEvent != null) {
          await record.sendEvent(parsed);
        } else {
          record.queuedEvents.push(parsed);
        }
      },
    });

    record.session = session;
    await session.start();
  }

  private requireThread(threadId: string) {
    const record = this.threads.get(threadId);
    if (record == null) {
      throw new Error(`No thread record found for ${threadId}`);
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

function isPrefixMatch(namespace: string[], prefix: string[]): boolean {
  if (prefix.length > namespace.length) return false;
  return prefix.every((segment, i) => namespace[i] === segment);
}

/**
 * Check whether a protocol event matches an SSE event sink filter.
 * Mirrors the subscription matching logic in {@link RunProtocolSession}.
 */
export function matchesSinkFilter(
  filter: EventSinkFilter,
  event: ProtocolEvent
): boolean {
  const channel: string | undefined =
    event.method === "input.requested"
      ? "input"
      : isSupportedChannel(event.method)
        ? event.method
        : undefined;
  if (channel == null) return false;

  let channelMatched = filter.channels.has(channel);
  if (!channelMatched && channel === "custom") {
    const params = event.params as Record<string, unknown>;
    const eventName =
      isRecordInternal(params.data) && typeof params.data.name === "string"
        ? params.data.name
        : undefined;
    if (eventName != null) {
      channelMatched = filter.channels.has(`custom:${eventName}`);
    }
  }
  if (!channelMatched) return false;

  if (filter.namespaces == null || filter.namespaces.length === 0) {
    return true;
  }

  return filter.namespaces.some((prefix) => {
    if (!isPrefixMatch(event.params.namespace, prefix)) return false;
    if (filter.depth == null) return true;
    return event.params.namespace.length - prefix.length <= filter.depth;
  });
}
