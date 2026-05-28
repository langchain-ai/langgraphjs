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
