import type { RequestHook } from "@langchain/langgraph-sdk/client";
import type {
  Command,
  CommandResponse,
  ErrorResponse,
  Message,
  SessionOpenParams,
  SessionResult,
} from "@langchain/protocol";
import type { TransportAdapter } from "@langchain/client";

type HeaderValue = string | undefined | null;

type QueueResult<T> =
  | { done: false; value: T }
  | { done: true; value: undefined };

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: QueueResult<T>) => void> = [];
  private readonly rejecters: Array<(error: Error) => void> = [];
  private closed = false;
  private error: Error | null = null;

  push(value: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    this.rejecters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }

    this.values.push(value);
  }

  close(error?: unknown): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.error =
      error == null
        ? null
        // oxlint-disable-next-line no-instanceof/no-instanceof
        : error instanceof Error
          ? error
          : new Error(String(error));

    if (this.error) {
      for (const rejecter of this.rejecters.splice(0)) {
        rejecter(this.error);
      }
      this.waiters.length = 0;
      return;
    }

    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
    this.rejecters.length = 0;
  }

  async shift(): Promise<QueueResult<T>> {
    if (this.values.length > 0) {
      return { done: false, value: this.values.shift() as T };
    }

    if (this.error) {
      throw this.error;
    }

    if (this.closed) {
      return { done: true, value: undefined };
    }

    return await new Promise<QueueResult<T>>((resolve, reject) => {
      this.waiters.push(resolve);
      this.rejecters.push(reject);
    });
  }
}

type PendingResponse = {
  resolve: (response: CommandResponse | ErrorResponse) => void;
  reject: (error: Error) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const toError = (error: unknown) =>
  // oxlint-disable-next-line no-instanceof/no-instanceof
  error instanceof Error ? error : new Error(String(error));

const toWebSocketUrl = (apiUrl: string): string => {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v2/runs";
  url.search = "";
  url.hash = "";
  return url.toString();
};

const hasHeaders = (headers?: Record<string, HeaderValue>) =>
  Object.values(headers ?? {}).some((value) => value != null);

export interface ProtocolWebSocketTransportOptions {
  apiUrl: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: RequestHook;
  webSocketFactory?: (url: string) => WebSocket;
}

export class ProtocolWebSocketTransportAdapter implements TransportAdapter {
  sessionId: string | null = null;
  
  private readonly queue = new AsyncQueue<Message>();
  private readonly apiUrl: string;
  private readonly defaultHeaders?: Record<string, HeaderValue>;
  private readonly onRequest?: RequestHook;
  private readonly webSocketFactory: (url: string) => WebSocket;
  private readonly pending = new Map<number, PendingResponse>();
  private socket: WebSocket | null = null;
  private closed = false;
  private intentionalClose = false;

  constructor(options: ProtocolWebSocketTransportOptions) {
    this.apiUrl = options.apiUrl;
    this.defaultHeaders = options.defaultHeaders;
    this.onRequest = options.onRequest;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

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

  async send(
    command: Command,
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

  private assertBrowserSafeTransportConfig(): void {
    if (hasHeaders(this.defaultHeaders) || this.onRequest != null) {
      throw new Error(
        "Browser WebSocket protocol transport does not support defaultHeaders or onRequest hooks. Supply a custom protocolWebSocketFactory if you need custom WebSocket setup.",
      );
    }
  }

  private async sendCommand(
    command: Command,
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
      },
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
