import { inferChannel, isPrefixMatch } from "@langchain/langgraph/stream";
import { v7 as uuid7 } from "@langchain/core/utils/uuid";
import { getAssistantId } from "../graph/load.mjs";
import type {
  Run,
  RunsRepo,
  ThreadsRepo,
  StreamMode,
  MultitaskStrategy,
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
  RunStartParams,
  RunResult,
  ThreadRecord,
  ProtocolTransportName,
  StateGetResult,
} from "./types.mjs";
import { applyAuthToRunConfig } from "../utils/run-auth.mjs";
import { PROTOCOL_STREAM_RUN_KEY } from "./constants.mjs";
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

// Concurrency strategies accepted on `run.start`, matching the four values
// the SDK's `multitaskStrategy` option can take.
const VALID_MULTITASK_STRATEGIES: readonly MultitaskStrategy[] = [
  "reject",
  "rollback",
  "interrupt",
  "enqueue",
];

// Legacy stream-endpoint default: queue new runs behind active ones instead
// of interrupting. Used when the caller omits `multitaskStrategy`.
export const DEFAULT_MULTITASK_STRATEGY: MultitaskStrategy = "enqueue";

/**
 * Resolve the per-run `multitaskStrategy`. Honor it when it is one of the
 * recognized strategies, otherwise return `undefined` so the caller falls
 * back to {@link DEFAULT_MULTITASK_STRATEGY}. Lenient by design (matches
 * the rest of `normalizeRunStart` and the Python reference server).
 */
export const normalizeMultitaskStrategy = (
  value: unknown
): MultitaskStrategy | undefined => {
  return typeof value === "string" &&
    (VALID_MULTITASK_STRATEGIES as readonly string[]).includes(value)
    ? (value as MultitaskStrategy)
    : undefined;
};

/**
 * `run.start` params after normalization. Extends the stock protocol
 * `RunStartParams` with the SDK's `multitaskStrategy` option, which the
 * server honors per-run (see {@link normalizeMultitaskStrategy}).
 *
 * Fork/time-travel targets are NOT carried here: they are provided
 * exclusively via `config.configurable.checkpoint_id` — the same field the
 * legacy run endpoints accept. The SDK folds its ergonomic `forkFrom`
 * option into that field client-side before sending `run.start`, so the
 * server only ever understands a single, legacy-compliant way to select
 * the checkpoint to replay from.
 */
type NormalizedRunStart = RunStartParams & {
  multitaskStrategy?: MultitaskStrategy;
  /**
   * State update applied alongside a resume, mapped to LangGraph's
   * `Command(update=...)`. Only set on the `input.respond` path
   * (resume), never on a fresh `run.start` — the protocol's
   * `RunStartParams` carries no `update` field.
   */
  update?: RunCommand["update"];
  /**
   * Directed jump applied alongside a resume, mapped to LangGraph's
   * `Command(goto=...)`. Like {@link update}, only set on the
   * `input.respond` (resume) path.
   */
  goto?: RunCommand["goto"];
};

const normalizeRunStart = (value: unknown): NormalizedRunStart => {
  if (isRecord(value)) {
    return {
      assistant_id:
        typeof value.assistant_id === "string" ? value.assistant_id : "",
      input: value.input,
      config: isRecord(value.config) ? value.config : undefined,
      metadata: isRecord(value.metadata) ? value.metadata : undefined,
      multitaskStrategy: normalizeMultitaskStrategy(value.multitaskStrategy),
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
        pendingSubscribes: [],
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
    // Resolve any still-parked WebSocket subscribes with `no_such_run` so
    // the transport's `onMessage` await unblocks and doesn't leak. The
    // thread is going away before a session was ever bound, so the client
    // will never receive a valid subscription_id anyway.
    const pending = record.pendingSubscribes.splice(0);
    for (const { command, resolve } of pending) {
      resolve({
        type: "error",
        id: command.id,
        error: "no_such_run",
        message: "Thread closed before a run was bound.",
      });
    }
    await record.session?.close();
    this.threads.delete(threadId);
  }

  /**
   * Route a protocol command on a thread.
   *
   * `subscription.subscribe` can resolve to `null` on ordered
   * transports (WebSocket) — see
   * `ProtocolSession.handleSubscribeForResponse` for the rationale.
   * Callers must treat `null` as "response already sent on the wire"
   * and skip any additional send.
   */
  async handleCommand(
    threadId: string,
    command: ProtocolCommand
  ): Promise<ProtocolSuccess | ProtocolError | null> {
    const record = this.requireThread(threadId);

    switch (command.method) {
      case "run.start":
        return await this.handleRunStart(record, command);
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
  private async handleRunStart(
    record: ThreadRecord,
    command: ProtocolCommandByMethod<"run.start">
  ): Promise<ProtocolSuccess | ProtocolError> {
    const params = normalizeRunStart(command.params);
    if (!params.assistant_id) {
      return this.error(
        command.id,
        "invalid_argument",
        "run.start requires an assistant_id."
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
    // Build the resume input map (`{ [interrupt_id]: response }`). The
    // SDK sends either a single `interrupt_id` / `response` or a
    // `responses` batch (several interrupts at the same checkpoint, which
    // must be resumed in one command) — the `InputRespondOne` /
    // `InputRespondMany` variants of `InputRespondParams`. Read leniently
    // to tolerate clients pinned to older bindings.
    const rawParams: Record<string, unknown> = isRecord(command.params)
      ? command.params
      : {};
    const resumeInput: Record<string, unknown> = {};
    if (Array.isArray(rawParams.responses)) {
      for (const entry of rawParams.responses) {
        if (!isRecord(entry) || typeof entry.interrupt_id !== "string") {
          return this.error(
            command.id,
            "invalid_argument",
            "input.respond responses entries require an interrupt_id."
          );
        }
        resumeInput[entry.interrupt_id] = entry.response;
      }
      if (Object.keys(resumeInput).length === 0) {
        return this.error(
          command.id,
          "invalid_argument",
          "input.respond requires at least one response."
        );
      }
    } else if (typeof rawParams.interrupt_id === "string") {
      resumeInput[rawParams.interrupt_id] = rawParams.response;
    } else {
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
        "Thread has no active assistant; call run.start first."
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

    // `config` / `metadata` are part of `InputRespondParams` (both the
    // `InputRespondOne` and `InputRespondMany` variants). The SDK's
    // `respond({ config, metadata })` forwards them on the `input.respond`
    // command so a resumed run can carry the same run config (model, user
    // context, …) and metadata (trigger source, test flags, …) a fresh
    // `run.start` would. Read them leniently — same posture as
    // `normalizeRunStart`.
    // `update` / `goto` are the optional state mutation and directed jump
    // applied in the same superstep as the resume (`InputRespondOne` /
    // `InputRespondMany`). The SDK's `respond({ update, goto })` forwards them
    // on the `input.respond` command; they are folded into
    // `Command(resume, update, goto)` by `createOrResumeRun`. Read leniently
    // (update: object or [key, value][] tuples; goto: node name, Send object,
    // or a list of either) — same posture as `config` / `metadata`.
    const update =
      isRecord(rawParams.update) || Array.isArray(rawParams.update)
        ? (rawParams.update as RunCommand["update"])
        : undefined;
    const goto =
      typeof rawParams.goto === "string" ||
      Array.isArray(rawParams.goto) ||
      isRecord(rawParams.goto)
        ? (rawParams.goto as RunCommand["goto"])
        : undefined;

    await this.createOrResumeRun(record, {
      assistant_id: record.assistantId,
      input: resumeInput,
      update,
      goto,
      config: isRecord(rawParams.config) ? rawParams.config : undefined,
      metadata: isRecord(rawParams.metadata) ? rawParams.metadata : undefined,
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
    params: NormalizedRunStart
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
     * Fork/time-travel replays from `config.configurable.checkpoint_id`
     * when the caller supplies it (the SDK folds its `forkFrom`
     * convenience option into this field client-side). Forwarded as-is so
     * the engine starts from the requested checkpoint instead of the
     * thread's latest state.
     */
    const runConfig = {
      ...params.config,
      configurable: {
        ...params.config?.configurable,
        thread_id: record.threadId,
      },
    };
    const userId = applyAuthToRunConfig(runConfig, record.auth);

    const runPayload = {
      assistant_id: assistantId,
      input: isResume ? null : params.input,
      command: isResume
        ? ({
            resume: params.input,
            // Apply an optional state update and/or directed jump in the
            // same superstep as the resume (HITL "push card into state +
            // resume" flows, or resume-and-redirect). Mapped straight onto
            // LangGraph's `Command(resume, update, goto)`, so the resumed
            // run produces a single checkpoint reflecting all of them.
            ...(params.update != null ? { update: params.update } : {}),
            ...(params.goto != null ? { goto: params.goto } : {}),
          } satisfies RunCommand)
        : undefined,
      config: runConfig,
      metadata: params.metadata,
      stream_mode: DEFAULT_RUN_STREAM_MODES,
      stream_subgraphs: true,
      stream_resumable: true,
      if_not_exists: "create" as const,
      // Honor the caller's `multitaskStrategy` (the SDK sends it on every
      // run.start), falling back to `enqueue` — the legacy stream-endpoint
      // default — when omitted. Matches the Python protocol-v2 server.
      multitask_strategy:
        params.multitaskStrategy ?? DEFAULT_MULTITASK_STRATEGY,
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
        [PROTOCOL_STREAM_RUN_KEY]: true,
      },
      {
        threadId: record.threadId,
        userId,
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

    // For WebSocket transports, register subscriptions on the session
    // BEFORE starting it so the success responses for parked and sticky
    // subscribes reach the client ahead of the session's first events.
    // `ensureRunSession` intentionally leaves the session unstarted; we
    // kick `session.start()` off after the drain below.
    //
    //   1. Replay sticky subscriptions from previous runs (empty on the
    //      first run). These must land first so that parked subs from
    //      the current run are appended at the end of
    //      `activeSubscriptions` and aren't double-applied here.
    //   2. Drain subscribes that arrived while `record.session` was
    //      still null. Their deferred `handleCommand` responses resolve
    //      here — the awaiting WebSocket `onMessage` handlers will flush
    //      `ws.send(success)` on the next microtask tick, which runs
    //      before `session.start()`'s first `pushEvent` completes its
    //      `await` chain. The client therefore has every subscription
    //      handle registered in `#subscriptions` by the time the run's
    //      initial lifecycle/values events arrive.
    if (record.transport === "websocket") {
      for (const cmd of record.activeSubscriptions) {
        await record.session?.handleProtocolCommand(
          cmd,
          {
            thread_id: record.threadId,
            applied_through_seq: record.seq,
          },
          { deliverResponseInline: true }
        );
      }
      await this.drainPendingSubscribes(record);
    }

    await record.session?.start();

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
  ): Promise<ProtocolSuccess | ProtocolError | null> {
    const runSession = record.session;
    if (runSession == null) {
      // WebSocket subscribes can arrive before the concurrent `run.start`
      // has bound a session (the SDK's root pump + legacy lifecycle/values
      // subs are opened eagerly so no events are missed on fast runs).
      // Park the response promise here and resolve it once the first
      // session is bound — see `drainPendingSubscribes`. Mirrors the
      // existing cross-run `activeSubscriptions` replay path.
      if (
        command.method === "subscription.subscribe" &&
        record.transport === "websocket"
      ) {
        return await new Promise<ProtocolSuccess | ProtocolError | null>(
          (resolve) => {
            record.pendingSubscribes.push({ command, resolve });
          }
        );
      }
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
    return await runSession.handleProtocolCommand(
      command,
      {
        thread_id: record.threadId,
        applied_through_seq: record.seq,
      },
      // WebSocket is an ordered single-channel transport: events and
      // the subscribe response share one wire. Emit the response
      // first via the session's send queue so the client registers
      // the subscription handle before the replay events arrive
      // (otherwise the per-sub fan-out drops them). HTTP `/commands`
      // keeps the default return-the-response behaviour so the
      // response lands in the HTTP body.
      record.transport === "websocket"
        ? { deliverResponseInline: true }
        : undefined
    );
  }

  /**
   * Drain any WebSocket subscribes that arrived before the first run
   * session was bound. Called from `createOrResumeRun` right after
   * {@link ensureRunSession} sets up `record.session`.
   *
   * Each parked command is forwarded to the freshly-bound session,
   * added to `activeSubscriptions` so it persists across subsequent
   * runs, and its deferred `handleCommand` promise is resolved so the
   * WebSocket handler can finally send the response.
   */
  private async drainPendingSubscribes(record: ThreadRecord): Promise<void> {
    if (record.session == null) return;
    if (record.pendingSubscribes.length === 0) return;
    const pending = record.pendingSubscribes.splice(0);
    for (const { command, resolve } of pending) {
      record.activeSubscriptions.push(command);
      const response = await record.session.handleProtocolCommand(
        command,
        {
          thread_id: record.threadId,
          applied_through_seq: record.seq,
        },
        // Parked subscribes are always WebSocket-origin (see
        // `forwardToRunSession`), so the response must land on the
        // wire before the soon-to-start session's first events.
        { deliverResponseInline: true }
      );
      resolve(response);
    }
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
    // NOTE: `session.start()` is intentionally deferred to the caller
    // (see {@link createOrResumeRun}). On WebSocket we need to drain any
    // parked `subscription.subscribe` commands onto the fresh session —
    // and let the client observe their success responses — BEFORE the
    // session begins emitting events. Otherwise the initial run events
    // are serialised ahead of the subscribe responses on the wire and
    // the client drops them because it hasn't registered the matching
    // subscription handles in `#subscriptions` yet.
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

/**
 * Check whether a protocol event matches an SSE event sink filter.
 *
 * Shares its channel inference and namespace matching with
 * {@link RunProtocolSession} (and the core streaming toolkit) so SSE and
 * WebSocket subscribers apply identical semantics, including dynamic
 * namespace-suffix normalization.
 */
export function matchesSinkFilter(
  filter: EventSinkFilter,
  event: ProtocolEvent
): boolean {
  if (filter.since != null && (event.seq ?? 0) <= filter.since) return false;

  // `inferChannel` resolves named custom channels to `custom:<name>`; a bare
  // `custom` filter still matches via the prefix check below.
  const channel = inferChannel(event);
  if (channel == null) return false;

  const channelMatched =
    filter.channels.has(channel) ||
    (channel.startsWith("custom:") && filter.channels.has("custom"));
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
