import type { CommandResponse, ErrorResponse } from "@langchain/protocol";
import type { AsyncCaller } from "../../../utils/async_caller.js";
import type { IdleReconnectMode } from "../../../utils/stream.js";

export type ProtocolRequestHook = (
  url: URL,
  init: RequestInit
) => Promise<RequestInit> | RequestInit;

/**
 * A protocol request path. Either a fixed string (bound to a specific
 * thread) or a function of the active threadId. Use the function form
 * when a single adapter instance must follow {@link TransportAdapter.setThreadId}
 * re-binds — e.g. lazy thread creation, where the id is only known after
 * the first `submit()`.
 */
export type ProtocolPath = string | ((threadId: string) => string);

export interface ProtocolTransportPaths {
  commands?: ProtocolPath;
  stream?: ProtocolPath;
  /** `GET` path for thread-state hydration. Defaults to `/threads/:threadId/state`. */
  state?: ProtocolPath;
}

export interface ProtocolSseTransportOptions {
  apiUrl: string;
  /**
   * Thread this transport targets. Optional: omit to construct an
   * unbound transport and bind later via {@link TransportAdapter.setThreadId}
   * (the framework does this from `client.threads.stream`). Requests throw
   * until a thread is bound.
   */
  threadId?: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: ProtocolRequestHook;
  fetch?: typeof fetch;
  fetchFactory?: () => typeof fetch | Promise<typeof fetch>;
  /**
   * When set, command and SSE subscription HTTP requests are executed
   * through {@link AsyncCaller} (retries, concurrency). Typically wired
   * from {@link BaseClient} via `client.threads.stream()`.
   */
  asyncCaller?: AsyncCaller;
  paths?: ProtocolTransportPaths;
  /**
   * Maximum reconnect attempts after an unexpected SSE disconnect.
   * Defaults to 5. Set to 0 to disable automatic reconnection.
   */
  maxReconnectAttempts?: number;
  /**
   * Idle-reconnect policy guarding against half-open sockets that hang
   * indefinitely with no error or close (e.g. a platform revision rollover
   * that hard-kills the serving pod). On idle the underlying read is aborted,
   * which the reconnect loop treats like any other disconnect, re-subscribing
   * with `since` from the last seen sequence.
   *
   * - `"auto"`: arm only once the server's SSE keep-alive heartbeats
   *   (LangGraph Platform: `: heartbeat` every ~5s) are observed, sizing the
   *   window from their cadence. Independent of agent activity; stays dormant
   *   on heartbeat-less servers.
   * - a `number`: a fixed idle window in milliseconds.
   * - `0`: disables it.
   *
   * @see {@link IdleReconnectMode}
   */
  idleReconnect?: IdleReconnectMode;
  /** Called before each SSE reconnect attempt (after backoff delay). */
  onReconnect?: (options: { attempt: number; cause: unknown }) => void;
  /**
   * Backoff before each SSE reconnect attempt. Defaults to
   * {@link webSocketReconnectDelayMs} from `./websocket.js`.
   */
  reconnectDelayMs?: (attempt: number) => number;
}

export interface ProtocolWebSocketTransportOptions {
  apiUrl: string;
  /**
   * Thread this transport targets. Optional: omit to construct an
   * unbound transport and bind later via {@link TransportAdapter.setThreadId}.
   */
  threadId?: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: ProtocolRequestHook;
  webSocketFactory?: (url: string) => WebSocket;
  paths?: Pick<ProtocolTransportPaths, "stream">;
  /**
   * Maximum reconnect attempts after an unexpected socket close.
   * Defaults to 5. Set to 0 to disable automatic reconnection.
   */
  maxReconnectAttempts?: number;
  /**
   * Called before each reconnect attempt (after backoff delay).
   */
  onReconnect?: (options: { attempt: number; cause: unknown }) => void;
  /**
   * Invoked after the socket has been re-established. Use to restore
   * server-side subscription state (see `ThreadStream`).
   */
  onReconnected?: () => void | Promise<void>;
  /**
   * Backoff before each reconnect attempt. Defaults to
   * {@link webSocketReconnectDelayMs}.
   */
  reconnectDelayMs?: (attempt: number) => number;
}

export type HeaderValue = string | undefined | null;

export type QueueResult<T> =
  | { done: false; value: T }
  | { done: true; value: undefined };

export type PendingResponse = {
  resolve: (response: CommandResponse | ErrorResponse) => void;
  reject: (error: Error) => void;
};
