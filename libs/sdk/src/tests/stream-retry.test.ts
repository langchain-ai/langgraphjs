import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { streamWithRetry, MaxReconnectAttemptsError } from "../utils/stream.js";
import { BytesLineDecoder, SSEDecoder } from "../utils/sse.js";

const textEncoder = new TextEncoder();

/**
 * Helper to create a ReadableStream from SSE-formatted text chunks
 * This creates a stream that properly handles cancellation to avoid
 * "Controller is already closed" errors in tests
 */
const createSSEStream = (
  chunks: Array<{ id?: string; event: string; data: unknown }>
): ReadableStream<{ id?: string; event: string; data: unknown }> => {
  // Convert chunks to SSE format
  const sseLines = chunks.flatMap((chunk) => {
    const lines: string[] = [];
    if (chunk.id) lines.push(`id: ${chunk.id}\n`);
    if (chunk.event) lines.push(`event: ${chunk.event}\n`);
    lines.push(`data: ${JSON.stringify(chunk.data)}\n`);
    lines.push("\n");
    return lines;
  });

  const uint8Arrays = sseLines.map((line) => textEncoder.encode(line));

  // Create a more controlled stream to avoid Node.js Readable issues
  let index = 0;
  const byteStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < uint8Arrays.length) {
        controller.enqueue(uint8Arrays[index]);
        index++;
      } else {
        controller.close();
      }
    },
  });

  return byteStream.pipeThrough(BytesLineDecoder()).pipeThrough(SSEDecoder());
};

/**
 * Helper to create a stream that yields some chunks then errors
 * This avoids race conditions with Readable.from() and controller.error()
 */
const createErroringStream = (
  chunks: Array<{ id?: string; event: string; data: unknown }>,
  error: Error
): ReadableStream<{ id?: string; event: string; data: unknown }> => {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index++;
      } else {
        controller.error(error);
      }
    },
  });
};

/**
 * Helper to gather all chunks from an async generator
 */
const gatherGenerator = async <T>(
  generator: AsyncGenerator<T>
): Promise<T[]> => {
  const results: T[] = [];
  for await (const chunk of generator) {
    results.push(chunk);
  }
  return results;
};

describe("streamWithRetry", () => {
  let mockResponse: Response;
  const newPath = "/reconnect/special-path";

  beforeEach(() => {
    vi.useFakeTimers();
    mockResponse = new Response(null, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        location: newPath,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("successful streaming", () => {
    test("streams successfully without retries", async () => {
      const chunks = [
        { id: "1", event: "message", data: { content: "hello" } },
        { id: "2", event: "message", data: { content: "world" } },
      ];

      const initialRequest = vi.fn(async () => ({
        response: mockResponse,
        stream: createSSEStream(chunks),
      }));

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest);
      const results = await gatherGenerator(generator);

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ id: "1", data: { content: "hello" } });
      expect(results[1]).toMatchObject({ id: "2", data: { content: "world" } });
      expect(initialRequest).toHaveBeenCalledTimes(1);
      expect(reconnectRequest).not.toHaveBeenCalled();
    });
  });

  describe("retry logic", () => {
    test("uses location header for reconnection path", async () => {
      const chunks1 = [{ id: "1", event: "msg", data: { part: 1 } }];
      const chunks2 = [{ id: "2", event: "msg", data: { part: 2 } }];

      let didError = false;
      const initialRequest = async () => {
        if (!didError) {
          didError = true;
          const stream = createErroringStream(
            chunks1,
            new TypeError("network error")
          );
          return { response: mockResponse, stream };
        }

        return { response: mockResponse, stream: createSSEStream(chunks1) };
      };

      const reconnectRequest = vi.fn(
        async (_: string, reconnectPath?: string) => {
          // Verify we received the reconnect path
          expect(reconnectPath).toBe(newPath);
          return {
            response: mockResponse,
            stream: createSSEStream(chunks2),
          };
        }
      );

      const generator = streamWithRetry(initialRequest, reconnectRequest);
      const consumePromise = gatherGenerator(generator);
      await vi.runAllTimersAsync();

      const results = await consumePromise;

      expect(results).toHaveLength(2);
      expect(reconnectRequest).toHaveBeenCalledTimes(1);
      // Verify it was called with both lastEventId and reconnectPath
      expect(reconnectRequest).toHaveBeenCalledWith("1", newPath);
    });

    test("does not try to reconnect when no location header is provided", async () => {
      const chunks1 = [{ id: "1", event: "msg", data: { part: 1 } }];

      const initialRequest = async () => {
        const stream = createErroringStream(
          chunks1,
          new TypeError("non retryable error")
        );

        const responseWithoutLocation = new Response(null, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });

        // No location header in response
        return { response: responseWithoutLocation, stream };
      };

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest);
      await vi.runAllTimersAsync();

      // Should get a chunk first
      const { value } = await generator.next();
      expect(value).toMatchObject(chunks1[0]);

      // Should throw an error after that
      await expect(generator.next()).rejects.toThrow("non retryable error");
      expect(reconnectRequest).not.toHaveBeenCalled();
    });

    test("throws MaxReconnectAttemptsError after max retries", async () => {
      const initialRequest = vi.fn(async () => {
        const stream = createErroringStream(
          [{ id: "1", event: "msg", data: {} }],
          new TypeError("persistent network error")
        );

        return { response: mockResponse, stream };
      });

      const reconnectRequest = vi.fn(async () => {
        const stream = createErroringStream(
          [],
          new TypeError("persistent network error")
        );

        return { response: mockResponse, stream };
      });

      const generator = streamWithRetry(initialRequest, reconnectRequest, {
        maxRetries: 2,
      });

      // Start consuming and handle the error immediately
      const consumePromise = gatherGenerator(generator);

      // Catch the error to prevent unhandled rejection
      const errorPromise = consumePromise.catch((err) => err);

      // Run timers to allow retries
      await vi.runAllTimersAsync();

      // Now verify the error
      const error = await errorPromise;
      expect(error).toBeInstanceOf(MaxReconnectAttemptsError);
      expect(error.message).toBe(
        "Exceeded maximum SSE reconnection attempts (2)"
      );
    });

    test("passes lastEventId to reconnect request", async () => {
      const chunks1 = [
        { id: "event-1", event: "msg", data: { text: "first" } },
        { id: "event-2", event: "msg", data: { text: "second" } },
      ];

      let didError = false;
      const initialRequest = async () => {
        if (!didError) {
          didError = true;
          const stream = createErroringStream(
            chunks1,
            new TypeError("network error")
          );
          return { response: mockResponse, stream };
        }

        return { response: mockResponse, stream: createSSEStream(chunks1) };
      };

      const reconnectRequest = vi.fn(async (lastEventId: string) => {
        expect(lastEventId).toBe("event-2");
        return {
          response: mockResponse,
          stream: createSSEStream([
            { id: "event-3", event: "msg", data: { text: "third" } },
          ]),
        };
      });

      const generator = streamWithRetry(initialRequest, reconnectRequest);
      const consumePromise = gatherGenerator(generator);
      await vi.runAllTimersAsync();

      const results = await consumePromise;

      expect(results).toHaveLength(3);
      expect(reconnectRequest).toHaveBeenCalledTimes(1);
      // First argument should be the lastEventId
      expect(reconnectRequest.mock.calls[0][0]).toBe("event-2");
    });
  });

  describe("content-type validation", () => {
    test("throws error on invalid content-type", async () => {
      const wrongResponse = new Response(null, {
        status: 200,
        headers: { "content-type": "application/json" },
      });

      const initialRequest = async () => ({
        response: wrongResponse,
        stream: createSSEStream([]),
      });

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest);

      await expect(gatherGenerator(generator)).rejects.toThrow(
        "Expected response header Content-Type to contain 'text/event-stream'"
      );
    });

    test("accepts content-type with charset", async () => {
      const responseWithCharset = new Response(null, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });

      const chunks = [{ id: "1", event: "msg", data: { test: true } }];

      const initialRequest = async () => ({
        response: responseWithCharset,
        stream: createSSEStream(chunks),
      });

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest);
      const results = await gatherGenerator(generator);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ id: "1", data: { test: true } });
    });
  });

  describe("abort signal handling", () => {
    test("stops streaming when signal is aborted before start", async () => {
      const controller = new AbortController();
      controller.abort();

      const initialRequest = vi.fn();
      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest, {
        signal: controller.signal,
      });

      const results = await gatherGenerator(generator);

      expect(results).toHaveLength(0);
      expect(initialRequest).not.toHaveBeenCalled();
    });

    test("stops streaming when signal is aborted during stream", async () => {
      const controller = new AbortController();

      const chunks = [
        { id: "1", event: "msg", data: { text: "first" } },
        { id: "2", event: "msg", data: { text: "second" } },
        { id: "3", event: "msg", data: { text: "third" } },
      ];

      const initialRequest = async () => ({
        response: mockResponse,
        stream: createSSEStream(chunks),
      });

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest, {
        signal: controller.signal,
      });

      const results: Array<{ id?: string; event: string; data: unknown }> = [];

      // Consume generator but abort after first chunk
      const consumePromise = (async () => {
        for await (const chunk of generator) {
          results.push(chunk);
          if (chunk.id === "1") {
            controller.abort();
          }
        }
      })();

      await consumePromise;

      // Should have stopped after first chunk
      expect(results.length).toBeLessThan(3);
    });

    test("does not retry when aborted", async () => {
      const controller = new AbortController();

      const initialRequest = vi.fn(async () => {
        const stream = createErroringStream(
          [{ id: "1", event: "msg", data: {} }],
          new TypeError("network error")
        );

        return { response: mockResponse, stream };
      });

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest, {
        signal: controller.signal,
      });

      // Consume the stream but abort after first value
      const results: any[] = [];
      try {
        for await (const chunk of generator) {
          results.push(chunk);
          // Abort after getting the first chunk
          controller.abort();
        }
      } catch (error) {
        // Stream should error, and should not retry because signal is aborted
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("network error");
      }

      // Verify we got the first chunk before the error
      expect(results).toHaveLength(1);
      expect(reconnectRequest).not.toHaveBeenCalled();
    });
  });

  describe("onReconnect callback", () => {
    test("onReconnect callback can be provided", async () => {
      // This tests that the callback is accepted, detailed behavior is tested in integration tests
      const onReconnect = vi.fn();

      const initialRequest = async () => ({
        response: mockResponse,
        stream: createSSEStream([
          { id: "1", event: "msg", data: { test: true } },
        ]),
      });

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest, {
        maxRetries: 5,
        onReconnect,
      });

      await gatherGenerator(generator);

      // No reconnection happened in this test (success on first try), so callback not called
      expect(onReconnect).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    test("handles empty stream", async () => {
      const initialRequest = async () => ({
        response: mockResponse,
        stream: createSSEStream([]),
      });

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest);
      const results = await gatherGenerator(generator);

      expect(results).toHaveLength(0);
      expect(reconnectRequest).not.toHaveBeenCalled();
    });

    test("handles events without IDs", async () => {
      const chunks = [
        { event: "msg", data: { text: "no id" } },
        { id: "2", event: "msg", data: { text: "has id" } },
      ];

      const initialRequest = async () => ({
        response: mockResponse,
        stream: createSSEStream(chunks),
      });

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest);
      const results = await gatherGenerator(generator);

      expect(results).toHaveLength(2);
      expect(results[0].id).toBeUndefined();
      expect(results[1].id).toBe("2");
    });

    test("does not retry on non-network errors", async () => {
      vi.useRealTimers();

      const testResponse = new Response(null, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      });

      const initialRequest = vi.fn(async () => {
        // Non-TypeError error should not trigger retry
        const stream = createErroringStream(
          [{ id: "1", event: "msg", data: {} }],
          new Error("Non-network error")
        );

        return { response: testResponse, stream };
      });

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest, {
        maxRetries: 5,
      });

      await expect(gatherGenerator(generator)).rejects.toThrow(
        "Non-network error"
      );
      expect(reconnectRequest).not.toHaveBeenCalled();

      vi.useFakeTimers();
    });

    test("retries when lastEventId exists without reconnectPath", async () => {
      const chunks1 = [{ id: "1", event: "msg", data: { part: 1 } }];
      const chunks2 = [{ id: "2", event: "msg", data: { part: 2 } }];

      let didError = false;
      const initialRequest = async () => {
        if (!didError) {
          didError = true;
          const stream = createErroringStream(
            chunks1,
            new TypeError("network error")
          );
          return { response: mockResponse, stream };
        }

        return { response: mockResponse, stream: createSSEStream(chunks1) };
      };

      const reconnectRequest = vi.fn(async () => ({
        response: mockResponse,
        stream: createSSEStream(chunks2),
      }));

      const generator = streamWithRetry(initialRequest, reconnectRequest);
      const consumePromise = gatherGenerator(generator);
      await vi.runAllTimersAsync();

      const results = await consumePromise;

      expect(results).toHaveLength(2);
      expect(reconnectRequest).toHaveBeenCalledTimes(1);
    });
  });
});
