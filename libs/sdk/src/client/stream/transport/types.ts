import type { CommandResponse, ErrorResponse } from "@langchain/protocol";

export type ProtocolRequestHook = (
  url: URL,
  init: RequestInit
) => Promise<RequestInit> | RequestInit;

export interface ProtocolTransportPaths {
  commands?: string;
  stream?: string;
}

export interface ProtocolSseTransportOptions {
  apiUrl: string;
  threadId: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: ProtocolRequestHook;
  fetch?: typeof fetch;
  fetchFactory?: () => typeof fetch | Promise<typeof fetch>;
  paths?: ProtocolTransportPaths;
}

export interface ProtocolWebSocketTransportOptions {
  apiUrl: string;
  threadId: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: ProtocolRequestHook;
  webSocketFactory?: (url: string) => WebSocket;
  paths?: Pick<ProtocolTransportPaths, "stream">;
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
