import { AsyncQueue } from "./queue.js";
import type {
  Message,
  SessionOpenParams,
  SessionResult,
  Command,
  CommandResponse,
  ErrorResponse,
} from "@langchain/protocol";

import type {
  HeaderValue,
  ProtocolRequestHook,
  ProtocolSseTransportOptions,
} from "./types.js";
import type { TransportAdapter } from "../transport.js";
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
 * Transport adapter that speaks the protocol over HTTP commands plus an SSE
 * event stream.
 */
export class ProtocolSseTransportAdapter implements TransportAdapter {
  private readonly queue = new AsyncQueue<Message>();

  private readonly fetchImpl: typeof fetch;

  private readonly apiUrl: string;

  private readonly defaultHeaders: Record<string, HeaderValue>;

  private readonly onRequest?: ProtocolRequestHook;

  private sessionId: string | null = null;

  private eventAbortController: AbortController | null = null;

  private closed = false;

  constructor(options: ProtocolSseTransportOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiUrl = options.apiUrl;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.onRequest = options.onRequest;
    this.fetchFactory = options.fetchFactory;
  }

  private readonly fetchFactory?: () => typeof fetch | Promise<typeof fetch>;

  private async resolveFetch(): Promise<typeof fetch> {
    if (this.fetchFactory) {
      return await this.fetchFactory();
    }
    return this.fetchImpl;
  }

  async open(params: SessionOpenParams): Promise<SessionResult> {
    const response = await this.request("/v2/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: 0,
        method: "session.open",
        params,
      } satisfies Command),
    });

    const payload = (await response.json()) as unknown;
    if (!isProtocolResponse(payload)) {
      throw new Error("Protocol session did not return a valid open response.");
    }
    if (payload.type === "error") {
      throw new Error(payload.message);
    }
    if (
      !isRecord(payload.result) ||
      typeof payload.result.session_id !== "string"
    ) {
      throw new Error("Protocol session did not return a session ID.");
    }

    this.sessionId = payload.result.session_id;
    this.closed = false;
    await this.startEventsLoop(
      typeof payload.result.events_url === "string"
        ? payload.result.events_url
        : `/v2/sessions/${this.sessionId}/events`
    );

    return payload.result as SessionResult;
  }

  async send(
    command: Command
  ): Promise<CommandResponse | ErrorResponse | void> {
    if (this.sessionId == null) {
      throw new Error("Protocol session is not open.");
    }

    const response = await this.request(
      `/v2/sessions/${this.sessionId}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
        signal: this.eventAbortController?.signal,
      }
    );

    if (response.status === 202 || response.status === 204) {
      return undefined;
    }

    const payload = (await response.json()) as unknown;
    if (!isProtocolResponse(payload)) {
      throw new Error("Protocol command did not return a valid response.");
    }
    return payload;
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
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    this.queue.close();

    const sessionId = this.sessionId;
    this.sessionId = null;

    if (sessionId == null) {
      return;
    }

    await this.request(`/v2/sessions/${sessionId}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }

  private async startEventsLoop(path: string): Promise<void> {
    this.eventAbortController?.abort();
    this.eventAbortController = new AbortController();

    const response = await this.request(path, {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal: this.eventAbortController.signal,
    });

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
    const signal = this.eventAbortController.signal;

    void (async () => {
      try {
        for await (const event of iterable) {
          if (signal.aborted || this.closed) {
            break;
          }

          if (isRecord(event.data)) {
            this.queue.push(event.data as Message);
          }
        }
        this.queue.close();
      } catch (error) {
        if (signal.aborted || this.closed) {
          this.queue.close();
          return;
        }
        this.queue.close(error);
      }
    })();
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
        throw new Error(
          `Protocol request failed: ${response.status} ${response.statusText}`
        );
      }
      return response;
    } catch (error) {
      throw toError(error);
    }
  }
}
