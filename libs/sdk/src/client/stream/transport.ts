import type {
  Command,
  CommandResponse,
  ErrorResponse,
  Message,
  SubscribeParams,
} from "@langchain/protocol";

/**
 * Handle returned by {@link TransportAdapter.openEventStream} representing
 * a single filtered SSE connection.
 *
 * The `ready` promise resolves once the underlying connection is
 * established (response headers received), letting callers ensure the
 * subscription is active server-side before proceeding.
 */
export interface EventStreamHandle {
  events: AsyncIterable<Message>;
  ready: Promise<void>;
  close(): void;
}

/**
 * Transport abstraction implemented by concrete client transports such as
 * WebSocket or SSE adapters.
 *
 * In the thread-centric protocol, transports are bound to a specific
 * thread at construction time — the thread ID is part of the connection URL.
 */
export interface TransportAdapter {
  /**
   * Thread ID this transport is bound to.
   */
  readonly threadId: string;
  /**
   * Opens the underlying connection (e.g. WebSocket handshake).
   * For HTTP/SSE transports this is a no-op.
   */
  open(): Promise<void>;
  /**
   * Sends a command and optionally returns an immediate response.
   *
   * @param command - Protocol command to send over the transport.
   */
  send(command: Command): Promise<CommandResponse | ErrorResponse | void>;
  /**
   * Streams incoming protocol messages from the remote peer.
   * Used by WebSocket transports where all events share one connection.
   */
  events(): AsyncIterable<Message>;
  /**
   * Opens an independent filtered SSE event stream.
   * Each call creates a new server connection with the given filter.
   * Returns `undefined` when the transport does not support per-subscription
   * streams (e.g. WebSocket), in which case the caller should fall back to
   * command-based subscriptions over {@link events}.
   */
  openEventStream?(params: SubscribeParams): EventStreamHandle;
  /**
   * Shuts down the transport and releases any underlying resources.
   */
  close(): Promise<void>;
}

/**
 * Public v1 name for {@link TransportAdapter} plus optional high-level
 * capabilities. Renamed to reflect that this interface now denotes the
 * full agent-server protocol contract (not merely wire transport):
 * any object that satisfies it can back a `useStream` call. See
 * `plan-custom-transport.md` §4 for the rollout.
 *
 * The extra optional methods let adapters surface thread state and
 * history without the framework needing to issue a parallel HTTP
 * request — `useStream.hydrate()` calls `getState?()` when present
 * and falls back to `client.threads.getState` otherwise. Adapters
 * that don't know how to produce these values can simply omit them.
 *
 * The legacy `TransportAdapter` export is retained for back-compat and
 * resolves to the same structural type; new code should prefer
 * `AgentServerAdapter`.
 */
export interface AgentServerAdapter extends TransportAdapter {
  /**
   * Fetch the latest checkpointed state for the bound thread. When
   * the adapter doesn't expose state (e.g. a purely event-replay
   * backend), leave this undefined — the framework will skip
   * hydration.
   */
  getState?<StateType = unknown>(): Promise<{
    values: StateType;
    checkpoint?: { checkpoint_id?: string } | null;
  } | null>;
  /**
   * Fetch a slice of checkpoint history for the bound thread. Used
   * by branching and time-travel UIs. Optional — omitting it turns
   * those UIs into no-ops rather than surfacing an error.
   */
  getHistory?<StateType = unknown>(options?: {
    limit?: number;
  }): Promise<
    Array<{
      values: StateType;
      checkpoint?: { checkpoint_id?: string } | null;
    }>
  >;
}
