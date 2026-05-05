import { AsyncQueue } from "./queue.js";
import type {
  Message,
  SubscribeParams,
  Command,
  CommandResponse,
  ErrorResponse,
} from "@langchain/protocol";

import type {
  HeaderValue,
  ProtocolRequestHook,
  ProtocolSseTransportOptions,
} from "./types.js";
import type { TransportAdapter, EventStreamHandle } from "../transport.js";
import {
  toAbsoluteUrl,
  isRecord,
  mergeHeaders,
  toError,
  isProtocolResponse,
} from "./utils.js";
import { BytesLineDecoder, SSEDecoder } from "./decoder.js";
import { IterableReadableStream } from "./stream.js";

/**
 * Transport adapter that speaks the thread-centric protocol over HTTP
 * commands plus SSE event streams. Bound to a specific `threadId`
 * at construction. Each {@link openEventStream} call opens an independent
 * filtered SSE connection via `POST /v2/threads/:thread_id/stream`.
 */
export class ProtocolSseTransportAdapter implements TransportAdapter {
  readonly threadId: string;

  private readonly queue = new AsyncQueue<Message>();

  private readonly fetchImpl: typeof fetch;

  private readonly apiUrl: string;

  private readonly defaultHeaders: Record<string, HeaderValue>;

  private readonly onRequest?: ProtocolRequestHook;

  private readonly fetchFactory?: () => typeof fetch | Promise<typeof fetch>;

  private readonly commandsUrl: string;

  private readonly streamUrl: string;

  private readonly sessionAbortController = new AbortController();

  private readonly eventStreams = new Set<AbortController>();

  private closed = false;

  constructor(options: ProtocolSseTransportOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiUrl = options.apiUrl;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.onRequest = options.onRequest;
    this.fetchFactory = options.fetchFactory;
    this.threadId = options.threadId;
    this.commandsUrl =
      options.paths?.commands ?? `/v2/threads/${this.threadId}/commands`;
    this.streamUrl =
      options.paths?.stream ?? `/v2/threads/${this.threadId}/stream`;
  }

  private async resolveFetch(): Promise<typeof fetch> {
    if (this.fetchFactory) {
      return await this.fetchFactory();
    }
    return this.fetchImpl;
  }

  /**
   * HTTP/SSE transports have no handshake — connections are made
   * per-command and per-subscription.
   */
  async open(): Promise<void> {
    // no-op
  }

  async send(
    command: Command
  ): Promise<CommandResponse | ErrorResponse | void> {
    const response = await this.request(this.commandsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: this.sessionAbortController.signal,
    });

    if (response.status === 202 || response.status === 204) {
      return undefined;
    }

    const payload = (await response.json()) as unknown;
    if (!isProtocolResponse(payload)) {
      throw new Error("Protocol command did not return a valid response.");
    }
    return payload;
  }

  /**
   * WebSocket-style single event stream.
   * For the SSE transport this returns a dummy iterable; real event
   * delivery happens via {@link openEventStream}.
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

  openEventStream(params: SubscribeParams): EventStreamHandle {
    if (this.closed) {
      throw new Error("Protocol transport is closed.");
    }

    const ac = new AbortController();
    this.eventStreams.add(ac);
    const streamQueue = new AsyncQueue<Message>();
    const streamUrl = this.streamUrl;

    let resolveReady!: () => void;
    let rejectReady!: (err: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const since = (params as SubscribeParams & { since?: unknown }).since;

    const startStream = async () => {
      try {
        const response = await this.request(streamUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({
            channels: params.channels,
            ...(params.namespaces ? { namespaces: params.namespaces } : {}),
            ...(params.depth != null ? { depth: params.depth } : {}),
            ...(typeof since === "number" ? { since } : {}),
          }),
          signal: ac.signal,
        });

        resolveReady();

        const readable =
          response.body ??
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          });

        const stream = readable
          .pipeThrough(BytesLineDecoder())
          .pipeThrough(SSEDecoder());
        const iterable = IterableReadableStream.fromReadableStream(stream);

        for await (const event of iterable) {
          if (ac.signal.aborted || this.closed) {
            break;
          }
          if (isRecord(event.data)) {
            const msg = event.data as Message & {
              seq?: number;
              method?: string;
            };
            streamQueue.push(msg);
          }
        }
        streamQueue.close();
      } catch (error) {
        rejectReady(error);
        if (ac.signal.aborted || this.closed) {
          streamQueue.close();
          return;
        }
        streamQueue.close(error);
      }
    };

    void startStream();

    const cleanup = () => {
      this.eventStreams.delete(ac);
      ac.abort();
      streamQueue.close();
    };

    return {
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async () => await streamQueue.shift(),
          return: async () => {
            cleanup();
            return { done: true, value: undefined };
          },
        }),
      },
      ready,
      close: cleanup,
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.sessionAbortController.abort();
    for (const ac of this.eventStreams) ac.abort();
    this.eventStreams.clear();
    this.queue.close();
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = toAbsoluteUrl(this.apiUrl, path);
    let requestInit: RequestInit = {
      ...init,
      headers: mergeHeaders(this.defaultHeaders, init.headers),
    };

    if (this.onRequest) {
      requestInit = await this.onRequest(url, requestInit);
    }

    try {
      const fetchImpl = await this.resolveFetch();
      const response = await fetchImpl(url.toString(), requestInit);
      if (!response.ok) {
        let detail = "";
        try {
          const body = await response.text();
          const parsed = JSON.parse(body);
          if (typeof parsed === "object" && parsed != null) {
            detail =
              ((parsed as Record<string, unknown>).message as string) ??
              ((parsed as Record<string, unknown>).error as string) ??
              "";
          }
          if (!detail) detail = body;
        } catch {
          // body unreadable or not JSON — fall through
        }
        const message = detail
          ? `Protocol request failed: ${response.status} ${response.statusText} — ${detail}`
          : `Protocol request failed: ${response.status} ${response.statusText}`;
        throw new Error(message);
      }
      return response;
    } catch (error) {
      throw toError(error);
    }
  }
}
