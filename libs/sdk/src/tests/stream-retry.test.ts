import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { streamWithRetry, MaxReconnectAttemptsError } from "../utils/stream.js";
import { BytesLineDecoder, SSEDecoder } from "../utils/sse.js";

const textEncoder = new TextEncoder();

/**
 * Helper to create a ReadableStream from SSE-formatted text chunks
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
  const readable = Readable.toWeb(
    Readable.from(uint8Arrays)
  ) as ReadableStream<Uint8Array>;

  return readable.pipeThrough(BytesLineDecoder()).pipeThrough(SSEDecoder());
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

  beforeEach(() => {
    vi.useFakeTimers();
    mockResponse = new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
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

    test("tracks event IDs correctly", async () => {
      const chunks = [
        { id: "event-1", event: "message", data: { text: "first" } },
        { id: "event-2", event: "message", data: { text: "second" } },
        { id: "event-3", event: "message", data: { text: "third" } },
      ];

      const initialRequest = async () => ({
        response: mockResponse,
        stream: createSSEStream(chunks),
      });

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest);
      const results = await gatherGenerator(generator);

      expect(results).toHaveLength(3);
      expect(results[0].id).toBe("event-1");
      expect(results[1].id).toBe("event-2");
      expect(results[2].id).toBe("event-3");
    });
  });

  describe("retry logic", () => {
    // Note: More complex retry scenarios involving mid-stream errors are better tested
    // through integration tests with the actual client, since they're difficult to
    // mock reliably with synchronous stream errors in unit tests.

    test("uses location header for reconnection path", async () => {
      const chunks1 = [{ id: "1", event: "msg", data: { part: 1 } }];
      const chunks2 = [{ id: "2", event: "msg", data: { part: 2 } }];

      // Response with Location header pointing to a different path
      const responseWithLocation = new Response(null, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          location: "/reconnect/special-path",
        },
      });

      let didError = false;
      const initialRequest = async () => {
        const stream = createSSEStream(chunks1);
        const reader = stream.getReader();

        const errorStream = new ReadableStream({
          async start(controller) {
            const { value } = await reader.read();
            controller.enqueue(value!);

            if (!didError) {
              didError = true;
              controller.error(new TypeError("network error"));
            }
          },
        });

        return { response: responseWithLocation, stream: errorStream };
      };

      const reconnectRequest = vi.fn(
        async (_: string, reconnectPath?: string) => {
          // Verify we received the reconnect path
          expect(reconnectPath).toBe("/reconnect/special-path");
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
      expect(reconnectRequest).toHaveBeenCalledWith(
        "1",
        "/reconnect/special-path"
      );
    });

    test("falls back to original path when no location header", async () => {
      const chunks1 = [{ id: "1", event: "msg", data: { part: 1 } }];
      const chunks2 = [{ id: "2", event: "msg", data: { part: 2 } }];

      let didError = false;
      const initialRequest = async () => {
        const stream = createSSEStream(chunks1);
        const reader = stream.getReader();

        const errorStream = new ReadableStream({
          async start(controller) {
            const { value } = await reader.read();
            controller.enqueue(value!);

            if (!didError) {
              didError = true;
              controller.error(new TypeError("network error"));
            }
          },
        });

        // No location header in response
        return { response: mockResponse, stream: errorStream };
      };

      const reconnectRequest = vi.fn(
        async (_: string, reconnectPath?: string) => {
          // Verify reconnectPath is undefined when no location header
          expect(reconnectPath).toBeUndefined();
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
      expect(reconnectRequest).toHaveBeenCalledWith("1", undefined);
    });

    test("throws MaxReconnectAttemptsError after max retries", async () => {
      const initialRequest = vi.fn(async () => {
        const stream = createSSEStream([{ id: "1", event: "msg", data: {} }]);
        const reader = stream.getReader();

        const errorStream = new ReadableStream({
          async start(controller) {
            const { value } = await reader.read();
            controller.enqueue(value!);
            controller.error(new TypeError("persistent network error"));
          },
        });

        return { response: mockResponse, stream: errorStream };
      });

      const reconnectRequest = vi.fn(async () => {
        const errorStream = new ReadableStream({
          async start(controller) {
            controller.error(new TypeError("persistent network error"));
          },
        });

        return { response: mockResponse, stream: errorStream };
      });

      const generator = streamWithRetry(initialRequest, reconnectRequest, {
        maxRetries: 2,
      });

      const consumePromise = gatherGenerator(generator);

      // Run timers to allow retries
      await vi.runAllTimersAsync();

      await expect(consumePromise).rejects.toThrow(MaxReconnectAttemptsError);
      await expect(consumePromise).rejects.toThrow(
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
        const stream = createSSEStream(chunks1);
        const reader = stream.getReader();

        const errorStream = new ReadableStream({
          async start(controller) {
            // Emit first two events
            const { value: v1 } = await reader.read();
            controller.enqueue(v1!);
            const { value: v2 } = await reader.read();
            controller.enqueue(v2!);

            if (!didError) {
              didError = true;
              controller.error(new TypeError("network error"));
            }
          },
        });

        return { response: mockResponse, stream: errorStream };
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
        const stream = createSSEStream([{ id: "1", event: "msg", data: {} }]);
        const reader = stream.getReader();

        const errorStream = new ReadableStream({
          async start(streamController) {
            const { value } = await reader.read();
            streamController.enqueue(value!);
            controller.abort(); // Abort during stream
            streamController.error(new TypeError("network error"));
          },
        });

        return { response: mockResponse, stream: errorStream };
      });

      const reconnectRequest = vi.fn();

      const generator = streamWithRetry(initialRequest, reconnectRequest, {
        signal: controller.signal,
      });

      try {
        await gatherGenerator(generator);
      } catch {
        // Expected to error
      }

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

      const initialRequest = async () => {
        const errorStream = new ReadableStream({
          start(controller) {
            controller.enqueue({ id: "1", event: "msg", data: {} });
            // Non-TypeError error should not trigger retry
            controller.error(new Error("Non-network error"));
          },
        });

        return { response: mockResponse, stream: errorStream };
      };

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
        const stream = createSSEStream(chunks1);
        const reader = stream.getReader();

        const errorStream = new ReadableStream({
          async start(controller) {
            const { value } = await reader.read();
            controller.enqueue(value!);

            if (!didError) {
              didError = true;
              controller.error(new TypeError("network error"));
            }
          },
        });

        return { response: mockResponse, stream: errorStream };
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
