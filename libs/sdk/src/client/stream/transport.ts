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
