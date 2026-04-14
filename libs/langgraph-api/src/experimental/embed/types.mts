import type {
  BaseCheckpointSaver,
  BaseStore,
  Pregel,
} from "@langchain/langgraph";

import type { Metadata, Run } from "../../storage/types.mjs";
import type {
  ProtocolCommand,
  ProtocolEvent,
  ProtocolTarget,
} from "../../protocol/types.mjs";
import type { RunProtocolSession } from "../../protocol/session/index.mjs";

export type AnyPregel = Pregel<any, any, any, any, any>;

/**
 * Shared context passed to each embed route module so that route handlers
 * can access graphs, thread storage, and the checkpointer without closures.
 */
export interface EmbedRouteContext {
  graph: Record<string, AnyPregel>;
  threads: ThreadSaver;
  checkpointer: BaseCheckpointSaver;
  store?: BaseStore;
  getGraph: (graphId: string) => Promise<AnyPregel>;
}

export interface Thread {
  thread_id: string;
  metadata: Metadata;
}

/**
 * Interface for storing and retrieving threads used by `createEmbedServer`.
 * @experimental Does not follow semver.
 */
export interface ThreadSaver {
  get: (id: string) => Promise<Thread>;

  set: (
    id: string,
    options: { kind: "put" | "patch"; metadata?: Metadata }
  ) => Promise<Thread>;
  delete: (id: string) => Promise<void>;

  search?: (options: {
    metadata?: Metadata;
    limit: number;
    offset: number;
    sortBy: "created_at" | "updated_at";
    sortOrder: "asc" | "desc";
  }) => AsyncGenerator<{ thread: Thread; total: number }>;
}

export type RunStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "interrupted";

/** Per-thread run queue state for enqueue support. */
export interface ThreadRunState {
  activeRunId: string | null;
  pendingRuns: Run[];
}

export interface EmbedSession {
  sessionId: string;
  target: ProtocolTarget;
  seq: number;
  runSession?: RunProtocolSession;
  sendEvent?: (message: ProtocolEvent) => Promise<void> | void;
  queuedEvents: ProtocolEvent[];
  pendingCommands: ProtocolCommand[];
  currentRun?: Run;
  currentThreadId?: string;
}
