import type {
  AgentResult,
  AgentStatus,
  AgentTreeNode,
  Channel,
  Checkpoint,
  CheckpointSource,
  Command,
  CommandResponse,
  ContentBlockDeltaData,
  ContentBlockFinishData,
  ContentBlockStartData,
  CustomData,
  ErrorCode,
  ErrorResponse,
  Event,
  LifecycleCause,
  MessageErrorData,
  MessageFinishData,
  MessageMetadata,
  MessageStartData,
  MessagesData,
  Namespace,
  ResponseMeta,
  RunStartParams,
  RunResult,
  StateGetResult,
  SubscribeParams,
  SubscribeResult,
  ToolErrorData,
  ToolFinishedData,
  ToolOutputDeltaData,
  ToolStartedData,
  ToolsData,
  UnsubscribeParams,
  UpdatesEvent,
} from "@langchain/protocol";

export type { LifecycleCause };
import type { AuthContext } from "../auth/index.mjs";
import type { RunProtocolSession } from "./session/index.mjs";

/**
 * Raw events emitted by the existing LangGraph run stream implementation
 * before they are normalized into protocol-framed events.
 *
 * The session emits two independent events per persisted checkpoint:
 * - `event: "values"` carries the full state snapshot on the `values`
 *   protocol channel.
 * - `event: "checkpoints"` carries the lightweight {@link Checkpoint}
 *   envelope on the dedicated `checkpoints` channel, paired with the
 *   adjacent `values` event by `(namespace, step)` so fork/time-travel
 *   UIs can subscribe without also paying for full-state payloads.
 *
 * When {@link normalized} is `true` the payload has already been converted
 * to its protocol shape by the in-process streaming layer
 * (`streamEvents(..., { version: "v3" })`) and should be passed through
 * without re-normalization.
 */
export type SourceStreamEvent = {
  id?: string;
  event: string;
  data: unknown;
  normalized?: boolean;
};

/**
 * Transport profiles currently exposed by the LangGraph API implementation.
 */
export type ProtocolTransportName = "websocket" | "sse-http";

export type SupportedChannel = Extract<
  Channel,
  | "values"
  | "updates"
  | "checkpoints"
  | "messages"
  | "tools"
  | "custom"
  | "lifecycle"
  | "input"
  | "tasks"
>;

export type EventMethodByChannel = {
  values: "values";
  updates: "updates";
  checkpoints: "checkpoints";
  messages: "messages";
  tools: "tools";
  custom: "custom";
  lifecycle: "lifecycle";
  input: "input.requested";
  tasks: "tasks";
};

export type ProtocolResponseMeta = ResponseMeta;
export type ProtocolSuccess = CommandResponse;
export type ProtocolError = ErrorResponse;
export type ProtocolEvent = Event;
export type ProtocolCommand = Command;
export type ProtocolCommandByMethod<Method extends ProtocolCommand["method"]> =
  Extract<ProtocolCommand, { method: Method }>;
export type ProtocolEventByMethod<Method extends SupportedChannel> = Extract<
  ProtocolEvent,
  { method: EventMethodByChannel[Method] }
>;
export type ProtocolEventDataByMethod<Method extends SupportedChannel> =
  ProtocolEventByMethod<Method>["params"]["data"];
export type {
  AgentResult,
  AgentStatus,
  AgentTreeNode,
  Checkpoint,
  CheckpointSource,
  ContentBlockDeltaData,
  ContentBlockFinishData,
  ContentBlockStartData,
  CustomData,
  ErrorCode,
  MessageErrorData,
  MessageFinishData,
  MessageMetadata,
  MessagesData,
  MessageStartData,
  Namespace,
  RunStartParams,
  RunResult,
  StateGetResult,
  SubscribeParams,
  SubscribeResult,
  ToolErrorData,
  ToolFinishedData,
  ToolOutputDeltaData,
  ToolStartedData,
  ToolsData,
  UnsubscribeParams,
  UpdatesEvent,
};

/**
 * Per-connection filter for SSE event sinks.
 *
 * Each SSE `POST .../events` connection carries its own filter so the server
 * can deliver only matching events without persisting subscription state.
 */
export type EventSinkFilter = {
  channels: Set<string>;
  namespaces?: string[][];
  depth?: number;
  since?: number;
};

/**
 * A single SSE event sink attached to a thread.
 *
 * `pendingReplay` is true while {@link ProtocolService.attachFilteredEventSink}
 * is draining buffered events into this sink. While true, the live `send`
 * callback must skip this sink so that the replay loop — not the live path —
 * owns strict in-order delivery.
 */
export type EventSinkEntry = {
  id: string;
  filter: EventSinkFilter;
  send: (message: ProtocolEvent) => Promise<void> | void;
  pendingReplay?: boolean;
};

/**
 * Runtime state tracked for an active thread connection.
 *
 * In the thread-centric protocol, threads are durable but ephemeral
 * connection state lives here: the active run session, attached SSE
 * sinks, and a queue of events waiting for a sink.
 */
export type ThreadRecord = {
  threadId: string;
  transport: ProtocolTransportName;
  auth?: AuthContext;
  assistantId?: string;
  seq: number;
  session?: RunProtocolSession;
  currentRunId?: string;
  /** WebSocket-only: single event delivery callback. */
  sendEvent?: ((message: ProtocolEvent) => Promise<void> | void) | undefined;
  /** SSE: per-connection filtered event sinks. */
  eventSinks: Map<string, EventSinkEntry>;
  /** Events buffered when no sink is attached yet. */
  queuedEvents: ProtocolEvent[];
  /** WebSocket-only: subscription commands replayed on new run sessions. */
  activeSubscriptions: ProtocolCommand[];
  /**
   * WebSocket-only: subscribes that arrived before a run session was bound.
   *
   * The SDK opens its root-pump subscription (and legacy lifecycle/values
   * subs) eagerly on thread creation so that no events are missed on fast
   * runs. On WebSocket those subscribes can race ahead of the concurrent
   * `run.start` and hit the service before `ensureRunSession` has bound a
   * session. Rather than rejecting them with `no_such_run`, we park each
   * command's response promise here and resolve it once the first session
   * is bound — mirroring the cross-run `activeSubscriptions` replay path.
   */
  pendingSubscribes: Array<{
    command: ProtocolCommand;
    resolve: (response: ProtocolSuccess | ProtocolError | null) => void;
  }>;
};
