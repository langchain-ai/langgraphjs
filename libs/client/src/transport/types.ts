import type { CommandResponse, ErrorResponse } from "@langchain/protocol";

/**
 * Hook that can inspect or modify outgoing protocol HTTP requests.
 */
export type ProtocolRequestHook = (
  /**
   * Fully resolved request URL.
   */
  url: URL,
  /**
   * Request options that will be sent with the request.
   */
  init: RequestInit
) => Promise<RequestInit> | RequestInit;

/**
 * Configuration for the SSE-based protocol transport adapter.
 */
export interface ProtocolSseTransportOptions {
  /**
   * Base API URL for the protocol server.
   */
  apiUrl: string;
  /**
   * Default headers merged into every HTTP request.
   */
  defaultHeaders?: Record<string, HeaderValue>;
  /**
   * Optional request interception hook.
   */
  onRequest?: ProtocolRequestHook;
  /**
   * Explicit fetch implementation used for requests.
   */
  fetch?: typeof fetch;
  /**
   * Lazy factory for resolving a fetch implementation at request time.
   */
  fetchFactory?: () => typeof fetch | Promise<typeof fetch>;
}

/**
 * Configuration for the WebSocket-based protocol transport adapter.
 */
export interface ProtocolWebSocketTransportOptions {
  /**
   * Base API URL for the protocol server.
   */
  apiUrl: string;
  /**
   * Optional headers that would be applied to the connection setup.
   */
  defaultHeaders?: Record<string, HeaderValue>;
  /**
   * Optional request interception hook.
   */
  onRequest?: ProtocolRequestHook;
  /**
   * Factory used to create the underlying WebSocket instance.
   */
  webSocketFactory?: (url: string) => WebSocket;
}

/**
 * Header values supported by the transport helpers.
 */
export type HeaderValue = string | undefined | null;

/**
 * Result shape returned by async queue reads.
 *
 * @typeParam T - Value type delivered through the queue.
 */
export type QueueResult<T> =
  | { done: false; value: T }
  | { done: true; value: undefined };

/**
 * Deferred command response handlers for WebSocket requests.
 */
export type PendingResponse = {
  /**
   * Resolves the pending command with a protocol response.
   */
  resolve: (response: CommandResponse | ErrorResponse) => void;
  /**
   * Rejects the pending command with a transport-level error.
   */
  reject: (error: Error) => void;
};

/**
 * Parsed representation of a single SSE event frame.
 */
export type StreamPart = {
  /**
   * Event id cursor emitted by the server.
   */
  id: string | undefined;
  /**
   * SSE event name.
   */
  event: string;
  /**
   * Parsed JSON event payload.
   */
  data: unknown;
};
