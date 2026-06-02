/**
 * Stock `AgentServerAdapter` implementation for "point `useStream` at a
 * single HTTP endpoint that speaks the v2 protocol" deployments.
 *
 * Internally delegates to the appropriate built-in transport:
 *  - `new HttpAgentServerAdapter({ apiUrl, threadId })`      → SSE
 *  - `new HttpAgentServerAdapter({ apiUrl, threadId, webSocketFactory })`
 *    → WebSocket
 *
 * Keeps the user-facing import surface small: callers only ever import
 * `HttpAgentServerAdapter` from `@langchain/langgraph-sdk` instead of
 * knowing the two wire-specific class names. The class is deliberately
 * thin — it forwards every method on {@link AgentServerAdapter} to the
 * delegate it picked at construction time.
 *
 * See `plan-custom-transport.md` §4.3 for motivation.
 */
import type {
  AgentServerAdapter,
  EventStreamHandle,
  TransportAdapter,
} from "../transport.js";
import type {
  Command,
  CommandResponse,
  ErrorResponse,
  Message,
  SubscribeParams,
} from "@langchain/protocol";
import { ProtocolSseTransportAdapter } from "./http.js";
import { ProtocolWebSocketTransportAdapter } from "./websocket.js";
import type {
  HeaderValue,
  ProtocolRequestHook,
  ProtocolTransportPaths,
} from "./types.js";

export interface HttpAgentServerAdapterOptions {
  apiUrl: string;
  threadId: string;
  /** Auth / tenant / diagnostic headers applied to every request. */
  defaultHeaders?: Record<string, HeaderValue>;
  /** Per-request hook for last-mile header mutation. */
  onRequest?: ProtocolRequestHook;
  /** Override the default `/threads/:threadId/...` protocol paths. */
  paths?: ProtocolTransportPaths;
  /**
   * Optional `fetch` override, forwarded to the SSE transport. Useful
   * for auth proxies, Next.js route handlers, or tests with injected
   * mocks. Ignored when `webSocketFactory` is also supplied.
   */
  fetch?: typeof fetch;
  /**
   * Optional WebSocket factory. Supplying it flips the adapter into
   * WebSocket mode — SSE is bypassed entirely.
   */
  webSocketFactory?: (url: string) => WebSocket;
}

export class HttpAgentServerAdapter implements AgentServerAdapter {
  readonly threadId: string;

  readonly #delegate: TransportAdapter;

  constructor(options: HttpAgentServerAdapterOptions) {
    this.threadId = options.threadId;
    this.#delegate =
      options.webSocketFactory != null
        ? new ProtocolWebSocketTransportAdapter({
            apiUrl: options.apiUrl,
            threadId: options.threadId,
            defaultHeaders: options.defaultHeaders,
            onRequest: options.onRequest,
            paths: options.paths,
            webSocketFactory: options.webSocketFactory,
          })
        : new ProtocolSseTransportAdapter({
            apiUrl: options.apiUrl,
            threadId: options.threadId,
            defaultHeaders: options.defaultHeaders,
            onRequest: options.onRequest,
            fetch: options.fetch,
            paths: options.paths,
          });
  }

  open(): Promise<void> {
    return this.#delegate.open();
  }

  send(command: Command): Promise<CommandResponse | ErrorResponse | void> {
    return this.#delegate.send(command);
  }

  events(): AsyncIterable<Message> {
    return this.#delegate.events();
  }

  openEventStream(params: SubscribeParams): EventStreamHandle {
    if (this.#delegate.openEventStream == null) {
      throw new Error(
        "HttpAgentServerAdapter delegate does not support openEventStream (WebSocket path)."
      );
    }
    return this.#delegate.openEventStream(params);
  }

  close(): Promise<void> {
    return this.#delegate.close();
  }
}
