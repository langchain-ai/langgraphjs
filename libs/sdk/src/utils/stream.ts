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
   * If provided, this is a reconnection request with the last event ID
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
 * Stream with automatic retry logic for SSE connections.
 * Implements reconnection behavior similar to the Python SDK.
 *
 * @param makeRequest Function to make requests. When `params` is undefined/empty, it's the initial request.
 *                    When `params.lastEventId` is provided, it's a reconnection request.
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

      // Make request - initial if no lastEventId, reconnect otherwise
      const { response, stream } = await makeRequest(
        lastEventId ? { lastEventId, reconnectPath } : undefined
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
        // Error during streaming - attempt reconnect if we have lastEventId and a location header
        if (lastEventId && reconnectPath && !options.signal?.aborted) {
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
      if (
        isNetworkError(error) &&
        lastEventId &&
        reconnectPath &&
        !options.signal?.aborted
      ) {
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
