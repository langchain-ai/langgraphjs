import type {
  BaseCheckpointSaver,
  BaseStore,
  Pregel,
} from "@langchain/langgraph";

import type { Metadata, Run } from "../../storage/types.mjs";
import type { ProtocolEvent } from "../../protocol/types.mjs";
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
  /**
   * Maximum number of events retained per thread for replay to a
   * late-attaching `/stream/events` subscriber. `undefined` (the
   * default) keeps every event for the life of the process. When set,
   * older events are evicted first; the single newest event is never
   * evicted, so a reconnecting subscriber never sees an empty buffer.
   */
  maxQueuedEvents?: number;
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

/**
 * In-memory record for an active embed thread connection.
 */
export interface EmbedThread {
  threadId: string;
  assistantId?: string;
  seq: number;
  runSession?: RunProtocolSession;
  /** Per-connection filtered event sinks (SSE). */
  eventSinks: Map<
    string,
    {
      id: string;
      filter: {
        channels: Set<string>;
        namespaces?: string[][];
        depth?: number;
        since?: number;
      };
      send: (message: ProtocolEvent) => Promise<void> | void;
      pendingReplay?: boolean;
      /**
       * Bypass the sink filter when true. Used for WebSocket transports
       * which deliver the full event stream to the connected client and
       * let the client filter locally.
       */
      unfiltered?: boolean;
    }
  >;
  queuedEvents: ProtocolEvent[];
  currentRun?: Run;
}
