import type {
  AgentResult,
  AgentStatus,
  AgentTreeNode,
  Channel,
  Command,
  CommandResponse,
  ContentBlockDeltaData,
  ContentBlockFinishData,
  ContentBlockStartData,
  CustomData,
  ErrorCode,
  ErrorResponse,
  Event,
  FlowCapacityParams,
  FlowStrategy,
  MessageErrorData,
  MessageFinishData,
  MessageMetadata,
  MessageStartData,
  MessagesData,
  Namespace,
  ResponseMeta,
  RunInputParams,
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
  ValuesCheckpoint,
} from "@langchain/protocol";
import type { AuthContext } from "../auth/index.mjs";
import type { RunProtocolSession } from "./session/index.mjs";

/**
 * Raw events emitted by the existing LangGraph run stream implementation before
 * they are normalized into protocol-framed events.
 *
 * When {@link normalized} is `true` the payload has already been converted to
 * its protocol shape by the in-process streaming layer (`stream_experimental`)
 * and should be passed through without re-normalization.
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
  ContentBlockDeltaData,
  ContentBlockFinishData,
  ContentBlockStartData,
  CustomData,
  ErrorCode,
  FlowCapacityParams,
  FlowStrategy,
  MessageErrorData,
  MessageFinishData,
  MessageMetadata,
  MessagesData,
  MessageStartData,
  Namespace,
  RunInputParams,
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
  ValuesCheckpoint,
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
};
