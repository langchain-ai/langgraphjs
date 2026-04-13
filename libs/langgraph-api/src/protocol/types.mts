import type {
  AgentResult,
  AgentStatus,
  AgentTreeNode,
  CapabilityAdvertisement,
  CheckpointsEvent,
  Channel,
  Command,
  CommandResponse,
  ContentBlockDeltaData,
  ContentBlockFinishData,
  ContentBlockStartData,
  CustomData,
  DebugEvent,
  ErrorCode,
  ErrorResponse,
  Event,
  MessageErrorData,
  MessagesData,
  FlowCapacityParams,
  MessageFinishData,
  MessageMetadata,
  MessageStartData,
  ModuleCapability,
  Namespace,
  ResponseMeta,
  RunInputParams,
  RunResult,
  SessionResult,
  StateGetResult,
  SubscribeParams,
  SubscribeResult,
  ToolErrorData,
  ToolFinishedData,
  ToolOutputDeltaData,
  ToolStartedData,
  ToolsData,
  TransportProfile,
  UnsubscribeParams,
  UpdatesEvent,
} from "@langchain/protocol";
import type { AuthContext } from "../auth/index.mjs";
import type { RunProtocolSession } from "./session/index.mjs";

/**
 * Raw events emitted by the existing LangGraph run stream implementation before
 * they are normalized into protocol-framed events.
 *
 * When {@link normalized} is `true` the payload has already been converted to
 * its protocol shape by the in-process streaming layer (`streamV2`) and should
 * be passed through without re-normalization.
 */
export type SourceStreamEvent = {
  id?: string;
  event: string;
  data: unknown;
  normalized?: boolean;
};

/**
 * Protocol version currently implemented by the API transport layer.
 */
export type ProtocolVersion = SessionResult["protocol_version"];

/**
 * Transport profiles currently exposed by the LangGraph API implementation.
 */
export type ProtocolTransportName = "websocket" | "sse-http";

export type SessionTransportName = ProtocolTransportName;

export type SessionTransportKind = ProtocolTransportName;

export type SupportedChannel = Extract<
  Channel,
  | "values"
  | "updates"
  | "messages"
  | "tools"
  | "custom"
  | "lifecycle"
  | "input"
  | "debug"
  | "checkpoints"
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
  debug: "debug";
  checkpoints: "checkpoints";
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
  CapabilityAdvertisement,
  CheckpointsEvent,
  ContentBlockDeltaData,
  ContentBlockFinishData,
  ContentBlockStartData,
  CustomData,
  DebugEvent,
  ErrorCode,
  FlowCapacityParams,
  MessageErrorData,
  MessageFinishData,
  MessageMetadata,
  MessagesData,
  MessageStartData,
  ModuleCapability,
  Namespace,
  RunInputParams,
  RunResult,
  SessionResult,
  StateGetResult,
  SubscribeParams,
  SubscribeResult,
  ToolErrorData,
  ToolFinishedData,
  ToolOutputDeltaData,
  ToolStartedData,
  ToolsData,
  TransportProfile,
  UnsubscribeParams,
  UpdatesEvent,
};

/**
 * Session targets supported by the API transport layer.
 *
 * Graph- and agent-targeted sessions start a run later via `run.input`, while
 * run-targeted sessions attach immediately to an existing run.
 */
export type ProtocolTarget =
  | {
      id: string;
    }
  | {
      kind: "run";
      id: string;
      threadId?: string;
    };

export type SessionTarget = ProtocolTarget;
export type ProtocolSessionTarget = ProtocolTarget;

/**
 * Normalized session-open request shape used internally by the HTTP and
 * WebSocket transport adapters.
 */
export type ProtocolOpenRequest = {
  protocol_version: string;
  preferred_transports?: string[];
  media_transfer_modes?: string[];
  target: ProtocolTarget;
  transport: ProtocolTransportName;
};

/**
 * Runtime state tracked for an active protocol session.
 *
 * This remains local to the API package even though protocol message types come
 * from `@langchain/protocol`, because it stores transport bindings, buffered
 * events, and deferred commands that are implementation-specific.
 */
export type SessionRecord = {
  sessionId: string;
  protocol_version: ProtocolVersion;
  transport: TransportProfile;
  auth?: AuthContext;
  target: ProtocolTarget;
  capabilities: CapabilityAdvertisement;
  seq: number;
  session?: RunProtocolSession;
  currentRunId?: string;
  currentThreadId?: string;
  sendEvent?: ((message: ProtocolEvent) => Promise<void> | void) | undefined;
  queuedEvents: ProtocolEvent[];
  pendingCommands: ProtocolCommand[];
};
