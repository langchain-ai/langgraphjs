import { describe, it, expect } from "@jest/globals";
import { LastValue } from "../channels/last_value.js";
import { EmptyChannelError, InvalidUpdateError } from "../channels/base.js";
import { Topic } from "../channels/topic.js";
import { BinaryOperatorAggregate } from "../channels/binop.js";

describe("LastValue", () => {
  it("should handle last value correctly", () => {
    const channel = new LastValue<number>();

    expect(() => {
      channel.get();
    }).toThrow(EmptyChannelError);

    expect(() => {
      channel.update([5, 6]);
    }).toThrow(InvalidUpdateError);

    channel.update([3]);
    expect(channel.get()).toBe(3);

    channel.update([4]);
    expect(channel.get()).toBe(4);
  });
  it("should handle emptying correctly", () => {
    // call `.update()` to add a value to the channel
    const channel = new LastValue<number>();
    channel.update([100]);

    const checkpoint = channel.checkpoint();

    const restoredChannel = new LastValue<number>();
    const channel2 = restoredChannel.empty(checkpoint);
    expect(channel2.get()).toBe(100);
  });
});

describe("Topic", () => {
  const channel = new Topic<string>();

  it("should handle updates and get operations", () => {
    channel.update(["a", "b"]);
    expect(channel.get()).toEqual(["a", "b"]);

    channel.update([["c", "d"], "d"]);
    expect(channel.get()).toEqual(["c", "d", "d"]);

    channel.update([]);
    expect(channel.get()).toEqual([]);

    channel.update(["e"]);
    expect(channel.get()).toEqual(["e"]);
  });

  it("should create and use a checkpoint", () => {
    const checkpoint = channel.checkpoint();
    const newChannel = new Topic<string>().empty(checkpoint);
    expect(newChannel.get()).toEqual(["e"]);
  });
});

describe("Topic with unique: true", () => {
  const channel = new Topic<string>({ unique: true });

  it("should de-dupe updates and get the last unique value", () => {
    channel.update(["a", "b"]);
    expect(channel.get()).toEqual(["a", "b"]);

    channel.update(["b", ["c", "d"], "d"]);
    expect(channel.get()).toEqual(["c", "d"]);

    channel.update([]);
    expect(channel.get()).toEqual([]);

    channel.update(["e"]);
    expect(channel.get()).toEqual(["e"]);
  });

  it("should de-dupe from checkpoint", () => {
    const checkpoint = channel.checkpoint();
    const newChannel = new Topic<string>({ unique: true }).empty(checkpoint);

    expect(newChannel.get()).toEqual(["e"]);

    newChannel.update(["d", "f"]);
    expect(newChannel.get()).toEqual(["f"]);
  });
});

describe("Topic with accumulate: true", () => {
  const channel = new Topic<string>({ accumulate: true });

  it("should accumulate updates and get operations", () => {
    channel.update(["a", "b"]);
    expect(channel.get()).toEqual(["a", "b"]);

    channel.update(["b", ["c", "d"], "d"]);
    expect(channel.get()).toEqual(["a", "b", "b", "c", "d", "d"]);

    channel.update([]);
    expect(channel.get()).toEqual(["a", "b", "b", "c", "d", "d"]);
  });

  it("should create and use a checkpoint", () => {
    const checkpoint = channel.checkpoint();
    const newChannel = new Topic<string>({ accumulate: true }).empty(
      checkpoint
    );
    expect(newChannel.get()).toEqual(["a", "b", "b", "c", "d", "d"]);

    newChannel.update(["e"]);
    expect(newChannel.get()).toEqual(["a", "b", "b", "c", "d", "d", "e"]);
  });
});

describe("Topic with accumulate and unique: true", () => {
  const channel = new Topic<string>({ unique: true, accumulate: true });

  it("should handle unique and accumulate updates and get operations", () => {
    channel.update(["a", "b"]);
    expect(channel.get()).toEqual(["a", "b"]);

    channel.update(["b", ["c", "d"], "d"]);
    expect(channel.get()).toEqual(["a", "b", "c", "d"]);

    channel.update([]);
    expect(channel.get()).toEqual(["a", "b", "c", "d"]);
  });

  it("should create and use a checkpoint", () => {
    const checkpoint = channel.checkpoint();
    const newChannel = new Topic<string>({
      unique: true,
      accumulate: true,
    }).empty(checkpoint);
    expect(newChannel.get()).toEqual(["a", "b", "c", "d"]);

    newChannel.update(["d", "e"]);
    expect(newChannel.get()).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("BinaryOperatorAggregate", () => {
  it("should handle binary operator aggregation correctly", () => {
    const channel = new BinaryOperatorAggregate<number>(
      (a, b) => a + b,
      () => 0
    );

    expect(channel.get()).toBe(0);

    channel.update([1, 2, 3]);
    expect(channel.get()).toBe(6);

    channel.update([4]);
    expect(channel.get()).toBe(10);
  });

  it("should handle checkpointing correctly", () => {
    const channel = new BinaryOperatorAggregate<number>(
      (a, b) => a + b,
      () => 0
    );
    channel.update([1, 2, 3]);
    channel.update([4]);

    const checkpoint = channel.checkpoint();

    const restoredChannel = new BinaryOperatorAggregate<number>(
      (a, b) => a + b,
      () => 10
    );
    const channel2 = restoredChannel.empty(checkpoint);
    expect(channel2.get()).toBe(10);
  });
});
