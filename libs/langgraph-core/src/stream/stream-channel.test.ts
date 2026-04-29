import { describe, expect, it } from "vitest";

import {
  STREAM_CHANNEL_BRAND,
  StreamChannel,
  isStreamChannel,
} from "./stream-channel.js";
import { collectIterator as collect } from "./test-utils.js";

describe("StreamChannel", () => {
  it("creates local-only channels without a protocol name", () => {
    const channel = StreamChannel.local<number>();
    expect(channel.channelName).toBeUndefined();
  });

  it("creates remote channels with a protocol name", () => {
    const channel = StreamChannel.remote<number>("timeline");
    expect(channel.channelName).toBe("timeline");
  });

  it("preserves constructor compatibility for local and remote channels", () => {
    expect(new StreamChannel<number>().channelName).toBeUndefined();
    expect(new StreamChannel<number>("timeline").channelName).toBe("timeline");
  });

  it("iterates pushed values independently for each consumer", async () => {
    const channel = StreamChannel.local<number>();
    channel.push(1);
    channel.push(2);
    channel._close();

    await expect(collect(channel[Symbol.asyncIterator]())).resolves.toEqual([
      1, 2,
    ]);
    await expect(collect(channel[Symbol.asyncIterator]())).resolves.toEqual([
      1, 2,
    ]);
  });

  it("propagates failure to iterators after buffered values", async () => {
    const channel = StreamChannel.local<number>();
    const error = new Error("boom");
    channel.push(1);
    channel._fail(error);

    const iter = channel[Symbol.asyncIterator]();
    await expect(iter.next()).resolves.toEqual({ value: 1, done: false });
    await expect(iter.next()).rejects.toThrow("boom");
  });

  it("supports cursors that start at a specific position", async () => {
    const channel = StreamChannel.local<number>();
    channel.push(10);
    channel.push(20);
    channel.push(30);
    channel.close();

    await expect(collect(channel.iterate(2))).resolves.toEqual([30]);
    await expect(collect(channel.iterate(3))).resolves.toEqual([]);
  });

  it("toAsyncIterable returns independent iterables", async () => {
    const channel = StreamChannel.local<string>();
    channel.push("a");
    channel.push("b");
    channel.close();

    const iterable = channel.toAsyncIterable();
    const first: string[] = [];
    const second: string[] = [];

    for await (const item of iterable) first.push(item);
    for await (const item of iterable) second.push(item);

    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(["a", "b"]);
  });

  it("toEventStream emits pushed values as server-sent events", async () => {
    const channel = StreamChannel.remote<{ msg: string }>("a2a");
    channel.push({ msg: "hello" });
    channel.push({ msg: "world" });
    channel.close();

    await expect(new Response(channel.toEventStream()).text()).resolves.toBe(
      [
        'event: a2a\ndata: {"msg":"hello"}\n\n',
        'event: a2a\ndata: {"msg":"world"}\n\n',
      ].join("")
    );
  });

  it("toEventStream supports local channels with an event override", async () => {
    const channel = StreamChannel.local<string>();
    channel.push("hello");
    channel.close();

    await expect(
      new Response(channel.toEventStream({ event: "custom" })).text()
    ).resolves.toBe('event: custom\ndata: "hello"\n\n');
  });

  it("toEventStream supports starting from a custom cursor", async () => {
    const channel = StreamChannel.remote<number>("numbers");
    channel.push(1);
    channel.push(2);
    channel.push(3);
    channel.close();

    await expect(
      new Response(channel.toEventStream({ startAt: 1 })).text()
    ).resolves.toBe("event: numbers\ndata: 2\n\nevent: numbers\ndata: 3\n\n");
  });

  it("toEventStream supports custom serialization", async () => {
    const channel = StreamChannel.remote<{ text: string }>("messages");
    channel.push({ text: "hello" });
    channel.close();

    await expect(
      new Response(
        channel.toEventStream({
          serialize: (item) => item.text.toUpperCase(),
        })
      ).text()
    ).resolves.toBe("event: messages\ndata: HELLO\n\n");
  });

  it("delivers items pushed after iteration starts", async () => {
    const channel = StreamChannel.local<number>();
    const iter = channel.iterate();
    const firstPromise = iter.next();

    channel.push(42);
    await expect(firstPromise).resolves.toEqual({ value: 42, done: false });

    channel.push(43);
    channel.close();
    await expect(collect(iter)).resolves.toEqual([43]);
  });

  it("exposes buffered size, done state, and indexed access", () => {
    const channel = StreamChannel.local<string>();
    expect(channel.size).toBe(0);
    expect(channel.done).toBe(false);

    channel.push("a");
    channel.push("b");

    expect(channel.size).toBe(2);
    expect(channel.get(0)).toBe("a");
    expect(channel.get(1)).toBe("b");

    channel.close();
    expect(channel.done).toBe(true);
  });

  it("throws for out-of-bounds indexed access", () => {
    const channel = StreamChannel.local<number>();
    channel.push(1);

    expect(() => channel.get(-1)).toThrow(RangeError);
    expect(() => channel.get(1)).toThrow(RangeError);
    expect(() => StreamChannel.local<number>().get(0)).toThrow(RangeError);
  });
});

describe("StreamChannel.isInstance", () => {
  it("recognises real instances", () => {
    const channel = new StreamChannel("timeline");
    expect(StreamChannel.isInstance(channel)).toBe(true);
    expect(isStreamChannel(channel)).toBe(true);
  });

  it("rejects plain objects and primitives", () => {
    expect(StreamChannel.isInstance(null)).toBe(false);
    expect(StreamChannel.isInstance(undefined)).toBe(false);
    expect(StreamChannel.isInstance("channel")).toBe(false);
    expect(StreamChannel.isInstance({})).toBe(false);
    expect(StreamChannel.isInstance({ channelName: "x" })).toBe(false);
  });

  it("accepts branded look-alikes from a different package copy", () => {
    // Simulate a StreamChannel constructed against an independent copy of
    // this module (e.g. a bundled copy from a wrapping library like
    // `langchain`). The class identity differs, so `instanceof` fails —
    // but the shared `Symbol.for` brand still identifies it.
    class DuplicateStreamChannel<T> {
      readonly [STREAM_CHANNEL_BRAND] = true as const;
      readonly channelName?: string;
      constructor(name?: string) {
        this.channelName = name;
      }
      push(_item: T): void {}
      _wire(_fn: (item: T) => void): void {}
      _close(): void {}
      _fail(_err: unknown): void {}
    }

    const foreign = new DuplicateStreamChannel("timeline");

    // oxlint-disable-next-line no-instanceof/no-instanceof
    expect(foreign instanceof StreamChannel).toBe(false);
    expect(StreamChannel.isInstance(foreign)).toBe(true);
    expect(isStreamChannel(foreign)).toBe(true);
  });

  it("rejects objects missing the brand", () => {
    const impostor = {
      channelName: "timeline",
      push: () => {},
      _wire: () => {},
    };
    expect(StreamChannel.isInstance(impostor)).toBe(false);
  });
});
