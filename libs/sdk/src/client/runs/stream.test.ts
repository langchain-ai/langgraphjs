import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "../../client.js";
import { MaxReconnectAttemptsError } from "../../utils/stream.js";

type MockFetch = ReturnType<typeof vi.fn> & typeof fetch;

const textEncoder = new TextEncoder();

/**
 * Helper to create an SSE-formatted response body
 * This creates a stream that properly handles cancellation to avoid
 * "Controller is already closed" errors in tests
 */
const createSSEResponseBody = (
  chunks: Array<{ id?: string; event: string; data: unknown }>
): ReadableStream<Uint8Array> => {
  const sseLines = chunks.flatMap((chunk) => {
    const lines: string[] = [];
    if (chunk.id !== undefined) lines.push(`id: ${chunk.id}\n`);
    if (chunk.event) lines.push(`event: ${chunk.event}\n`);
    lines.push(`data: ${JSON.stringify(chunk.data)}\n`);
    lines.push("\n");
    return lines;
  });

  const uint8Arrays = sseLines.map((line) => textEncoder.encode(line));

  // Create a more controlled stream to avoid Node.js Readable issues
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
 */
const createErroringSSEResponseBody = (
  chunks: Array<{ id?: string; event: string; data: unknown }>,
  error: Error
): ReadableStream<Uint8Array> => {
  const sseLines = chunks.flatMap((chunk) => {
    const lines: string[] = [];
    if (chunk.id !== undefined) lines.push(`id: ${chunk.id}\n`);
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
  let mockFetch: MockFetch;
  let client: Client;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = vi.fn() as MockFetch;

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

    test("sends checkpointId as checkpoint_id in the request body", async () => {
      const chunks = [{ id: "1", event: "values", data: {} }];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      const stream = client.runs.stream("thread-1", "assistant-1", {
        input: { message: "test input" },
        checkpointId: "1f0aaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      });

      await gatherStream(stream);

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.checkpoint_id).toBe("1f0aaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    });

    test("sends streamNamespaces in the URL, not the body", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody([]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      await gatherStream(
        client.runs.stream("thread-1", "assistant-1", {
          input: {},
          streamNamespaces: [""],
        })
      );

      const [url, init] = mockFetch.mock.calls[0];
      expect(new URL(url.toString()).searchParams.getAll("namespace")).toEqual(
        [""]
      );
      const body = JSON.parse(init.body as string);
      expect(body).not.toHaveProperty("streamNamespaces");
      expect(body).not.toHaveProperty("namespace");
    });

    test("a run stream that asked for namespaces drops the others", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          createSSEResponseBody([
            { id: "1", event: "values", data: {} },
            { id: "2", event: "messages|tools:a", data: [{}, {}] },
            { id: "3", event: "messages", data: [{}, {}] },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      );

      const events = await gatherStream(
        client.runs.stream("thread-1", "assistant-1", {
          input: {},
          streamNamespaces: [""],
        })
      );

      expect(events.map((e) => e.event)).toEqual(["values", "messages"]);
    });

    test("passes streamMode including tools in request body", async () => {
      const chunks = [{ id: "1", event: "values", data: {} }];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      const stream = client.runs.stream("thread-1", "assistant-1", {
        input: { message: "test" },
        streamMode: ["values", "tools"],
      });

      await gatherStream(stream);

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.stream_mode).toContain("tools");
      expect(body.stream_mode).toContain("values");
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

    test("retries when stream errors before first event if reconnect path exists", async () => {
      let callCount = 0;
      const locationPath = "/threads/thread-1/runs/run-1/stream";

      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith("/runs/run-1")) {
          return Promise.resolve(Response.json({ status: "success" }));
        }
        callCount += 1;

        if (callCount === 1) {
          return Promise.resolve(
            new Response(
              createErroringSSEResponseBody([], new TypeError("terminated")),
              {
                status: 200,
                headers: {
                  "content-type": "text/event-stream",
                  location: locationPath,
                },
              }
            )
          );
        }

        return Promise.resolve(
          new Response(
            createSSEResponseBody([
              { id: "1", event: "values", data: { ok: true } },
            ]),
            {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                location: locationPath,
              },
            }
          )
        );
      });

      const stream = client.runs.stream("thread-1", "assistant-1", {
        input: { message: "test" },
        streamMode: ["values"],
        streamResumable: true,
      });

      const resultsPromise = gatherStream(stream);
      await vi.runAllTimersAsync();
      const results = await resultsPromise;

      expect(callCount).toBe(2);
      expect(results).toHaveLength(1);

      const [, init] = mockFetch.mock.calls[1];
      expect(init.method).toBe("GET");
    });

    test("retries when reconnect request fails with terminated error", async () => {
      let callCount = 0;
      const locationPath = "/threads/thread-1/runs/run-1/stream";

      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith("/runs/run-1")) {
          return Promise.resolve(Response.json({ status: "success" }));
        }
        callCount += 1;

        if (callCount === 1) {
          return Promise.resolve(
            new Response(
              createErroringSSEResponseBody(
                [{ id: "1", event: "values", data: { step: 1 } }],
                new TypeError("terminated")
              ),
              {
                status: 200,
                headers: {
                  "content-type": "text/event-stream",
                  location: locationPath,
                },
              }
            )
          );
        }

        if (callCount === 2) {
          return Promise.reject(new TypeError("terminated"));
        }

        return Promise.resolve(
          new Response(
            createSSEResponseBody([
              { id: "2", event: "values", data: { step: 2 } },
            ]),
            {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                location: locationPath,
              },
            }
          )
        );
      });

      const stream = client.runs.stream("thread-1", "assistant-1", {
        input: { message: "test" },
        streamMode: ["values"],
        streamResumable: true,
      });

      const resultsPromise = gatherStream(stream);
      await vi.runAllTimersAsync();
      const results = await resultsPromise;

      expect(callCount).toBe(3);
      expect(results).toHaveLength(2);
    });
  });

  describe("runs.joinStream()", () => {
    test("joins stream successfully with GET method", async () => {
      const chunks = [
        { id: "1", event: "values", data: { state: "running" } },
        { id: "2", event: "values", data: { state: "complete" } },
        { event: "end", data: { run_id: "run-1", status: "success" } },
      ];

      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      const stream = client.runs.joinStream("thread-1", "run-1");
      const results = await gatherStream(stream);

      expect(results).toHaveLength(3);
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

    test.each(["request", "default"])(
      "clears %s cursor headers after an empty ID and delivers unnamed null",
      async (source) => {
        client = new Client({
          apiUrl: "http://localhost:8000",
          defaultHeaders: source === "default" ? { "lAsT-eVeNt-Id": "stale" } : {},
          callerOptions: { fetch: mockFetch },
        });
        const chunks = [
          { id: "cursor", event: "", data: null },
          { id: "", event: "", data: null },
        ];
        mockFetch.mockResolvedValueOnce(
          new Response(
            createErroringSSEResponseBody(chunks, new TypeError("disconnected")),
            {
              headers: {
                "content-type": "text/event-stream",
                location: "/threads/thread-1/runs/run-1/stream",
              },
            }
          )
        );
        mockFetch.mockResolvedValueOnce(
          new Response(createSSEResponseBody([{ event: "values", data: {} }]))
        );
        mockFetch.mockResolvedValueOnce(Response.json({ status: "success" }));

        const consume = gatherStream(
          client.runs.joinStream("thread-1", "run-1", {
            lastEventId: source === "request" ? "stale" : undefined,
          })
        );
        await vi.runAllTimersAsync();
        expect(await consume).toEqual([
          { id: "cursor", event: "", data: null },
          { id: undefined, event: "", data: null },
          { id: undefined, event: "values", data: {} },
        ]);
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(
          new Headers(mockFetch.mock.calls[0][1].headers).get("last-event-id")
        ).toBe("stale");
        expect(
          new Headers(mockFetch.mock.calls[1][1].headers).has("last-event-id")
        ).toBe(false);
      }
    );

    test.each(["cursor", ""])(
      "consumes control blocks and inherits reconnect cursor %j",
      async (cursor) => {
        const encoder = new TextEncoder();
        const lines = `id: old\ndata: null\n\nid: ${cursor}\n\nretry: 100\n\n`.split(/(?<=\n)/);
        mockFetch.mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              pull(controller) {
                const line = lines.shift();
                if (line !== undefined) controller.enqueue(encoder.encode(line));
                else controller.error(new TypeError("disconnected"));
              },
            }),
            { headers: { location: "/threads/thread-1/runs/run-1/stream" } }
          )
        );
        mockFetch.mockResolvedValueOnce(
          new Response(encoder.encode("data:\n\ndata: null\n\n"))
        );
        mockFetch.mockResolvedValueOnce(Response.json({ status: "success" }));
        const consume = gatherStream(client.runs.joinStream("thread-1", "run-1"));
        await vi.runAllTimersAsync();
        expect(await consume).toEqual([
          { id: "old", event: "", data: null },
          { id: cursor || undefined, event: "", data: null },
          { id: cursor || undefined, event: "", data: null },
        ]);
        expect(new Headers(mockFetch.mock.calls[1][1].headers).get("last-event-id")).toBe(cursor || null);
      }
    );

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

    test("a join that asked for namespaces drops a subagent's events an older pod sent", async () => {
      const chunks = [
        { id: "1", event: "metadata", data: { run_id: "run-1" } },
        { id: "2", event: "values", data: { messages: [] } },
        { id: "3", event: "lifecycle|tools:a", data: { event: "started" } },
        { id: "4", event: "messages|tools:a", data: [{}, {}] },
        { id: "5", event: "values|tools:a", data: { messages: [] } },
        { id: "6", event: "end", data: { status: "success" } },
      ];
      const respond = () =>
        new Response(createSSEResponseBody(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      mockFetch.mockImplementation(() => Promise.resolve(respond()));

      const chat = await gatherStream(
        client.runs.joinStream("thread-1", "run-1", { streamNamespaces: [""] })
      );
      const panel = await gatherStream(
        client.runs.joinStream("thread-1", "run-1", {
          streamNamespaces: ["tools:a"],
        })
      );
      const everything = await gatherStream(
        client.runs.joinStream("thread-1", "run-1")
      );

      expect(chat.map((e) => e.id)).toEqual(["1", "2", "3", "6"]);
      expect(panel.map((e) => e.id)).toEqual(["1", "4", "5", "6"]);
      expect(everything).toHaveLength(chunks.length);
    });

    test("sends streamNamespaces as repeated namespace params", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(createSSEResponseBody([]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );

      await gatherStream(
        client.runs.joinStream("thread-1", "run-1", {
          streamNamespaces: ["", "tools:a"],
        })
      );

      const [url] = mockFetch.mock.calls[0];
      expect(new URL(url.toString()).searchParams.getAll("namespace")).toEqual(
        ["", "tools:a"]
      );
    });

    test.each([
      [
        "keeps the whole query",
        "/threads/thread-1/runs/run-1/stream?namespace=tools%3Aa&cancel_on_disconnect=0",
      ],
      [
        "leaves out namespace",
        "/threads/thread-1/runs/run-1/stream?cancel_on_disconnect=0",
      ],
      ["has no query", "/threads/thread-1/runs/run-1/stream"],
    ])("a reconnect to a Location that %s sends each param once", async (_, locationPath) => {
      let callCount = 0;
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith("/runs/run-1")) {
          return Promise.resolve(Response.json({ status: "success" }));
        }
        callCount += 1;
        const body =
          callCount === 1
            ? createErroringSSEResponseBody(
                [{ id: "1", event: "values", data: {} }],
                new TypeError("terminated")
              )
            : createSSEResponseBody([{ id: "2", event: "values", data: {} }]);
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              location: locationPath,
            },
          })
        );
      });

      const resultsPromise = gatherStream(
        client.runs.joinStream("thread-1", "run-1", {
          streamNamespaces: ["tools:a"],
        })
      );
      await vi.runAllTimersAsync();
      await resultsPromise;

      expect(callCount).toBe(2);
      const [url] = mockFetch.mock.calls[1];
      const params = new URL(url.toString()).searchParams;
      expect(params.getAll("namespace")).toEqual(["tools:a"]);
      expect(params.getAll("cancel_on_disconnect")).toEqual(["0"]);
    });

    test("sends checkpointId as checkpoint_id on the join and its reconnect, next to the last event id", async () => {
      let streamCalls = 0;
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith("/runs/run-1")) {
          return Promise.resolve(Response.json({ status: "success" }));
        }
        streamCalls += 1;
        const body =
          streamCalls === 1
            ? createErroringSSEResponseBody(
                [{ id: "7", event: "values", data: {} }],
                new TypeError("disconnected")
              )
            : createSSEResponseBody([{ id: "8", event: "values", data: {} }]);
        return Promise.resolve(
          new Response(body, {
            headers: {
              "content-type": "text/event-stream",
              location:
                "/threads/thread-1/runs/run-1/stream?cancel_on_disconnect=0&checkpoint_id=cp-1",
            },
          })
        );
      });

      const consume = gatherStream(
        client.runs.joinStream("thread-1", "run-1", {
          lastEventId: "-1",
          checkpointId: "cp-1",
        })
      );
      await vi.runAllTimersAsync();
      await consume;

      expect(
        mockFetch.mock.calls
          .filter(([url]) => url.toString().includes("/stream"))
          .map(([url, init]) => ({
            checkpointId: new URL(url.toString()).searchParams.getAll(
              "checkpoint_id"
            ),
            lastEventId: new Headers(init.headers).get("last-event-id"),
          }))
      ).toEqual([
        { checkpointId: ["cp-1"], lastEventId: "-1" },
        { checkpointId: ["cp-1"], lastEventId: "7" },
      ]);
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

    test("sends the modes as stream_mode and as one comma-joined stream_modes", async () => {
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
      const { searchParams } = new URL(url.toString());
      expect(searchParams.getAll("stream_mode")).toEqual([
        "lifecycle",
        "state_update",
      ]);
      expect(searchParams.getAll("stream_modes")).toEqual([
        "lifecycle,state_update",
      ]);
    });
  });

  describe("per-call reconnect options", () => {
    const dropAfter = (chunks: Array<{ id: string; event: string; data: unknown }>) =>
      new Response(
        createErroringSSEResponseBody(chunks, new TypeError("terminated")),
        {
          headers: {
            "content-type": "text/event-stream",
            location: "/threads/thread-1/runs/run-1/stream",
          },
        }
      );
    const firstEvent = { id: "1", event: "values", data: {} };

    test("maxReconnectAttempts 0 ends a run stream on the first drop", async () => {
      const onReconnect = vi.fn();
      mockFetch.mockResolvedValueOnce(dropAfter([firstEvent]));

      const consume = gatherStream(
        client.runs.stream("thread-1", "assistant-1", {
          maxReconnectAttempts: 0,
          onReconnect,
        })
      ).catch((caught: unknown) => caught);
      await vi.runAllTimersAsync();

      expect(await consume).toBeInstanceOf(MaxReconnectAttemptsError);
      expect(onReconnect).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test("a run stream waits reconnectDelayMs, reports each connection and gives up after maxReconnectAttempts", async () => {
      const onReconnect = vi.fn();
      const onConnected = vi.fn();
      mockFetch
        .mockResolvedValueOnce(dropAfter([firstEvent]))
        .mockResolvedValueOnce(dropAfter([]));

      let settled = false;
      const consume = gatherStream(
        client.runs.stream("thread-1", "assistant-1", {
          maxReconnectAttempts: 1,
          reconnectDelayMs: () => 60_000,
          onReconnect,
          onConnected,
        })
      )
        .catch((caught: unknown) => caught)
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTimersAsync();
      expect(await consume).toBeInstanceOf(MaxReconnectAttemptsError);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(onConnected.mock.calls).toEqual([
        [{ kind: "initial", attempt: 0 }],
        [{ kind: "reconnected", attempt: 1 }],
      ]);
      expect(onReconnect.mock.calls).toEqual([
        [
          expect.objectContaining({
            attempt: 1,
            delayMs: 60_000,
            lastEventId: "1",
          }),
        ],
      ]);
    });

    test("a run join takes the same reconnect options", async () => {
      const onReconnect = vi.fn();
      const onConnected = vi.fn();
      mockFetch
        .mockResolvedValueOnce(dropAfter([firstEvent]))
        .mockResolvedValueOnce(dropAfter([]));

      const consume = gatherStream(
        client.runs.joinStream("thread-1", "run-1", {
          maxReconnectAttempts: 1,
          reconnectDelayMs: () => 0,
          onReconnect,
          onConnected,
        })
      ).catch((caught: unknown) => caught);
      await vi.runAllTimersAsync();

      expect(await consume).toBeInstanceOf(MaxReconnectAttemptsError);
      expect(onConnected.mock.calls).toEqual([
        [{ kind: "initial", attempt: 0 }],
        [{ kind: "reconnected", attempt: 1 }],
      ]);
      expect(onReconnect.mock.calls).toEqual([
        [expect.objectContaining({ attempt: 1, delayMs: 0 })],
      ]);
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

  describe("clean close before the run ends", () => {
    const createRun = "POST /threads/thread-1/runs/stream";
    const joinRun = "GET /threads/thread-1/runs/run-1/stream";
    const runCheck = "GET /threads/thread-1/runs/run-1";
    const values = { id: "1", event: "values", data: {} };

    const runStream = (
      chunks: Array<{ id?: string; event: string; data: unknown }>,
      location: string | null = "/threads/thread-1/runs/run-1/stream"
    ) =>
      new Response(createSSEResponseBody(chunks), {
        headers: {
          "content-type": "text/event-stream",
          ...(location != null && { location }),
        },
      });

    const httpStatus = (status: number) => async () =>
      new Response(`HTTP ${status}`, { status });

    const runStatus = (status: string) => async () => Response.json({ status });

    const requests = () =>
      mockFetch.mock.calls.map(
        ([url, init]) => `${init.method ?? "GET"} ${new URL(url).pathname}`
      );

    const unreadResponses = async () => {
      const results = await Promise.allSettled(
        mockFetch.mock.results.map((result) => result.value)
      );
      return results.flatMap((result) =>
        result.status === "fulfilled" && !result.value.bodyUsed
          ? [result.value]
          : []
      );
    };

    test.each([
      { name: "status running", check: runStatus("running") },
      { name: "status pending", check: runStatus("pending") },
      { name: "HTTP 503", check: httpStatus(503) },
      { name: "HTTP 429", check: httpStatus(429) },
      {
        name: "a network error",
        check: () => Promise.reject(new TypeError("fetch failed")),
      },
      {
        name: "a timeout",
        check: () =>
          Promise.reject(new DOMException("timed out", "TimeoutError")),
      },
      {
        name: "status running under a path prefix",
        check: runStatus("running"),
        prefix: "/api",
        query: "?x=1",
      },
    ])(
      "reconnects from the last event after a run check with $name",
      async ({ check, prefix = "", query = "" }) => {
        const run = `${prefix}/threads/thread-1/runs/run-1`;
        const next = { id: "2", event: "values", data: { step: 2 } };
        mockFetch
          .mockResolvedValueOnce(runStream([values], `${run}/stream${query}`))
          .mockImplementationOnce(check)
          .mockResolvedValueOnce(runStream([next], `${run}/stream${query}`))
          .mockImplementationOnce(runStatus("success"));

        const consume = gatherStream(
          client.runs.stream("thread-1", "assistant-1")
        );
        await vi.runAllTimersAsync();

        expect(await consume).toEqual([values, next]);
        expect(requests()).toEqual([
          createRun,
          `GET ${run}`,
          `GET ${run}/stream`,
          `GET ${run}`,
        ]);
        expect(mockFetch.mock.calls[1][0]).toBe(`http://localhost:8000${run}`);
        expect(
          new Headers(mockFetch.mock.calls[2][1].headers).get("last-event-id")
        ).toBe("1");
        expect(await unreadResponses()).toEqual([]);
      }
    );

    test("ends after one run check when the run succeeded", async () => {
      mockFetch
        .mockResolvedValueOnce(runStream([values]))
        .mockImplementationOnce(runStatus("success"));

      const results = await gatherStream(
        client.runs.joinStream("thread-1", "run-1")
      );

      expect(results).toEqual([values]);
      expect(requests()).toEqual([joinRun, runCheck]);
    });

    test.each([
      { name: "HTTP 404", check: httpStatus(404) },
      { name: "HTTP 403", check: httpStatus(403) },
      {
        name: "a body that is not JSON",
        check: async () => new Response("<html></html>"),
      },
      {
        name: "a request that fails another way",
        check: () => Promise.reject(new Error("boom")),
      },
    ])("ends quietly after a run check with $name", async ({ check }) => {
      mockFetch
        .mockResolvedValueOnce(runStream([values]))
        .mockImplementationOnce(check);

      const consume = gatherStream(
        client.runs.stream("thread-1", "assistant-1")
      );
      await vi.runAllTimersAsync();

      expect(await consume).toEqual([values]);
      expect(requests()).toEqual([createRun, runCheck]);
      expect(await unreadResponses()).toEqual([]);
    });

    test.each(["end", "error"])(
      "skips the run check after an %s event",
      async (event) => {
        mockFetch.mockResolvedValueOnce(
          runStream([values, { event, data: null }])
        );

        await gatherStream(client.runs.stream("thread-1", "assistant-1"));

        expect(requests()).toEqual([createRun]);
      }
    );

    test.each([
      {
        name: "a thread stream",
        location: "/threads/thread-1/stream",
        open: () => client.threads.joinStream("thread-1"),
      },
      {
        name: "a stateless run stream",
        location: "/runs/run-1/stream",
        open: () => client.runs.stream(null, "assistant-1"),
      },
    ])("skips the run check for $name", async ({ location, open }) => {
      mockFetch.mockResolvedValueOnce(runStream([values], location));

      await gatherStream<unknown>(open());

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test.each([
      {
        name: "the run stays running",
        check: runStatus("running"),
        cause: "Stream closed before the run finished",
      },
      {
        name: "the run check keeps failing",
        check: httpStatus(503),
        cause: "Run status check failed with HTTP 503",
      },
    ])(
      "gives up after the max reconnect attempts when $name and rejoins bring no events",
      async ({ check, cause }) => {
        mockFetch
          .mockResolvedValueOnce(runStream([values]))
          .mockImplementation(async (url: string) =>
            url.endsWith("/runs/run-1") ? check() : runStream([])
          );

        const consume = gatherStream(
          client.runs.stream("thread-1", "assistant-1")
        ).catch((error: unknown) => error);
        await vi.runAllTimersAsync();

        const error = await consume;
        expect(error).toBeInstanceOf(MaxReconnectAttemptsError);
        expect(error).toHaveProperty("cause.message", cause);
        expect(requests().filter((r) => r === joinRun)).toHaveLength(5);
        expect(requests().filter((r) => r === runCheck)).toHaveLength(6);
      }
    );

    test("sends the run check as JSON with the client's auth and custom headers only", async () => {
      client = new Client({
        apiUrl: "http://localhost:8000",
        apiKey: "test-key",
        defaultHeaders: { "x-custom": "custom", "Last-Event-ID": "stale" },
        callerOptions: { fetch: mockFetch },
      });
      mockFetch
        .mockResolvedValueOnce(runStream([values]))
        .mockImplementationOnce(runStatus("success"));

      await gatherStream(
        client.runs.joinStream("thread-1", "run-1", { lastEventId: "4" })
      );

      expect(requests()[1]).toBe(runCheck);
      expect(mockFetch.mock.calls[1][1].headers).toEqual({
        accept: "application/json",
        "x-api-key": "test-key",
        "x-custom": "custom",
      });
    });

    test("rejoins a run stream without Location by the run id in its first event", async () => {
      const metadata = { id: "0", event: "metadata", data: { run_id: "run-1" } };
      const next = { id: "2", event: "values", data: { step: 2 } };
      const onRunCreated = vi.fn();
      mockFetch
        .mockResolvedValueOnce(runStream([metadata, values], null))
        .mockImplementationOnce(runStatus("running"))
        .mockResolvedValueOnce(runStream([next], null))
        .mockImplementationOnce(runStatus("success"));

      const consume = gatherStream(
        client.runs.stream("thread-1", "assistant-1", {
          onRunCreated,
          streamResumable: true,
        })
      );
      await vi.runAllTimersAsync();

      expect(await consume).toEqual([metadata, values, next]);
      expect(onRunCreated.mock.calls).toEqual([
        [{ run_id: "run-1", thread_id: "thread-1" }],
      ]);
      expect(requests()).toEqual([createRun, runCheck, joinRun, runCheck]);
      expect(
        new Headers(mockFetch.mock.calls[2][1].headers).get("last-event-id")
      ).toBe("1");
    });

    test("rejoins a threadless run stream without Location through its Content-Location", async () => {
      const temporaryRun = "/threads/temporary-thread/runs/run-1";
      const next = { id: "2", event: "values", data: { step: 2 } };
      mockFetch
        .mockResolvedValueOnce(
          new Response(createSSEResponseBody([values]), {
            headers: {
              "content-type": "text/event-stream",
              "content-location": temporaryRun,
            },
          })
        )
        .mockImplementationOnce(runStatus("running"))
        .mockResolvedValueOnce(runStream([next], null))
        .mockImplementationOnce(runStatus("success"));

      const consume = gatherStream(
        client.runs.stream(null, "assistant-1", { streamResumable: true })
      );
      await vi.runAllTimersAsync();

      expect(await consume).toEqual([values, next]);
      expect(requests()).toEqual([
        "POST /runs/stream",
        `GET ${temporaryRun}`,
        `GET ${temporaryRun}/stream`,
        `GET ${temporaryRun}`,
      ]);
    });

    test("fails a run stream that isn't resumable on a drop without Location", async () => {
      const metadata = { id: "0", event: "metadata", data: { run_id: "run-1" } };
      mockFetch.mockResolvedValueOnce(
        new Response(
          createErroringSSEResponseBody([metadata], new TypeError("terminated")),
          { headers: { "content-type": "text/event-stream" } }
        )
      );

      await expect(
        gatherStream(client.runs.stream("thread-1", "assistant-1"))
      ).rejects.toThrow("terminated");
      expect(requests()).toEqual([createRun]);
    });

    test("rejoins a run join without Location at its own URL", async () => {
      const next = { id: "2", event: "values", data: { step: 2 } };
      mockFetch
        .mockResolvedValueOnce(runStream([values], null))
        .mockImplementationOnce(runStatus("running"))
        .mockResolvedValueOnce(runStream([next], null))
        .mockImplementationOnce(runStatus("success"));

      const consume = gatherStream(client.runs.joinStream("thread-1", "run-1"));
      await vi.runAllTimersAsync();

      expect(await consume).toEqual([values, next]);
      expect(requests()).toEqual([joinRun, runCheck, joinRun, runCheck]);
    });
  });
});
