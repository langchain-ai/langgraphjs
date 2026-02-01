import { describe, expect, test, vi } from "vitest";
import { FetchStreamTransport } from "../stream.transport.js";

const textEncoder = new TextEncoder();

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

async function gather<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of stream) out.push(x);
  return out;
}

describe("FetchStreamTransport", () => {
  test("POSTs JSON and parses SSE events (including config)", async () => {
    const mockFetch = vi.fn();

    const chunks = [
      { id: "1", event: "values", data: { hello: "world" } },
      { id: "2", event: "custom", data: { ok: true } },
    ];

    mockFetch.mockResolvedValueOnce(
      new Response(createSSEResponseBody(chunks), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );

    const transport = new FetchStreamTransport({
      apiUrl: "http://example.test/stream",
      defaultHeaders: { "x-test": "1" },
      fetch: mockFetch as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    const controller = new AbortController();
    const stream = await transport.stream({
      input: { foo: "bar" },
      context: { userId: "u1" } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      command: { type: "resume" } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      config: { configurable: { thread_id: "t1" } } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      signal: controller.signal,
    });

    const events = await gather(stream);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ id: "1", event: "values" });
    expect(events[1]).toMatchObject({ id: "2", event: "custom" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://example.test/stream");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-test": "1",
    });

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      input: { foo: "bar" },
      context: { userId: "u1" },
      command: { type: "resume" },
      config: { configurable: { thread_id: "t1" } },
    });
  });
});
