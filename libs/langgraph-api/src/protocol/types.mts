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

export type SourceStreamEvent = {
  id?: string;
  event: string;
  data: unknown;
};

export type ProtocolVersion = SessionResult["protocolVersion"];

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

export type ProtocolOpenRequest = {
  protocolVersion: string;
  preferredTransports?: string[];
  mediaTransferModes?: string[];
  target: ProtocolTarget;
  transport: ProtocolTransportName;
};

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
