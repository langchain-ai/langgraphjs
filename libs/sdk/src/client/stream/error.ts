import type { ErrorResponse } from "@langchain/protocol";

/**
 * Error wrapper for protocol-level error responses returned by the server.
 */
export class ProtocolError extends Error {
  readonly code: ErrorResponse["error"];
  readonly response: ErrorResponse;

  constructor(response: ErrorResponse) {
    super(response.message);
    this.name = "ProtocolError";
    this.code = response.error;
    this.response = response;
  }
}

/**
 * Thrown when the v2 WebSocket transport exhausts its automatic reconnect
 * budget (`maxReconnectAttempts`) after an unexpected socket close or error.
 *
 * The transport closes its event queue with this error so consumers of
 * `events()` can treat the stream as terminally failed. Set
 * `maxReconnectAttempts` to `0` on `client.threads.stream({ transport:
 * "websocket" })` to disable reconnect and fail fast on the first drop
 * instead.
 */
export class MaxWebSocketReconnectAttemptsError extends Error {
  /** The configured `maxReconnectAttempts` value that was exceeded. */
  readonly maxAttempts: number;

  constructor(maxAttempts: number, cause: unknown) {
    super(`Exceeded maximum WebSocket reconnection attempts (${maxAttempts})`);
    this.name = "MaxWebSocketReconnectAttemptsError";
    this.maxAttempts = maxAttempts;
    this.cause = cause;
  }
}
