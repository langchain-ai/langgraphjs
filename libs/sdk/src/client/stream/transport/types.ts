import type { CommandResponse, ErrorResponse } from "@langchain/protocol";

export type ProtocolRequestHook = (
  url: URL,
  init: RequestInit
) => Promise<RequestInit> | RequestInit;

export interface ProtocolSseTransportOptions {
  apiUrl: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: ProtocolRequestHook;
  fetch?: typeof fetch;
  fetchFactory?: () => typeof fetch | Promise<typeof fetch>;
}

export interface ProtocolWebSocketTransportOptions {
  apiUrl: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: ProtocolRequestHook;
  webSocketFactory?: (url: string) => WebSocket;
}

export type HeaderValue = string | undefined | null;

export type QueueResult<T> =
  | { done: false; value: T }
  | { done: true; value: undefined };

export type PendingResponse = {
  resolve: (response: CommandResponse | ErrorResponse) => void;
  reject: (error: Error) => void;
};

export type StreamPart = {
  id: string | undefined;
  event: string;
  data: unknown;
};
