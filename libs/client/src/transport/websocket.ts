import { AsyncQueue } from "./queue.js";
import type {
  Message,
  SessionOpenParams,
  SessionResult,
  Command,
  CommandResponse,
  ErrorResponse,
} from "@langchain/protocol";

import { toWebSocketUrl, isRecord, hasHeaders, toError } from "./utils.js";
import type {
  HeaderValue,
  ProtocolRequestHook,
  PendingResponse,
  ProtocolWebSocketTransportOptions,
} from "./types.js";
import type { TransportAdapter } from "../transport.js";

/**
 * Transport adapter that speaks the protocol over a bidirectional WebSocket.
 */
export class ProtocolWebSocketTransportAdapter implements TransportAdapter {
  sessionId: string | null = null;

  private readonly queue = new AsyncQueue<Message>();

  private readonly apiUrl: string;

  private readonly defaultHeaders?: Record<string, HeaderValue>;

  private readonly onRequest?: ProtocolRequestHook;

  private readonly webSocketFactory: (url: string) => WebSocket;

  private readonly pending = new Map<number, PendingResponse>();

  private socket: WebSocket | null = null;

  private closed = false;

  private intentionalClose = false;

  /**
   * Creates a new WebSocket transport adapter.
   *
   * @param options - Transport configuration including API URL and socket factory.
   */
  constructor(options: ProtocolWebSocketTransportOptions) {
    this.apiUrl = options.apiUrl;
    this.defaultHeaders = options.defaultHeaders;
    this.onRequest = options.onRequest;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  /**
   * Opens the protocol socket and negotiates the session with `session.open`.
   *
   * @param params - Session open payload sent to the server.
   * @returns The opened session metadata.
   */
  async open(params: SessionOpenParams): Promise<SessionResult> {
    this.assertBrowserSafeTransportConfig();

    const socket = this.webSocketFactory(toWebSocketUrl(this.apiUrl));
    this.socket = socket;
    this.closed = false;
    this.intentionalClose = false;

    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleSocketError);

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Failed to open protocol WebSocket."));
      };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });

    const response = await this.sendCommand({
      id: 0,
      method: "session.open",
      params,
    } satisfies Command);

    if (response.type === "error") {
      throw new Error(response.message);
    }

    if (
      !isRecord(response.result) ||
      typeof response.result.sessionId !== "string"
    ) {
      throw new Error("Protocol session did not return a session ID.");
    }

    this.sessionId = response.result.sessionId;
    return response.result as SessionResult;
  }

  /**
   * Sends a protocol command across the active WebSocket connection.
   *
   * @param command - Protocol command to send.
   * @returns The command response returned over the socket.
   */
  async send(
    command: Command
  ): Promise<CommandResponse | ErrorResponse | void> {
    return await this.sendCommand(command);
  }

  /**
   * Exposes socket-delivered protocol events as an async iterable.
   *
   * @returns Async iterable over incoming protocol messages.
   */
  events(): AsyncIterable<Message> {
    const queue = this.queue;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => await queue.shift(),
        return: async () => {
          queue.close();
          return { done: true, value: undefined };
        },
      }),
    };
  }

  /**
   * Closes the socket connection and rejects any pending commands.
   *
   * @returns A promise that resolves once the socket has been closed.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.intentionalClose = true;
    this.sessionId = null;

    for (const { reject } of this.pending.values()) {
      reject(new Error("Protocol WebSocket session closed."));
    }
    this.pending.clear();
    this.queue.close();

    const socket = this.socket;
    this.socket = null;
    if (!socket) {
      return;
    }

    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      const onClose = () => {
        socket.removeEventListener("close", onClose);
        resolve();
      };

      socket.addEventListener("close", onClose, { once: true });
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      } else {
        resolve();
      }
    });
  }

  /**
   * Guards against unsupported browser-only configuration on WebSockets.
   */
  private assertBrowserSafeTransportConfig(): void {
    if (hasHeaders(this.defaultHeaders) || this.onRequest != null) {
      throw new Error(
        "Browser WebSocket protocol transport does not support defaultHeaders or onRequest hooks. Supply a custom protocolWebSocketFactory if you need custom WebSocket setup."
      );
    }
  }

  /**
   * Sends a command and waits for the corresponding WebSocket response.
   *
   * @param command - Protocol command to send.
   * @returns The matched success or error response.
   */
  private async sendCommand(
    command: Command
  ): Promise<CommandResponse | ErrorResponse> {
    const socket = this.socket;
    if (socket == null || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Protocol WebSocket is not open.");
    }

    return await new Promise<CommandResponse | ErrorResponse>(
      (resolve, reject) => {
        this.pending.set(command.id, { resolve, reject });

        try {
          socket.send(JSON.stringify(command));
        } catch (error) {
          this.pending.delete(command.id);
          reject(toError(error));
        }
      }
    );
  }

  /**
   * Parses incoming socket frames and routes them to pending commands or the
   * event queue.
   *
   * @param event - Raw WebSocket message event.
   */
  private readonly handleMessage = (event: MessageEvent): void => {
    let payload: unknown;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (
      isRecord(payload) &&
      typeof payload.id === "number" &&
      (payload.type === "success" || payload.type === "error")
    ) {
      const pending = this.pending.get(payload.id);
      if (pending) {
        this.pending.delete(payload.id);
        pending.resolve(payload as CommandResponse | ErrorResponse);
      }
      return;
    }

    if (isRecord(payload) && payload.type === "event") {
      this.queue.push(payload as Message);
    }
  };

  /**
   * Handles socket closure and propagates errors when the closure was
   * unexpected.
   */
  private readonly handleClose = (): void => {
    this.socket = null;

    if (this.intentionalClose || this.closed) {
      this.queue.close();
      return;
    }

    const error = new Error("Protocol WebSocket closed unexpectedly.");
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
    this.queue.close(error);
  };

  /**
   * Handles low-level socket errors and rejects pending work.
   */
  private readonly handleSocketError = (): void => {
    if (this.closed || this.intentionalClose) {
      return;
    }

    const error = new Error("Protocol WebSocket encountered an error.");
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
    this.queue.close(error);
  };
}
