import { isNetworkError } from "./error.js";

// in this case don't quite match.
type IterableReadableStreamInterface<T> = ReadableStream<T> & AsyncIterable<T>;

/**
 * Options for streaming with automatic retry logic.
 */
export interface StreamWithRetryOptions {
  /**
   * Maximum number of reconnection attempts. Default is 5.
   */
  maxRetries?: number;

  /**
   * AbortSignal to cancel the stream.
   */
  signal?: AbortSignal;

  /**
   * Callback invoked when a reconnection attempt is made.
   */
  onReconnect?: (options: {
    attempt: number;
    lastEventId?: string;
    cause: unknown;
  }) => void;
}

/**
 * Parameters for making a stream request
 */
export interface StreamRequestParams {
  /**
   * Last event ID to resume from, if available
   */
  lastEventId?: string;

  /**
   * Optional reconnection path from the Location header
   */
  reconnectPath?: string;
}

/**
 * Error thrown when maximum reconnection attempts are exceeded.
 */
export class MaxReconnectAttemptsError extends Error {
  constructor(maxAttempts: number, cause: unknown) {
    super(`Exceeded maximum SSE reconnection attempts (${maxAttempts})`);
    this.name = "MaxReconnectAttemptsError";
    this.cause = cause;
  }
}

/**
 * Error injected into the stream by {@link idleReconnectStream} when no lines
 * arrive within the active idle window. Surfacing this during the read is what
 * lets the reconnect loops in `streamWithRetry` and the protocol SSE transport
 * recover from a half-open socket — one that was silently dropped (e.g. a hard
 * pod kill on a platform revision rollover) without a TCP FIN/RST, so neither
 * a `done` nor a thrown network error ever arrives.
 */
export class StreamIdleTimeoutError extends Error {
  readonly idleTimeoutMs: number;

  constructor(idleTimeoutMs: number) {
    super(
      `No SSE bytes received for ${idleTimeoutMs}ms; assuming the connection is half-open and reconnecting.`
    );
    this.name = "StreamIdleTimeoutError";
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

/** `":"` — first byte of an SSE comment / keep-alive line. */
const SSE_COMMENT_BYTE = 0x3a;

/**
 * How {@link idleReconnectStream} decides when the connection is idle.
 *
 * - A `number` is a fixed idle window in milliseconds: the watchdog arms
 *   immediately (even before the first byte) and trips after that long with no
 *   activity. Use when you know your server's behaviour and want guaranteed
 *   coverage from t=0; it does not depend on heartbeats.
 * - `"auto"` is heartbeat-adaptive: the watchdog stays dormant until it has
 *   observed the server's SSE keep-alive comments (e.g. LangGraph Platform's
 *   `: heartbeat` every ~5s), then arms with a window derived from the
 *   observed cadence. On a server that never sends heartbeats it never arms,
 *   so it can't false-fire during a legitimately quiet period.
 */
export type IdleReconnectMode = number | "auto";

export interface IdleReconnectStreamOptions {
  /** Fixed timeout (ms) or `"auto"` heartbeat-adaptive. */
  mode: IdleReconnectMode;
  /** `"auto"`: multiplier applied to the observed heartbeat interval. Default 3. */
  timeoutFactor?: number;
  /** `"auto"`: lower clamp for the derived timeout (ms). Default 6000. */
  minTimeoutMs?: number;
  /** `"auto"`: upper clamp for the derived timeout (ms). Default 30000. */
  maxTimeoutMs?: number;
  /** Fired immediately before the stream is errored, for logging/metrics. */
  onIdle?: (info: { timeoutMs: number; source: "fixed" | "heartbeat" }) => void;
}

/**
 * A pass-through {@link TransformStream} that errors the stream when it goes
 * idle, so the surrounding reconnect logic can recover a half-open socket.
 *
 * MUST sit on the *line* stream — i.e. after
 * {@link import("./sse.js").BytesLineDecoder} but before
 * {@link import("./sse.js").SSEDecoder} (which discards `:` comment lines).
 * Operating at the line level lets the watchdog both (a) reset on any line
 * (data *or* heartbeat = liveness) and (b) recognise heartbeat comment lines
 * to drive `"auto"` mode.
 *
 * In `"auto"` mode the watchdog is intentionally dormant until it has seen at
 * least two heartbeats (so it can measure the cadence). This means a socket
 * that dies inside the first heartbeat interval won't be caught until a
 * heartbeat would have been due — an acceptable trade for never false-firing
 * on heartbeat-less servers. Pass a fixed `number` if you need coverage from
 * the very first byte.
 */
export function idleReconnectStream(
  options: IdleReconnectStreamOptions
): TransformStream<Uint8Array, Uint8Array> {
  const factor = options.timeoutFactor ?? 3;
  const minTimeoutMs = options.minTimeoutMs ?? 6_000;
  const maxTimeoutMs = options.maxTimeoutMs ?? 30_000;
  const fixedTimeoutMs = typeof options.mode === "number" ? options.mode : null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let controllerRef: TransformStreamDefaultController<Uint8Array> | undefined;

  // `"auto"` cadence inference.
  let lastHeartbeatAt: number | undefined;
  // The active idle window: the fixed value, or (auto) the heartbeat-derived
  // value once known. `null` means "not armed yet".
  let derivedTimeoutMs: number | null = fixedTimeoutMs;

  const clear = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = () => {
    clear();
    const timeoutMs = derivedTimeoutMs;
    if (timeoutMs == null || timeoutMs <= 0) return;
    timer = setTimeout(() => {
      options.onIdle?.({
        timeoutMs,
        source: fixedTimeoutMs != null ? "fixed" : "heartbeat",
      });
      try {
        controllerRef?.error(new StreamIdleTimeoutError(timeoutMs));
      } catch {
        // Stream already closed/errored/cancelled — nothing to abort.
      }
    }, timeoutMs);
    // Don't let the watchdog by itself keep a Node process alive.
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  const noteHeartbeat = () => {
    if (fixedTimeoutMs != null) return; // cadence irrelevant in fixed mode
    const now = Date.now();
    if (lastHeartbeatAt != null) {
      const interval = now - lastHeartbeatAt;
      if (interval > 0) {
        const candidate = Math.min(
          Math.max(interval * factor, minTimeoutMs),
          maxTimeoutMs
        );
        // Keep the most conservative (largest) window observed so far.
        derivedTimeoutMs =
          derivedTimeoutMs == null
            ? candidate
            : Math.max(derivedTimeoutMs, candidate);
      }
    }
    lastHeartbeatAt = now;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // Fixed mode arms eagerly (also catches pre-first-byte silence). Auto
      // mode waits until a cadence is established in `transform`.
      arm();
    },
    transform(line, controller) {
      // A line beginning with ":" is an SSE comment / keep-alive heartbeat.
      if (line.length > 0 && line[0] === SSE_COMMENT_BYTE) {
        noteHeartbeat();
      }
      // Any line is liveness — (re)arm the idle timer.
      arm();
      controller.enqueue(line);
    },
    flush() {
      clear();
    },
  });
}

/**
 * Stream with automatic retry logic for SSE connections.
 * Implements reconnection behavior similar to the Python SDK.
 *
 * @param makeRequest Function to make requests. When `params` is undefined/empty, it's the initial request.
 *                    When `params.reconnectPath` is provided, it's a reconnection request.
 * @param options Configuration options
 * @returns AsyncGenerator yielding stream events
 */
export async function* streamWithRetry<T extends { id?: string }>(
  makeRequest: (params?: StreamRequestParams) => Promise<{
    response: Response;
    stream: ReadableStream<T>;
  }>,
  options: StreamWithRetryOptions = {}
): AsyncGenerator<T> {
  const maxRetries = options.maxRetries ?? 5;
  let attempt = 0;
  let lastEventId: string | undefined;
  let reconnectPath: string | undefined;

  while (true) {
    let shouldRetry = false;
    let lastError: unknown;
    let reader: ReadableStreamDefaultReader<T> | undefined;

    try {
      // Check if aborted before making request
      if (options.signal?.aborted) return;

      // Make request - initial if no reconnect path, reconnect otherwise
      const { response, stream } = await makeRequest(
        reconnectPath ? { lastEventId, reconnectPath } : undefined
      );

      // Check for Location header (server-provided reconnection path)
      const locationHeader = response.headers.get("location");
      if (locationHeader) {
        reconnectPath = locationHeader;
      }

      // Verify content type
      const contentType = response.headers.get("content-type")?.split(";")[0];
      if (contentType && !contentType.includes("text/event-stream")) {
        throw new Error(
          `Expected response header Content-Type to contain 'text/event-stream', got '${contentType}'`
        );
      }

      reader = stream.getReader();

      try {
        while (true) {
          // Check abort signal before each read
          if (options.signal?.aborted) {
            await reader.cancel();
            return;
          }

          const { done, value } = await reader.read();

          if (done) {
            // Stream completed successfully
            break;
          }

          // Track last event ID for reconnection
          if (value.id) {
            lastEventId = value.id;
          }

          yield value;
        }

        // Stream completed successfully, exit retry loop
        break;
      } catch (error) {
        // Error during streaming - attempt reconnect if we have a location header
        if (reconnectPath && !options.signal?.aborted) {
          shouldRetry = true;
        } else {
          throw error;
        }
      } finally {
        if (reader) {
          try {
            reader.releaseLock();
          } catch {
            // Ignore errors when releasing lock
          }
        }
      }
    } catch (error) {
      lastError = error;

      // Only retry if we have reconnection capability and it's a network error
      if (isNetworkError(error) && reconnectPath && !options.signal?.aborted) {
        shouldRetry = true;
      } else {
        throw error;
      }
    }

    if (shouldRetry) {
      attempt += 1;
      if (attempt > maxRetries) {
        throw new MaxReconnectAttemptsError(maxRetries, lastError);
      }

      // Notify about reconnection attempt
      options.onReconnect?.({ attempt, lastEventId, cause: lastError });

      // Exponential backoff with jitter: min(1000 * 2^attempt, 5000) + random jitter
      const baseDelay = Math.min(1000 * 2 ** (attempt - 1), 5000);
      const jitter = Math.random() * 1000;
      const delay = baseDelay + jitter;

      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });

      continue;
    }

    // Successfully completed
    break;
  }
}

/*
 * Support async iterator syntax for ReadableStreams in all environments.
 * Source: https://github.com/MattiasBuelens/web-streams-polyfill/pull/122#issuecomment-1627354490
 */
export class IterableReadableStream<T>
  extends ReadableStream<T>
  implements IterableReadableStreamInterface<T>
{
  public reader: ReadableStreamDefaultReader<T>;

  ensureReader() {
    if (!this.reader) {
      this.reader = this.getReader();
    }
  }

  async next(): Promise<IteratorResult<T>> {
    this.ensureReader();
    try {
      const result = await this.reader.read();
      if (result.done) {
        this.reader.releaseLock(); // release lock when stream becomes closed
        return {
          done: true,
          value: undefined,
        };
      } else {
        return {
          done: false,
          value: result.value,
        };
      }
    } catch (e) {
      this.reader.releaseLock(); // release lock when stream becomes errored
      throw e;
    }
  }

  async return(): Promise<IteratorResult<T>> {
    this.ensureReader();
    // If wrapped in a Node stream, cancel is already called.
    if (this.locked) {
      const cancelPromise = this.reader.cancel(); // cancel first, but don't await yet
      this.reader.releaseLock(); // release lock first
      await cancelPromise; // now await it
    }
    return { done: true, value: undefined };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async throw(e: any): Promise<IteratorResult<T>> {
    this.ensureReader();
    if (this.locked) {
      const cancelPromise = this.reader.cancel(); // cancel first, but don't await yet
      this.reader.releaseLock(); // release lock first
      await cancelPromise; // now await it
    }
    throw e;
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore Not present in Node 18 types, required in latest Node 22
  async [Symbol.asyncDispose]() {
    await this.return();
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  static fromReadableStream<T>(stream: ReadableStream<T>) {
    // From https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Using_readable_streams#reading_the_stream
    const reader = stream.getReader();
    return new IterableReadableStream<T>({
      start(controller) {
        return pump();
        function pump(): Promise<T | undefined> {
          return reader.read().then(({ done, value }) => {
            // When no more data needs to be consumed, close the stream
            if (done) {
              controller.close();
              return;
            }
            // Enqueue the next data chunk into our target stream
            controller.enqueue(value);
            return pump();
          });
        }
      },
      cancel() {
        reader.releaseLock();
      },
    });
  }

  static fromAsyncGenerator<T>(generator: AsyncGenerator<T>) {
    return new IterableReadableStream<T>({
      async pull(controller) {
        const { value, done } = await generator.next();
        // When no more data needs to be consumed, close the stream
        if (done) {
          controller.close();
        }
        // Fix: `else if (value)` will hang the streaming when nullish value (e.g. empty string) is pulled
        controller.enqueue(value);
      },
      async cancel(reason) {
        await generator.return(reason);
      },
    });
  }
}
