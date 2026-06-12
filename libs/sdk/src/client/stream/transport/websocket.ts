import { AsyncQueue } from "./queue.js";
import type {
  Message,
  Command,
  CommandResponse,
  ErrorResponse,
} from "@langchain/protocol";

import {
  toAbsoluteUrl,
  toWebSocketUrl,
  isRecord,
  hasHeaders,
  toError,
  resolveProtocolPath,
} from "./utils.js";
import type {
  HeaderValue,
  ProtocolRequestHook,
  PendingResponse,
  ProtocolTransportPaths,
  ProtocolWebSocketTransportOptions,
} from "./types.js";
import type { TransportAdapter } from "../transport.js";
import { MaxWebSocketReconnectAttemptsError } from "../error.js";

const WEB_SOCKET_CONNECTING = 0;
const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_CLOSED = 3;

/**
 * Reconnect tuning for {@link ProtocolWebSocketTransportAdapter}. A subset
 * of {@link ProtocolWebSocketTransportOptions}.
 */
export interface WebSocketReconnectOptions {
  /**
   * Maximum reconnection attempts after an unexpected disconnect.
   * Defaults to 5.
   */
  maxReconnectAttempts?: number;

  /**
   * Invoked before each reconnect attempt (after backoff).
   */
  onReconnect?: (options: { attempt: number; cause: unknown }) => void;
}

/**
 * Exponential backoff with jitter for WebSocket reconnect. Mirrors
 * {@link streamWithRetry} in `utils/stream.ts` (capped at 5s + 1s jitter).
 */
export function webSocketReconnectDelayMs(attempt: number): number {
  const baseDelay = Math.min(1000 * 2 ** (attempt - 1), 5000);
  const jitter = Math.random() * 1000;
  return baseDelay + jitter;
}

/**
 * Transport adapter that speaks the thread-centric protocol over a
 * bidirectional WebSocket. Bound to a `threadId` at construction or later
 * via {@link setThreadId} — the socket connects to
 * `ws://.../threads/:thread_id/stream/events`.
 *
 * On unexpected disconnect the adapter reconnects with exponential
 * backoff (see {@link ProtocolWebSocketTransportOptions.maxReconnectAttempts}).
 * The server replays buffered events on the new socket; the SDK
 * deduplicates by `event_id`. {@link ProtocolWebSocketTransportOptions.onReconnected}
 * runs after each successful reconnect so `ThreadStream` can re-issue
 * `subscription.subscribe` commands.
 */
export class ProtocolWebSocketTransportAdapter implements TransportAdapter {
  threadId: string;

  private readonly queue = new AsyncQueue<Message>();

  private readonly apiUrl: string;

  private readonly defaultHeaders?: Record<string, HeaderValue>;

  private readonly onRequest?: ProtocolRequestHook;

  private readonly webSocketFactory: (url: string) => WebSocket;

  private readonly paths?: Pick<ProtocolTransportPaths, "stream">;

  private readonly maxReconnectAttempts: number;

  private readonly onReconnect?: ProtocolWebSocketTransportOptions["onReconnect"];

  private readonly reconnectDelayMs: (attempt: number) => number;

  private onReconnected?: () => void | Promise<void>;

  private readonly pending = new Map<number, PendingResponse>();

  private socket: WebSocket | null = null;

  private closed = false;

  private intentionalClose = false;

  private reconnectInFlight: Promise<void> | null = null;

  constructor(options: ProtocolWebSocketTransportOptions) {
    this.apiUrl = options.apiUrl;
    this.threadId = options.threadId ?? "";
    this.defaultHeaders = options.defaultHeaders;
    this.onRequest = options.onRequest;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.paths = options.paths;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.onReconnect = options.onReconnect;
    this.onReconnected = options.onReconnected;
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? webSocketReconnectDelayMs;
  }

  /** {@inheritDoc TransportAdapter.setThreadId} */
  setThreadId(threadId: string): void {
    if (threadId === this.threadId) {
      return;
    }
    if (
      this.reconnectInFlight != null ||
      (this.socket != null && this.socket.readyState !== WEB_SOCKET_CLOSED)
    ) {
      throw new Error(
        "Protocol WebSocket transport cannot be rebound to a different thread while the socket is open. Close the current stream and create a new WebSocket transport for the new thread."
      );
    }
    this.threadId = threadId;
  }

  /**
   * Socket URL derives from the currently-bound thread so a single adapter
   * can follow {@link setThreadId} re-binds; the next {@link open} connects
   * to the new thread. A fixed `paths.stream` string overrides the default.
   */
  private get streamUrl(): string {
    return resolveProtocolPath(
      this.paths?.stream,
      this.threadId,
      (id) => `/threads/${id}/stream/events`
    );
  }

  /**
   * Register a callback invoked after each successful reconnect. Used
   * by {@link ThreadStream} to re-send active `subscription.subscribe`
   * commands.
   */
  setOnReconnected(handler: () => void | Promise<void>): void {
    this.onReconnected = handler;
  }

  async open(): Promise<void> {
    if (this.closed) {
      throw new Error("Protocol WebSocket transport is closed.");
    }
    if (this.socket?.readyState === WEB_SOCKET_OPEN) {
      return;
    }
    if (this.socket != null) {
      this.#detachSocket(this.socket);
      this.socket = null;
    }

    this.assertBrowserSafeTransportConfig();

    const wsUrl = toWebSocketUrl(
      toAbsoluteUrl(this.apiUrl, this.streamUrl).toString()
    );
    const socket = this.webSocketFactory(wsUrl);
    this.socket = socket;
    this.intentionalClose = false;

    this.#attachSocket(socket);

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

    this.#detachSocket(socket);

    await new Promise<void>((resolve) => {
      if (socket.readyState === WEB_SOCKET_CLOSED) {
        resolve();
        return;
      }

      const onClose = () => {
        socket.removeEventListener("close", onClose);
        resolve();
      };

      socket.addEventListener("close", onClose, { once: true });
      if (
        socket.readyState === WEB_SOCKET_OPEN ||
        socket.readyState === WEB_SOCKET_CONNECTING
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
    // Wait for an in-flight reconnect only when the socket is not usable.
    // After `open()` succeeds, `#runReconnectLoop` may still be awaiting
    // `onReconnected` (e.g. ThreadStream resubscribe). Those callbacks call
    // `sendCommand` and must not await the same `reconnectInFlight` promise.
    let socket = this.socket;
    if (
      this.reconnectInFlight != null &&
      (socket == null || socket.readyState !== WEB_SOCKET_OPEN)
    ) {
      await this.reconnectInFlight.catch(() => undefined);
      socket = this.socket;
    }

    if (socket == null || socket.readyState !== WEB_SOCKET_OPEN) {
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

  #attachSocket(socket: WebSocket): void {
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleSocketError);
  }

  #detachSocket(socket: WebSocket): void {
    socket.removeEventListener("message", this.handleMessage);
    socket.removeEventListener("close", this.handleClose);
    socket.removeEventListener("error", this.handleSocketError);
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
    const socket = this.socket;
    if (socket != null) {
      this.#detachSocket(socket);
    }
    this.socket = null;

    if (this.intentionalClose || this.closed) {
      this.queue.close();
      return;
    }

    this.#handleUnexpectedDisconnect(
      new Error("Protocol WebSocket closed unexpectedly.")
    );
  };

  private readonly handleSocketError = (): void => {
    if (this.closed || this.intentionalClose) {
      return;
    }

    this.#handleUnexpectedDisconnect(
      new Error("Protocol WebSocket encountered an error.")
    );
  };

  #handleUnexpectedDisconnect(cause: unknown): void {
    const error = toError(cause);
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();

    if (this.maxReconnectAttempts <= 0) {
      this.queue.close(error);
      return;
    }

    this.#scheduleReconnect(cause);
  }

  #scheduleReconnect(cause: unknown): void {
    if (this.closed || this.intentionalClose) {
      return;
    }
    if (this.reconnectInFlight != null) {
      return;
    }

    this.reconnectInFlight = this.#runReconnectLoop(cause).finally(() => {
      this.reconnectInFlight = null;
    });
  }

  async #runReconnectLoop(initialCause: unknown): Promise<void> {
    let lastError: unknown = initialCause;

    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt += 1) {
      if (this.closed || this.intentionalClose) {
        return;
      }

      this.onReconnect?.({ attempt, cause: lastError });

      const delay = this.reconnectDelayMs(attempt);
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delay);
        });
      }

      if (this.closed || this.intentionalClose) {
        return;
      }

      try {
        await this.open();
        if (this.onReconnected) {
          await this.onReconnected();
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }

    this.queue.close(
      new MaxWebSocketReconnectAttemptsError(
        this.maxReconnectAttempts,
        lastError
      )
    );
  }
}
