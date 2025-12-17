/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@langchain/langgraph-sdk";
import { RemoteGraph } from "../pregel/remote.js";

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

  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < uint8Arrays.length) {
        controller.enqueue(uint8Arrays[index]);
        index += 1;
      } else {
        controller.close();
      }
    },
  });
};

/**
 * Helper to create a stream that yields some chunks then errors
 * This avoids race conditions with Readable.from() and controller.error()
 */
const createErroringSSEResponseBody = (
  chunks: Array<{ id?: string; event: string; data: unknown }>,
  error: Error
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

  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < uint8Arrays.length) {
        controller.enqueue(uint8Arrays[index]);
        index += 1;
      } else {
        controller.error(error);
      }
    },
  });
};

describe("RemoteGraph with streamResumable", () => {
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

  test("passes streamResumable parameter to client", async () => {
    const chunks = [
      { id: "1", event: "metadata", data: { run_id: "run-1", thread_id: "test_thread" } },
      { id: "2", event: "values", data: { messages: ["hello"] } },
      { id: "3", event: "values", data: { messages: ["hello", "world"] } },
    ];

    mockFetch.mockResolvedValueOnce(
      new Response(createSSEResponseBody(chunks), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          location: "/threads/test_thread/runs/stream",
        },
      })
    );

    const remoteGraph = new RemoteGraph({
      graphId: "test_graph",
      client,
      streamMode: "values",
      streamResumable: true,
    });

    const config = { configurable: { thread_id: "test_thread" } };

    // Consume the stream
    const results = [];
    const stream = await remoteGraph.stream({ input: "test" }, config);
    for await (const chunk of stream) {
      console.log("chunk", chunk);
      results.push(chunk);
    }

    // Verify we got results
    expect(results.length).toBeGreaterThan(0);

    // Verify streamResumable was passed in the request body
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.stream_resumable).toBe(true);
  });

  test.skip("handles network failures during stream and retries with Location header", async () => {
    let callCount = 0;
    const locationPath = "/threads/test_thread/runs/run-1/stream";

    mockFetch.mockImplementation(() => {
      callCount += 1;

      if (callCount === 1) {
        // First call: return partial stream that errors mid-stream
        const partialChunks = [
          { id: "1", event: "metadata", data: { run_id: "run-1", thread_id: "test_thread" } },
          { id: "2", event: "values", data: { messages: ["hello"] } },
        ];

        return Promise.resolve(
          new Response(
            createErroringSSEResponseBody(partialChunks, new TypeError("Network connection lost")),
            {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                location: locationPath,
              },
            }
          )
        );
      } else {
        // Retry: return remaining events after reconnection
        const remainingChunks = [
          { id: "3", event: "values", data: { messages: ["hello", "world"] } },
          { id: "4", event: "end", data: {} },
        ];

        return Promise.resolve(
          new Response(createSSEResponseBody(remainingChunks), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              location: locationPath,
            },
          })
        );
      }
    });

    const remoteGraph = new RemoteGraph({
      graphId: "test_graph",
      client,
      streamResumable: true,
    });

    const config = { configurable: { thread_id: "test_thread" } };

    // This should handle the network failure and retry
    const results: any[] = [];
    const stream = await remoteGraph.stream({ input: "test" }, config);
    for await (const chunk of stream) {
      results.push(chunk);
    }

    // With streamResumable and Location header, the client's retry logic should kick in
    // In this test, we verify the mock was called and we got the initial chunks before error
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(results.length).toBe(4);

    // Verify the Location header was present for retry capability
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.stream_resumable).toBe(true);
  });

  test("streamResumable=false does not enable special handling", async () => {
    const chunks = [
      { event: "metadata", data: { run_id: "run-1", thread_id: "test_thread" } },
    ];

    mockFetch.mockResolvedValueOnce(
      new Response(createErroringSSEResponseBody(chunks, new Error("network error")), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );

    const remoteGraph = new RemoteGraph({
      graphId: "test_graph",
      client,
      streamResumable: false, // Explicitly disabled
    });

    const config = { configurable: { thread_id: "test_thread" } };

    const stream = await remoteGraph.stream({ input: "test" }, config);

    // Should get a chunk first
    const value = await stream.next();
    expect(value).toEqual(chunks[0]);

    await expect(stream.next()).rejects.toThrow("network error");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

