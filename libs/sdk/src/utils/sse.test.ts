import { describe, test, expect } from "vitest";
import { Readable } from "node:stream";
import { IterableReadableStream } from "./stream.js";
import { BytesLineDecoder, SSEDecoder } from "./sse.js";

const gather = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
  const results: T[] = [];
  const iterator = IterableReadableStream.fromReadableStream(stream);
  for await (const chunk of iterator) results.push(chunk);
  return results;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

describe("BytesLineDecoder", () => {
  const createStream = (chunks: Uint8Array[]) => {
    return Readable.toWeb(Readable.from(chunks)) as ReadableStream<Uint8Array>;
  };

  test("handles single line with newline", async () => {
    const input = createStream([textEncoder.encode("hello\n")]);
    const decoded = input.pipeThrough(BytesLineDecoder());
    const results = await gather(decoded);

    expect(results.length).toBe(1);
    expect(textDecoder.decode(results[0])).toBe("hello");
  });

  test("handles multiple lines", async () => {
    const input = createStream([textEncoder.encode("line1\nline2\nline3\n")]);
    const decoded = input.pipeThrough(BytesLineDecoder());
    const results = await gather(decoded);

    expect(results.length).toBe(3);
    expect(textDecoder.decode(results[0])).toBe("line1");
    expect(textDecoder.decode(results[1])).toBe("line2");
    expect(textDecoder.decode(results[2])).toBe("line3");
  });

  test("handles split chunks", async () => {
    const input = createStream([
      textEncoder.encode("li"),
      textEncoder.encode("ne1\nli"),
      textEncoder.encode("ne2\n"),
    ]);
    const decoded = input.pipeThrough(BytesLineDecoder());
    const results = await gather(decoded);

    expect(results.length).toBe(2);
    expect(textDecoder.decode(results[0])).toBe("line1");
    expect(textDecoder.decode(results[1])).toBe("line2");
  });

  test("handles CR LF line endings", async () => {
    const input = createStream([textEncoder.encode("line1\r\nline2\r\n")]);
    const decoded = input.pipeThrough(BytesLineDecoder());
    const results = await gather(decoded);

    expect(results.length).toBe(2);
    expect(textDecoder.decode(results[0])).toBe("line1");
    expect(textDecoder.decode(results[1])).toBe("line2");
  });

  test("handles split CR LF", async () => {
    const input = createStream([
      textEncoder.encode("line1\r"),
      textEncoder.encode("\nline2\r\n"),
    ]);
    const decoded = input.pipeThrough(BytesLineDecoder());
    const results = await gather(decoded);

    expect(results.length).toBe(2);
    expect(textDecoder.decode(results[0])).toBe("line1");
    expect(textDecoder.decode(results[1])).toBe("line2");
  });

  test("emits a CR-terminated line before the next chunk arrives", async () => {
    const decoder = BytesLineDecoder();
    const writer = decoder.writable.getWriter();
    const nextLine = decoder.readable.getReader().read();

    await writer.write(textEncoder.encode("line1\r"));
    const result = await Promise.race([
      nextLine.then(({ value }) => textDecoder.decode(value)),
      new Promise((resolve) => setTimeout(() => resolve("<still held>"), 50)),
    ]);

    expect(result).toBe("line1");
  });

  test("keeps the empty line ended by a final CR", async () => {
    const input = createStream([textEncoder.encode("line1\r\r")]);
    const results = await gather(input.pipeThrough(BytesLineDecoder()));

    expect(results.map((line) => textDecoder.decode(line))).toEqual([
      "line1",
      "",
    ]);
  });

  test("handles stale line", async () => {
    const input = createStream([textEncoder.encode("hello")]);
    const decoded = input.pipeThrough(BytesLineDecoder());
    const results = await gather(decoded);

    expect(results.length).toBe(1);
    expect(textDecoder.decode(results[0])).toBe("hello");
  });
});

describe("SSEDecoder", () => {
  const createStream = (lines: string[]) => {
    return Readable.toWeb(
      Readable.from(lines.map((line) => textEncoder.encode(line)))
    ) as ReadableStream<Uint8Array>;
  };

  const decode = (text: string) =>
    gather(
      createStream([...text])
        .pipeThrough(BytesLineDecoder())
        .pipeThrough(SSEDecoder())
    );

  test("assembles multiline JSON with empty data fields", async () => {
    expect(
      await decode('data: {\ndata\ndata: "value":\ndata:\ndata: 1\ndata: }\n\n')
    ).toEqual([{ id: undefined, event: "", data: { value: 1 } }]);
    await expect(decode("data: 1\ndata: 2\n\n")).rejects.toThrow(SyntaxError);
    expect(await decode("data\n\n")).toEqual([
      { id: undefined, event: "", data: null },
    ]);
    expect(await decode("data:\ndata:\n\n")).toEqual([
      { id: undefined, event: "", data: null },
    ]);
  });

  test("handles colonless event clearing and ID reset without phantom events", async () => {
    expect(
      await decode(
        'id: cursor\nevent: stale\nevent\ndata: null\n\n\n: heartbeat\n\nid\n\ndata: false\n\n'
      )
    ).toEqual([
      { id: "cursor", event: "", data: null },
      { id: "", event: "", data: null },
      { id: "", event: "", data: false },
    ]);
  });

  test("ignores NUL IDs and preserves inherited IDs on unnamed JSON events", async () => {
    expect(
      await decode("id: cursor\ndata: 0\n\nid: bad\0id\ndata: null\n\n")
    ).toEqual([
      { id: "cursor", event: "", data: 0 },
      { id: "cursor", event: "", data: null },
    ]);
  });

  test("strips only a stream-leading BOM, including split UTF-8 bytes", async () => {
    const bytes = textEncoder.encode(
      '\ufeffid: \ufeffcursor\nevent: \ufeffnamed\ndata: "\ufeffvalue"\n\n\ufeffevent: ignored\ndata: null\n\n'
    );
    const input = Readable.toWeb(
      Readable.from(Array.from(bytes, (byte) => Uint8Array.of(byte)))
    ) as ReadableStream<Uint8Array>;
    expect(
      await gather(input.pipeThrough(BytesLineDecoder()).pipeThrough(SSEDecoder()))
    ).toEqual([
      { id: "\ufeffcursor", event: "\ufeffnamed", data: "\ufeffvalue" },
      { id: "\ufeffcursor", event: "", data: null },
    ]);
    await expect(decode("data: \ufeffnull\n\n")).rejects.toThrow(SyntaxError);
  });

  test.each(["1x", "+1", "-1", "1.5", " 1", "１", ""])(
    "ignores invalid retry value %j",
    async (value) => {
      expect(await decode(`retry: ${value}\n\n`)).toEqual([]);
    }
  );

  test("retains retry-only and named EOF compatibility", async () => {
    expect(await decode("retry: 001\n\n")).toEqual([
      { id: undefined, event: "", data: null },
    ]);
    expect(
      await decode('event: values\ndata: {\ndata: "value": 1\ndata: }')
    ).toEqual([{ id: undefined, event: "values", data: { value: 1 } }]);
  });

  test("decodes simple event", async () => {
    const input = createStream([
      "event: test\n",
      'data: {"message": "hello"}\n',
      "\n",
    ]);
    const decoded = input
      .pipeThrough(BytesLineDecoder())
      .pipeThrough(SSEDecoder());

    const results = await gather(decoded);
    expect(results.length).toBe(1);
    expect(results[0]).toEqual({
      event: "test",
      data: { message: "hello" },
    });
  });

  test("ignores comments", async () => {
    const input = createStream([
      ": this is a comment\n",
      "event: test\n",
      'data: {"message": "hello"}\n',
    ]);
    const decoded = input
      .pipeThrough(BytesLineDecoder())
      .pipeThrough(SSEDecoder());

    const results = await gather(decoded);
    expect(results.length).toBe(1);
    expect(results[0]).toEqual({
      event: "test",
      data: { message: "hello" },
    });
  });

  test("handles multiple events", async () => {
    const input = createStream([
      "event: test1\n",
      'data: {"message": "hello"}\n',
      "\n",
      "event: test2\n",
      'data: {"message": "world"}\n',
      "\n",
    ]);
    const decoded = input
      .pipeThrough(BytesLineDecoder())
      .pipeThrough(SSEDecoder());

    const results = await gather(decoded);
    expect(results.length).toBe(2);
    expect(results[0]).toEqual({
      event: "test1",
      data: { message: "hello" },
    });
    expect(results[1]).toEqual({
      event: "test2",
      data: { message: "world" },
    });
  });

  test("end event without data", async () => {
    const input = createStream(["event: test\n"]);
    const decoded = input
      .pipeThrough(BytesLineDecoder())
      .pipeThrough(SSEDecoder());

    const results = await gather(decoded);
    expect(results.length).toBe(1);
    expect(results[0]).toEqual({
      event: "test",
      data: null,
    });
  });

  test("end event without newline", async () => {
    const input = createStream(["event: end"]);
    const decoded = input
      .pipeThrough(BytesLineDecoder())
      .pipeThrough(SSEDecoder());

    const results = await gather(decoded);
    expect(results.length).toBe(1);
    expect(results[0]).toEqual({
      event: "end",
      data: null,
    });
  });
});
