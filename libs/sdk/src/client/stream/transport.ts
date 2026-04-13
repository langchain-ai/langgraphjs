import type {
  Command,
  CommandResponse,
  ErrorResponse,
  Message,
  SessionOpenParams,
  SessionResult,
} from "@langchain/protocol";

/**
 * Transport abstraction implemented by concrete client transports such as
 * WebSocket or in-process adapters.
 */
export interface TransportAdapter {
  /**
   * Opens a new protocol session over the transport.
   *
   * @param params - Session-open payload sent to the remote peer.
   */
  open(params: SessionOpenParams): Promise<SessionResult>;
  /**
   * Sends a command and optionally returns an immediate response.
   *
   * @param command - Protocol command to send over the transport.
   */
  send(command: Command): Promise<CommandResponse | ErrorResponse | void>;
  /**
   * Streams incoming protocol messages from the remote peer.
   */
  events(): AsyncIterable<Message>;
  /**
   * Shuts down the transport and releases any underlying resources.
   */
  close(): Promise<void>;
}
