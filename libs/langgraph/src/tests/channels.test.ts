import { describe, it, expect } from "vitest";
import { AnyValue } from "../channels/any_value.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { LastValue } from "../channels/last_value.js";
import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
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
  it("should handle restoring from checkpoint correctly", () => {
    // call `.update()` to add a value to the channel
    const channel = new LastValue<number>();
    channel.update([100]);

    const checkpoint = channel.checkpoint();

    const restoredChannel = new LastValue<number>();
    const channel2 = restoredChannel.fromCheckpoint(checkpoint);
    expect(channel2.get()).toBe(100);
  });

  it.each([0, "", false, null])("should handle '%s'", (value) => {
    const channel = new LastValue<unknown>();
    channel.update([value]);
    expect(channel.get()).toBe(value);

    const checkpoint = channel.checkpoint();

    const restoredChannel = new LastValue<unknown>();
    const channel2 = restoredChannel.fromCheckpoint(checkpoint);
    expect(channel2.get()).toBe(value);
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
    expect(() => channel.get()).toThrow(EmptyChannelError);

    channel.update(["e"]);
    expect(channel.get()).toEqual(["e"]);
  });

  it("should create and use a checkpoint", () => {
    const checkpoint = channel.checkpoint();
    const newChannel = new Topic<string>().fromCheckpoint(checkpoint);
    expect(newChannel.get()).toEqual(["e"]);
  });

  it.each([0, "", false, null])("should handle '%s'", (value) => {
    const channel = new Topic<unknown>();
    channel.update([value]);

    expect(channel.get()).toEqual([value]);

    const checkpoint = channel.checkpoint();
    const newChannel = new Topic<unknown>().fromCheckpoint(checkpoint);
    expect(newChannel.get()).toEqual([value]);
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
    expect(() => channel.get()).toThrow(EmptyChannelError);

    channel.update(["e"]);
    expect(channel.get()).toEqual(["e"]);
  });

  it("should de-dupe from checkpoint", () => {
    const checkpoint = channel.checkpoint();
    const newChannel = new Topic<string>({ unique: true }).fromCheckpoint(
      checkpoint
    );

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
    const newChannel = new Topic<string>({ accumulate: true }).fromCheckpoint(
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
    }).fromCheckpoint(checkpoint);
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
    const channel2 = restoredChannel.fromCheckpoint(checkpoint);
    expect(channel2.get()).toBe(10);
  });
});

describe("AnyValue", () => {
  it("should handle any value correctly", () => {
    const channel = new AnyValue<number>();

    expect(() => {
      channel.get();
    }).toThrow(EmptyChannelError);

    channel.update([3]);
    expect(channel.get()).toBe(3);

    channel.update([4, 5]);
    expect(channel.get()).toBe(5);
  });

  it.each([0, "", false, null])("should handle '%s'", (value) => {
    const channel = new AnyValue<unknown>();
    channel.update([value]);
    expect(channel.get()).toBe(value);

    const checkpoint = channel.checkpoint();

    const restoredChannel = new AnyValue<unknown>();
    const channel2 = restoredChannel.fromCheckpoint(checkpoint);
    expect(channel2.get()).toBe(value);
  });
});

describe("EphemeralValue with guard: false", () => {
  it("should handle ephemeral value correctly", () => {
    const channel = new EphemeralValue<number>(false);

    expect(() => {
      channel.get();
    }).toThrow(EmptyChannelError);

    channel.update([3]);
    expect(channel.get()).toBe(3);

    channel.update([4, 5]);
    expect(channel.get()).toBe(5);
  });

  it.each([0, "", false, null])("should handle '%s'", (value) => {
    const channel = new EphemeralValue<unknown>(false);
    channel.update([value]);
    expect(channel.get()).toBe(value);
  });

  it.each([0, "", false, null])("should handle '%s'", (value) => {
    const channel = new EphemeralValue<unknown>(false);
    channel.update([value]);
    expect(channel.get()).toBe(value);

    const checkpoint = channel.checkpoint();

    const restoredChannel = new EphemeralValue<unknown>(false);
    const channel2 = restoredChannel.fromCheckpoint(checkpoint);
    expect(channel2.get()).toBe(value);
  });
});

it.each(
  [LastValue, AnyValue, EphemeralValue].map((Channel) => ({
    channel: Channel,
  }))
)("$channel.name should handle undefined values", (Channel) => {
  const channel = new Channel.channel<number | undefined>();
  expect(() => {
    channel.get();
  }).toThrow(EmptyChannelError);
  channel.update([undefined]);
  expect(channel.get()).toBe(undefined);
  channel.update([3]);
  expect(channel.get()).toBe(3);
  channel.update([undefined]);
  expect(channel.get()).toBe(undefined);
});
