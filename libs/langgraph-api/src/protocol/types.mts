import type { AuthContext } from "../auth/index.mjs";
import type { Run, RunsRepo, ThreadsRepo } from "../storage/types.mjs";
import type { RunProtocolSession } from "./session.mjs";

export type ProtocolVersion = "0.3.0";

export type ProtocolTransportName = "websocket" | "sse-http";

export type SessionTransportName = ProtocolTransportName;

export type SessionTransportKind = ProtocolTransportName;

export type ProtocolMediaTransferMode =
  | "binary-frame"
  | "base64-inline"
  | "parallel-binary-channel"
  | "upgrade-to-websocket"
  | "artifact-only";

export type ProtocolResponseMeta = {
  sessionId?: string;
  appliedThroughSeq?: number;
};

export type SupportedChannel =
  | "values"
  | "updates"
  | "messages"
  | "tools"
  | "custom"
  | "lifecycle"
  | "debug"
  | "checkpoints"
  | "tasks";

export type AgentStatus =
  | "spawned"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export type ErrorCode =
  | "invalid_argument"
  | "unknown_command"
  | "unknown_error"
  | "unsupported_version"
  | "no_such_run"
  | "no_such_subscription"
  | "no_such_namespace"
  | "not_supported";

export type SourceStreamEvent = {
  id?: string;
  event: string;
  data: unknown;
};

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

export type ProtocolCommand = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

export type ProtocolSuccess = {
  type: "success";
  id: number;
  result: Record<string, unknown>;
  meta?: ProtocolResponseMeta;
};

export type ProtocolError = {
  type: "error";
  id: number | null;
  error: ErrorCode;
  message: string;
  stacktrace?: string;
  meta?: ProtocolResponseMeta;
};

export type ProtocolEvent = {
  type: "event";
  eventId: string;
  seq: number;
  method: string;
  params: {
    namespace: string[];
    timestamp: number;
    data: unknown;
    node?: string;
  };
};

export type TransportProfile = {
  name: ProtocolTransportName;
  eventOrdering: "connection-order" | "seq";
  commandDelivery: "in-band" | "request-response";
  mediaTransferModes: ProtocolMediaTransferMode[];
};

export type ModuleCapability = {
  name: string;
  channels?: string[];
  commands?: string[];
  events?: string[];
};

export type CapabilityAdvertisement = {
  modules: ModuleCapability[];
  payloadTypes?: string[];
  contentBlockTypes?: string[];
};

export type SessionOpenResult = {
  sessionId: string;
  protocolVersion: ProtocolVersion;
  transport: TransportProfile;
  capabilities: CapabilityAdvertisement;
  eventsUrl?: string;
  commandsUrl?: string;
};

export type ProtocolRepos = {
  runs: RunsRepo;
  threads: ThreadsRepo;
};

export type SessionRunBinding = {
  run: Run;
  threadId?: string;
};

export type SessionContext = {
  auth?: AuthContext;
  repos: ProtocolRepos;
  target: ProtocolTarget;
  transport: TransportProfile;
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
