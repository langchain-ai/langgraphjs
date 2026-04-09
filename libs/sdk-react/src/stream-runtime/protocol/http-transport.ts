import {
  BytesLineDecoder,
  IterableReadableStream,
  SSEDecoder,
} from "@langchain/langgraph-sdk/utils";
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
    const rejecter = this.rejecters.shift();
    if (waiter) {
      rejecter;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const toAbsoluteUrl = (apiUrl: string, path: string) =>
  new URL(path, apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

function mergeHeaders(
  ...headerGroups: Array<
    | HeadersInit
    | Record<string, HeaderValue>
    | undefined
    | null
  >
): Headers {
  const merged = new Headers();

  for (const group of headerGroups) {
    if (!group) {
      continue;
    }

    if (group instanceof Headers) {
      group.forEach((value, key) => {
        merged.set(key, value);
      });
      continue;
    }

    if (Array.isArray(group)) {
      for (const [key, value] of group) {
        if (value == null) {
          merged.delete(key);
        } else {
          merged.set(key, value);
        }
      }
      continue;
    }

    for (const [key, value] of Object.entries(group)) {
      if (value == null) {
        merged.delete(key);
      } else {
        merged.set(key, value);
      }
    }
  }

  return merged;
}

function isProtocolResponse(
  value: unknown,
): value is CommandResponse | ErrorResponse {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    (value.type === "success" || value.type === "error")
  );
}

export interface ProtocolSseTransportOptions {
  apiUrl: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: RequestHook;
  fetch?: typeof fetch;
  fetchFactory?: () => typeof fetch | Promise<typeof fetch>;
}

export class ProtocolSseTransportAdapter implements TransportAdapter {
  private readonly queue = new AsyncQueue<Message>();
  private readonly fetchImpl: typeof fetch;
  private readonly apiUrl: string;
  private readonly defaultHeaders: Record<string, HeaderValue>;
  private readonly onRequest?: RequestHook;
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
      typeof payload.result.sessionId !== "string"
    ) {
      throw new Error("Protocol session did not return a session ID.");
    }

    this.sessionId = payload.result.sessionId;
    this.closed = false;
    await this.startEventsLoop(
      typeof payload.result.eventsUrl === "string"
        ? payload.result.eventsUrl
        : `/v2/sessions/${this.sessionId}/events`,
    );

    return payload.result as SessionResult;
  }

  async send(
    command: Command,
  ): Promise<CommandResponse | ErrorResponse | void> {
    if (this.sessionId == null) {
      throw new Error("Protocol session is not open.");
    }

    const response = await this.request(`/v2/sessions/${this.sessionId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: this.eventAbortController?.signal,
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

  private async request(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
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
          `Protocol request failed: ${response.status} ${response.statusText}`,
        );
      }
      return response;
    } catch (error) {
      throw toError(error);
    }
  }
}
