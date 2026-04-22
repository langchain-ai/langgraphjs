import { describe, expect, it } from "vitest";

import {
  STREAM_CHANNEL_BRAND,
  StreamChannel,
  isStreamChannel,
} from "./stream-channel.js";

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
      readonly channelName: string;
      constructor(name: string) {
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
