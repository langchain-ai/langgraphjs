import { describe, expect, it } from "vitest";
import { ProtocolSseTransportAdapter } from "../client/stream/transport/http.js";
import { BytesLineDecoder, SSEDecoder } from "./sse.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const output: T[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return output;
      output.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function decodeLines(chunks: Uint8Array[]): Promise<string[]> {
  const lines = await collect(
    byteStream(chunks).pipeThrough(BytesLineDecoder())
  );
  return lines.map((line) => decoder.decode(line));
}

describe("BytesLineDecoder line boundaries", () => {
  it.each<[string, string[]]>([
    ["", []],
    ["\r", [""]],
    ["\r\r", ["", ""]],
    ["line\r", ["line"]],
    ["line\r\r", ["line", ""]],
    ["line\r\n\r", ["line", ""]],
    ["line\n\r", ["line", ""]],
    ["line\r\n", ["line"]],
    ["line\r\n\r\n", ["line", ""]],
    ["line", ["line"]],
  ])("decodes %j at every byte split", async (text, expected) => {
    const bytes = encoder.encode(text);
    for (let split = 0; split <= bytes.length; split += 1) {
      expect(
        await decodeLines([
          bytes.subarray(0, split),
          new Uint8Array(),
          bytes.subarray(split),
          new Uint8Array(),
        ])
      ).toEqual(expected);
    }
  });

  it.each(["\r", "\n", "\r\n"])(
    "preserves UTF-8 with %j line endings at every byte split",
    async (newline) => {
      const bytes = encoder.encode(
        `你好🙂${newline}${newline}終${newline}${newline}`
      );
      const expected = ["你好🙂", "", "終", ""];
      for (let split = 0; split <= bytes.length; split += 1) {
        expect(
          await decodeLines([bytes.subarray(0, split), bytes.subarray(split)])
        ).toEqual(expected);
      }
      expect(
        await decodeLines(Array.from(bytes, (byte) => new Uint8Array([byte])))
      ).toEqual(expected);
    }
  );

  it.each(["line\r", "\r"])(
    "emits %j without waiting for another chunk or EOF",
    async (text) => {
      const transform = BytesLineDecoder();
      const writer = transform.writable.getWriter();
      const reader = transform.readable.getReader();
      const pending = reader.read();
      try {
        await writer.write(encoder.encode(text));
        const result = await Promise.race([pending, Promise.resolve(null)]);
        expect(result).not.toBeNull();
        expect(result?.done).toBe(false);
        expect(decoder.decode(result?.value)).toBe(text.slice(0, -1));
      } finally {
        await writer.close();
        await pending;
        reader.releaseLock();
        writer.releaseLock();
      }
    }
  );

  it("does not insert a blank line when an LF follows a CR across empty chunks", async () => {
    expect(
      await decodeLines([
        encoder.encode("first\r"),
        new Uint8Array(),
        new Uint8Array(),
        encoder.encode("\nsecond\r"),
        new Uint8Array(),
        encoder.encode("\n"),
      ])
    ).toEqual(["first", "second"]);
  });

  it.each(["\r", "\n", "\r\n"])(
    "dispatches a data-only SSE frame terminated with %j",
    async (newline) => {
      const bytes = encoder.encode(
        `data: {"value":"你好🙂"}${newline}${newline}`
      );
      for (let split = 0; split <= bytes.length; split += 1) {
        const events = await collect(
          byteStream([bytes.subarray(0, split), bytes.subarray(split)])
            .pipeThrough(BytesLineDecoder())
            .pipeThrough(SSEDecoder())
        );
        expect(events).toEqual([
          { id: undefined, event: "", data: { value: "你好🙂" } },
        ]);
      }
    }
  );

  it("delivers the final CR-delimited event through the protocol transport", async () => {
    const message = { method: "values", params: { count: 42 } };
    const transport = new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:8123",
      threadId: "test-thread",
      maxReconnectAttempts: 0,
      idleReconnect: 0,
      fetch: async () =>
        new Response(`data: ${JSON.stringify(message)}\r\r`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    const handle = transport.openEventStream({ channels: ["values"] });
    try {
      await handle.ready;
      const messages = [];
      for await (const event of handle.events) messages.push(event);
      expect(messages).toEqual([message]);
    } finally {
      handle.close();
      await transport.close();
    }
  });
});
