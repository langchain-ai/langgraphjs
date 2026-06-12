import { AsyncQueue } from "./queue.js";
import type {
  Message,
  SubscribeParams,
  Command,
  CommandResponse,
  ErrorResponse,
} from "@langchain/protocol";

import type { AsyncCaller } from "../../../utils/async_caller.js";
import type {
  HeaderValue,
  ProtocolRequestHook,
  ProtocolSseTransportOptions,
  ProtocolTransportPaths,
} from "./types.js";
import type { TransportAdapter, EventStreamHandle } from "../transport.js";
import {
  toAbsoluteUrl,
  isRecord,
  mergeHeaders,
  toError,
  isProtocolResponse,
  resolveProtocolPath,
} from "./utils.js";
import { BytesLineDecoder, SSEDecoder } from "../../../utils/sse.js";
import {
  IterableReadableStream,
  idleReconnectStream,
  type IdleReconnectMode,
} from "../../../utils/stream.js";
import { webSocketReconnectDelayMs } from "./websocket.js";

/**
 * Transport adapter that speaks the thread-centric protocol over HTTP
 * commands plus SSE event streams. Bound to a `threadId` at construction
 * or later via {@link setThreadId}; request URLs derive from the
 * currently-bound thread. Each {@link openEventStream} call opens an
 * independent filtered SSE connection via
 * `POST /threads/:thread_id/stream/events`.
 */
export class ProtocolSseTransportAdapter implements TransportAdapter {
  threadId: string;

  readonly apiUrl: string;

  private readonly queue = new AsyncQueue<Message>();

  private readonly fetchImpl: typeof fetch;

  private readonly defaultHeaders: Record<string, HeaderValue>;

  private readonly onRequest?: ProtocolRequestHook;

  private readonly fetchFactory?: () => typeof fetch | Promise<typeof fetch>;

  private readonly asyncCaller?: AsyncCaller;

  private readonly maxReconnectAttempts: number;

  private readonly idleReconnect: IdleReconnectMode | null;

  private readonly onReconnect?: ProtocolSseTransportOptions["onReconnect"];

  private readonly reconnectDelayMs: (attempt: number) => number;

  private readonly paths?: ProtocolTransportPaths;

  private readonly sessionAbortController = new AbortController();

  private readonly eventStreams = new Set<AbortController>();

  private closed = false;

  constructor(options: ProtocolSseTransportOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiUrl = options.apiUrl;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.onRequest = options.onRequest;
    this.fetchFactory = options.fetchFactory;
    this.asyncCaller = options.asyncCaller;
    // Custom fetch (tests/mocks) must not auto-reconnect — same policy as skipping AsyncCaller.
    this.maxReconnectAttempts =
      options.fetch != null ? 0 : (options.maxReconnectAttempts ?? 5);
    // Custom fetch (tests/mocks) also disables the idle watchdog, matching the
    // no-auto-reconnect policy above — a tripped watchdog would have nothing to
    // reconnect to and would surface spurious errors in those harnesses.
    // Otherwise default to heartbeat-adaptive `"auto"`, which stays dormant
    // unless the server actually emits keep-alive heartbeats.
    this.idleReconnect =
      options.fetch != null ? null : (options.idleReconnect ?? "auto");
    this.onReconnect = options.onReconnect;
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? webSocketReconnectDelayMs;
    this.threadId = options.threadId ?? "";
    this.paths = options.paths;
  }

  /** {@inheritDoc TransportAdapter.setThreadId} */
  setThreadId(threadId: string): void {
    this.threadId = threadId;
  }

  /**
   * Command/stream/state URLs derive from the currently-bound thread so a
   * single adapter can follow {@link setThreadId} re-binds. A fixed
   * `paths.*` string overrides the default and is used as-is.
   */
  private get commandsUrl(): string {
    return resolveProtocolPath(
      this.paths?.commands,
      this.threadId,
      (id) => `/threads/${id}/commands`
    );
  }

  private get streamUrl(): string {
    return resolveProtocolPath(
      this.paths?.stream,
      this.threadId,
      (id) => `/threads/${id}/stream/events`
    );
  }

  private get stateUrl(): string {
    return resolveProtocolPath(
      this.paths?.state,
      this.threadId,
      (id) => `/threads/${id}/state`
    );
  }

  /**
   * Fetch checkpointed thread state for hydration.
   *
   * Uses `GET`, matching `client.threads.getState()` and both LangGraph
   * Platform and Agent Protocol custom backends (`POST` is reserved for
   * `updateState`).
   */
  async getState<StateType = unknown>(): Promise<{
    values: StateType;
    next?: unknown;
    tasks?: unknown;
    metadata?: unknown;
    checkpoint?: { checkpoint_id?: string } | null;
    parent_checkpoint?: { checkpoint_id?: string } | null;
  } | null> {
    const url = toAbsoluteUrl(this.apiUrl, this.stateUrl);
    let requestInit: RequestInit = {
      method: "GET",
      headers: mergeHeaders(this.defaultHeaders, {}),
    };

    if (this.onRequest) {
      requestInit = await this.onRequest(url, requestInit);
    }

    const fetchImpl = await this.resolveFetch();
    const response = await fetchImpl(url.toString(), requestInit);
    if (response.status === 404) return null;
    if (!response.ok) {
      const error = toError(
        new Error(
          `Thread state request failed: ${response.status} ${response.statusText}`
        )
      ) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    return (await response.json()) as {
      values: StateType;
      next?: unknown;
      tasks?: unknown;
      metadata?: unknown;
      checkpoint?: { checkpoint_id?: string } | null;
      parent_checkpoint?: { checkpoint_id?: string } | null;
    };
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

    let resumeAfterSeq =
      typeof (params as SubscribeParams & { since?: unknown }).since ===
      "number"
        ? (params as SubscribeParams & { since: number }).since
        : undefined;

    let readySettled = false;

    const startStream = async () => {
      let attempt = 0;

      while (!ac.signal.aborted && !this.closed) {
        try {
          const response = await this.request(
            streamUrl,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "text/event-stream",
              },
              body: JSON.stringify({
                channels: params.channels,
                ...(params.namespaces ? { namespaces: params.namespaces } : {}),
                ...(params.depth != null ? { depth: params.depth } : {}),
                ...(resumeAfterSeq != null ? { since: resumeAfterSeq } : {}),
              }),
              signal: ac.signal,
            },
            { stream: true }
          );

          if (!readySettled) {
            readySettled = true;
            resolveReady();
          }

          const readable =
            response.body ??
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            });

          // Idle watchdog on the line stream (between byte-line and SSE
          // decoding) so it can reset on any line and recognise `:` keep-alive
          // heartbeats to drive `"auto"` mode. On idle it errors the stream,
          // which the catch below treats like any other disconnect and
          // reconnects with `since` from the last seen sequence.
          const enableIdle =
            this.idleReconnect === "auto" ||
            (typeof this.idleReconnect === "number" && this.idleReconnect > 0);
          const lines = readable.pipeThrough(BytesLineDecoder());
          const watched = enableIdle
            ? lines.pipeThrough(
                idleReconnectStream({ mode: this.idleReconnect! })
              )
            : lines;
          const stream = watched.pipeThrough(SSEDecoder());
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
              if (typeof msg.seq === "number") {
                resumeAfterSeq = msg.seq;
              }
              streamQueue.push(msg);
            }
          }
          streamQueue.close();
          return;
        } catch (error) {
          if (ac.signal.aborted || this.closed) {
            if (!readySettled) {
              rejectReady(error);
            }
            streamQueue.close();
            return;
          }
          if (this.maxReconnectAttempts <= 0) {
            if (!readySettled) {
              rejectReady(error);
            }
            streamQueue.close(toError(error));
            return;
          }
          attempt += 1;
          if (attempt > this.maxReconnectAttempts) {
            if (!readySettled) {
              rejectReady(error);
            }
            streamQueue.close(toError(error));
            return;
          }
          this.onReconnect?.({ attempt, cause: error });
          const delay = this.reconnectDelayMs(attempt);
          if (delay > 0) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, delay);
            });
          }
        }
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

  private async request(
    path: string,
    init: RequestInit,
    options?: { stream?: boolean }
  ): Promise<Response> {
    const url = toAbsoluteUrl(this.apiUrl, path);
    let requestInit: RequestInit = {
      ...init,
      headers: mergeHeaders(this.defaultHeaders, init.headers),
    };

    if (this.onRequest) {
      requestInit = await this.onRequest(url, requestInit);
    }

    // Long-lived SSE event streams must not run through AsyncCaller: its
    // p-queue/p-retry semantics are designed for discrete request/response
    // calls, and wrapping a streaming response stalls the call (and can
    // leak retries). Stream resilience is handled separately by the
    // reconnect loop in `openEventStream`.
    const useAsyncCaller = this.asyncCaller != null && !options?.stream;

    const execute = async (): Promise<Response> => {
      const fetchImpl = await this.resolveFetch();
      const response = await fetchImpl(url.toString(), requestInit);
      if (!response.ok) {
        // Reject with the Response so AsyncCaller maps it to HTTPError and
        // applies STATUS_NO_RETRY / retry policy consistently with REST.
        if (useAsyncCaller) {
          throw response;
        }
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
    };

    try {
      return useAsyncCaller
        ? await this.asyncCaller!.call(execute)
        : await execute();
    } catch (error) {
      throw toError(error);
    }
  }
}
