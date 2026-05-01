import { AsyncQueue } from "./queue.js";
import type {
  Message,
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
 * Transport adapter that speaks the thread-centric protocol over a
 * bidirectional WebSocket. Bound to a specific `threadId` — the socket
 * connects to `ws://.../v2/threads/:thread_id/stream`.
 */
export class ProtocolWebSocketTransportAdapter implements TransportAdapter {
  readonly threadId: string;

  private readonly queue = new AsyncQueue<Message>();

  private readonly apiUrl: string;

  private readonly defaultHeaders?: Record<string, HeaderValue>;

  private readonly onRequest?: ProtocolRequestHook;

  private readonly webSocketFactory: (url: string) => WebSocket;

  private readonly streamUrl: string;

  private readonly pending = new Map<number, PendingResponse>();

  private socket: WebSocket | null = null;

  private closed = false;

  private intentionalClose = false;

  constructor(options: ProtocolWebSocketTransportOptions) {
    this.apiUrl = options.apiUrl;
    this.threadId = options.threadId;
    this.defaultHeaders = options.defaultHeaders;
    this.onRequest = options.onRequest;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.streamUrl =
      options.paths?.stream ?? `/v2/threads/${this.threadId}/stream`;
  }

  async open(): Promise<void> {
    if (this.socket != null) return;
    this.assertBrowserSafeTransportConfig();

    const wsUrl = toWebSocketUrl(
      new URL(
        this.streamUrl,
        this.apiUrl.endsWith("/") ? this.apiUrl : `${this.apiUrl}/`
      ).toString()
    );
    const socket = this.webSocketFactory(wsUrl);
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
  }

  async send(
    command: Command
  ): Promise<CommandResponse | ErrorResponse | void> {
    return await this.sendCommand(command);
  }

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

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.intentionalClose = true;

    for (const { reject } of this.pending.values()) {
      reject(new Error("Protocol WebSocket connection closed."));
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

  private assertBrowserSafeTransportConfig(): void {
    if (hasHeaders(this.defaultHeaders) || this.onRequest != null) {
      throw new Error(
        "Browser WebSocket protocol transport does not support defaultHeaders or onRequest hooks. Supply a custom protocolWebSocketFactory if you need custom WebSocket setup."
      );
    }
  }

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
