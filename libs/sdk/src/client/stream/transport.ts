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
 * In the thread-centric protocol the thread ID is part of the request
 * URLs. Transports may be bound at construction time, or left unbound and
 * bound later via {@link setThreadId} (see that method) — which lets a
 * single instance follow a lazily-created thread.
 */
export interface TransportAdapter {
  /**
   * Thread ID this transport currently targets.
   */
  readonly threadId: string;
  /**
   * Rebind this transport to a different thread.
   *
   * `client.threads.stream(threadId, { transport })` calls this (when
   * implemented) whenever the framework binds or re-binds the active
   * thread — including the lazily-minted id from the first `submit()` on
   * a `threadId: null` controller. Implementing it lets an adapter be
   * constructed once (optionally with no `threadId`) and reused as the
   * active thread becomes known, so the framework doesn't have to tear
   * down and rebuild a custom transport when the thread id appears.
   *
   * Optional: adapters that bake `threadId` at construction can omit it,
   * in which case the per-call `threadId` is ignored (prior behaviour).
   */
  setThreadId?(threadId: string): void;
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
   *
   * **Replay contract.** Implementations MUST buffer events emitted for
   * the thread/run and replay them through every newly-opened stream
   * whose filter matches. The SDK's shared-stream rotation relies on
   * this: when a subscription's filter widens the union, the SDK opens
   * a fresh stream and expects to receive the run's full history from
   * `seq=0` (deduplication is handled client-side via `event_id`). The
   * SDK also defers the open until after `run.start` has committed the
   * thread server-side to avoid a `404: Thread not found`, which means
   * events emitted during that window MUST be delivered to the late
   * opener. The protocol v2 server implements this via a bounded
   * per-run replay buffer; custom adapters should mirror that.
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
   * Fetch the latest checkpointed state for the bound thread via
   * `GET /threads/:threadId/state` (or an adapter-specific override).
   * When omitted, {@link StreamController.hydrate} falls back to
   * `client.threads.getState()`.
   */
  getState?<StateType = unknown>(): Promise<{
    values: StateType;
    next?: unknown;
    tasks?: unknown;
    metadata?: unknown;
    checkpoint?: { checkpoint_id?: string } | null;
    parent_checkpoint?: { checkpoint_id?: string } | null;
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
