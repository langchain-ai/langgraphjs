import type {
  CapabilityAdvertisement,
  Channel,
  Command,
  CommandResponse,
  ErrorCode,
  ErrorResponse,
  Event,
  ModuleCapability,
  ResponseMeta,
  SessionResult,
  TransportProfile,
} from "@langchain/protocol";
import type { AuthContext } from "../auth/index.mjs";
import type { RunProtocolSession } from "./session.mjs";

/**
 * Raw events emitted by the existing LangGraph run stream implementation before
 * they are normalized into protocol-framed events.
 */
export type SourceStreamEvent = {
  id?: string;
  event: string;
  data: unknown;
};

/**
 * Protocol version currently implemented by the API transport layer.
 */
export type ProtocolVersion = SessionResult["protocolVersion"];

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
  | "debug"
  | "checkpoints"
  | "tasks"
>;

export type ProtocolResponseMeta = ResponseMeta;
export type ProtocolSuccess = CommandResponse;
export type ProtocolError = ErrorResponse;
export type ProtocolEvent = Event;
export type ProtocolCommand = Command;
export type { CapabilityAdvertisement, ErrorCode, ModuleCapability, TransportProfile };

/**
 * Session targets supported by the API transport layer.
 *
 * Graph- and agent-targeted sessions start a run later via `run.input`, while
 * run-targeted sessions attach immediately to an existing run.
 */
export type ProtocolTarget =
  | {
      kind: "graph" | "agent";
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
  protocolVersion: string;
  preferredTransports?: string[];
  mediaTransferModes?: string[];
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
  protocolVersion: ProtocolVersion;
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
