import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { Client } from "../client.js";

const textEncoder = new TextEncoder();

/**
 * Helper to create an SSE-formatted response body
 */
const createSSEResponseBody = (
  chunks: Array<{ id?: string; event: string; data: unknown }>
): ReadableStream<Uint8Array> => {
  const sseLines = chunks.flatMap((chunk) => {
    const lines: string[] = [];
    if (chunk.id) lines.push(`id: ${chunk.id}\n`);
    if (chunk.event) lines.push(`event: ${chunk.event}\n`);
    lines.push(`data: ${JSON.stringify(chunk.data)}\n`);
    lines.push("\n");
    return lines;
  });

  const uint8Arrays = sseLines.map((line) => textEncoder.encode(line));
  return Readable.toWeb(
    Readable.from(uint8Arrays)
  ) as ReadableStream<Uint8Array>;
};

/**
 * Helper to gather all chunks from an async generator
 */
const gatherStream = async <T>(stream: AsyncGenerator<T>): Promise<T[]> => {
  const results: T[] = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }
  return results;
};

describe("Client streaming with retry", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: Client;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = vi.fn();

    client = new Client({
      apiUrl: "http://localhost:8000",
      apiKey: "test-key",
      callerOptions: {
        fetch: mockFetch,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("runs.stream()", () => {
    test("streams successfully without retries", async () => {
      const chunks = [
        { id: "1", event: "values", data: { messages: ["hello"] } },
        { id: "2", event: "values", data: { messages: ["hello", "world"] } },
      ];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "content-location": "/threads/thread-1/runs/run-1",
          },
        })
      );

      const stream = client.runs.stream("thread-1", "assistant-1", {
        input: { message: "test" },
        streamMode: ["values"],
      });

      const results = await gatherStream(stream);

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ id: "1", event: "values" });
      expect(results[1]).toMatchObject({ id: "2", event: "values" });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify POST was used for initial request
      const [url, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe("POST");
      expect(url.toString()).toContain("/threads/thread-1/runs/stream");
    });

    test("uses POST method with JSON body for initial stream", async () => {
      const chunks = [{ id: "1", event: "values", data: {} }];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      const stream = client.runs.stream("thread-1", "assistant-1", {
        input: { message: "test input" },
        streamMode: ["values", "updates"],
      });

      await gatherStream(stream);

      const [, init] = mockFetch.mock.calls[0];

      // Verify it's a POST request
      expect(init.method).toBe("POST");

      // Verify body contains the input
      const body = JSON.parse(init.body as string);
      expect(body.input).toEqual({ message: "test input" });
      expect(body.stream_mode).toEqual(["values", "updates"]);
      expect(body.assistant_id).toBe("assistant-1");
    });

    test("calls onRunCreated callback", async () => {
      const chunks = [{ id: "1", event: "values", data: {} }];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "content-location": "/threads/thread-1/runs/run-123",
          },
        })
      );

      const onRunCreated = vi.fn();

      const stream = client.runs.stream("thread-1", "assistant-1", {
        input: { message: "test" },
        onRunCreated,
      });

      await gatherStream(stream);

      expect(onRunCreated).toHaveBeenCalledWith({
        run_id: "run-123",
        thread_id: "thread-1",
      });
    });

    test("includes required headers and uses correct method", async () => {
      const chunks = [{ id: "1", event: "values", data: {} }];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      const stream = client.runs.stream("thread-1", "assistant-1", {
        input: { message: "test" },
        streamMode: ["values"],
      });

      await gatherStream(stream);

      const [, init] = mockFetch.mock.calls[0];

      // Verify POST method
      expect(init.method).toBe("POST");

      // Verify headers include content-type for JSON
      const headers = init.headers as Record<string, string>;
      expect(headers["content-type"]).toBe("application/json");

      // Verify body has input
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({
        input: { message: "test" },
        stream_mode: ["values"],
        assistant_id: "assistant-1",
      });
    });
  });

  describe("runs.joinStream()", () => {
    test("joins stream successfully with GET method", async () => {
      const chunks = [
        { id: "1", event: "values", data: { state: "running" } },
        { id: "2", event: "values", data: { state: "complete" } },
      ];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      const stream = client.runs.joinStream("thread-1", "run-1");
      const results = await gatherStream(stream);

      expect(results).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify GET was used (not POST)
      const [url, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe("GET");
      expect(url.toString()).toContain("/threads/thread-1/runs/run-1/stream");

      // Verify no body (GET requests shouldn't have body)
      expect(init.body).toBeUndefined();
    });

    test("sends Last-Event-ID header when provided", async () => {
      const chunks = [{ id: "5", event: "values", data: { resumed: true } }];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      const stream = client.runs.joinStream("thread-1", "run-1", {
        lastEventId: "4",
      });

      await gatherStream(stream);

      // Verify Last-Event-ID header was sent
      const init = mockFetch.mock.calls[0][1];
      const headers = init.headers as Record<string, string>;

      expect(headers["last-event-id"]).toBe("4");
    });

    test("respects cancelOnDisconnect parameter", async () => {
      const chunks = [{ id: "1", event: "values", data: {} }];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      const stream = client.runs.joinStream("thread-1", "run-1", {
        cancelOnDisconnect: true,
      });

      await gatherStream(stream);

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain("cancel_on_disconnect=1");
    });
  });

  describe("threads.joinStream()", () => {
    test("joins thread stream successfully with GET method", async () => {
      const chunks = [
        { id: "1", event: "values", data: { messages: ["msg1"] } },
        { id: "2", event: "values", data: { messages: ["msg1", "msg2"] } },
      ];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      const stream = client.threads.joinStream("thread-1");
      const results = await gatherStream(stream);

      expect(results).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe("GET");
      expect(url.toString()).toContain("/threads/thread-1/stream");

      // Verify no body for GET request
      expect(init.body).toBeUndefined();
    });

    test("passes streamMode parameter", async () => {
      const chunks = [{ id: "1", event: "messages", data: {} }];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      const stream = client.threads.joinStream("thread-1", {
        streamMode: ["lifecycle", "state_update"],
      });

      await gatherStream(stream);

      const [url] = mockFetch.mock.calls[0];
      const urlObj = new URL(url.toString());
      const streamMode = urlObj.searchParams.get("stream_mode");

      expect(streamMode).toBeTruthy();
    });
  });

  describe("abort signal support", () => {
    test("stops streaming when signal is aborted", async () => {
      const controller = new AbortController();
      const chunks = [
        { id: "1", event: "values", data: { step: 1 } },
        { id: "2", event: "values", data: { step: 2 } },
        { id: "3", event: "values", data: { step: 3 } },
      ];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      const stream = client.runs.stream("thread-1", "assistant-1", {
        input: { message: "test" },
        signal: controller.signal,
      });

      const results: any[] = [];
      const consumePromise = (async () => {
        for await (const chunk of stream) {
          results.push(chunk);
          if ("id" in chunk && chunk.id === "1") controller.abort();
        }
      })();

      await consumePromise;

      // Should have stopped early
      expect(results.length).toBeLessThan(3);
    });
  });

  describe("error handling", () => {
    test("propagates HTTP errors immediately", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      );

      const stream = client.runs.stream("thread-1", "assistant-1", {
        input: { message: "test" },
      });

      await expect(gatherStream(stream)).rejects.toThrow();
    });

    test("validates content-type header", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );

      const stream = client.runs.stream("thread-1", "assistant-1", {
        input: { message: "test" },
      });

      await expect(gatherStream(stream)).rejects.toThrow(
        "Expected response header Content-Type to contain 'text/event-stream'"
      );
    });
  });
});
