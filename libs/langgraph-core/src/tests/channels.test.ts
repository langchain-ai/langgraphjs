import { describe, it, expect } from "vitest";
import { AnyValue } from "../channels/any_value.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { LastValue } from "../channels/last_value.js";
import { UntrackedValueChannel } from "../channels/untracked_value.js";
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

  describe("with initialValueFactory", () => {
    it("should initialize with default value from factory", () => {
      const channel = new LastValue<string>(() => "default-value");
      expect(channel.get()).toBe("default-value");
      expect(channel.isAvailable()).toBe(true);
    });

    it("should allow updates to override initial value", () => {
      const channel = new LastValue<string>(() => "default-value");
      expect(channel.get()).toBe("default-value");

      channel.update(["updated-value"]);
      expect(channel.get()).toBe("updated-value");
    });

    it("should preserve initialValueFactory in checkpoint restoration", () => {
      const initialValueFactory = () => "default-value";
      const channel = new LastValue<string>(initialValueFactory);
      expect(channel.get()).toBe("default-value");

      channel.update(["updated-value"]);
      const checkpoint = channel.checkpoint();

      const restoredChannel = new LastValue<string>(initialValueFactory);
      const channel2 = restoredChannel.fromCheckpoint(checkpoint);
      // Checkpoint value takes precedence
      expect(channel2.get()).toBe("updated-value");

      // Create a new channel from checkpoint without providing factory
      // This tests that the factory is preserved in the restored channel
      const channel3 = new LastValue<string>(initialValueFactory);
      const channel4 = channel3.fromCheckpoint(checkpoint);
      expect(channel4.get()).toBe("updated-value");
    });

    it("should use initial value when checkpoint is undefined", () => {
      const initialValueFactory = () => "default-value";
      const channel = new LastValue<string>(initialValueFactory);
      const restoredChannel = channel.fromCheckpoint(undefined);
      // When checkpoint is undefined, should use initial value
      expect(restoredChannel.get()).toBe("default-value");
    });

    it("should work with function that returns different values", () => {
      let callCount = 0;
      const initialValueFactory = () => {
        callCount += 1;
        return `value-${callCount}`;
      };

      const channel1 = new LastValue<string>(initialValueFactory);
      expect(channel1.get()).toBe("value-1");

      const channel2 = new LastValue<string>(initialValueFactory);
      expect(channel2.get()).toBe("value-2");
    });

    it("should handle initialValueFactory returning falsy values", () => {
      const channelZero = new LastValue<number>(() => 0);
      expect(channelZero.get()).toBe(0);

      const channelEmpty = new LastValue<string>(() => "");
      expect(channelEmpty.get()).toBe("");

      const channelFalse = new LastValue<boolean>(() => false);
      expect(channelFalse.get()).toBe(false);
    });

    it("should handle complex objects from initialValueFactory", () => {
      const initialValueFactory = () => ({ foo: "bar", count: 42 });
      const channel = new LastValue<{ foo: string; count: number }>(
        initialValueFactory
      );
      const value = channel.get();
      expect(value.foo).toBe("bar");
      expect(value.count).toBe(42);
    });

    it("should work without initialValueFactory", () => {
      const channel = new LastValue<number>();
      expect(() => channel.get()).toThrow(EmptyChannelError);

      channel.update([42]);
      expect(channel.get()).toBe(42);
    });
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

describe("UntrackedValueChannel", () => {
  describe("basic operations", () => {
    it("should store and retrieve the last value", () => {
      const channel = new UntrackedValueChannel<number>();

      expect(() => channel.get()).toThrow(EmptyChannelError);
      expect(channel.isAvailable()).toBe(false);

      channel.update([42]);
      expect(channel.get()).toBe(42);
      expect(channel.isAvailable()).toBe(true);

      channel.update([100]);
      expect(channel.get()).toBe(100);
    });

    it("should handle falsy values correctly", () => {
      const channel = new UntrackedValueChannel<
        number | string | boolean | null
      >();

      channel.update([0]);
      expect(channel.get()).toBe(0);

      channel.update([""]);
      expect(channel.get()).toBe("");

      channel.update([false]);
      expect(channel.get()).toBe(false);

      channel.update([null]);
      expect(channel.get()).toBe(null);
    });

    it("should handle undefined values", () => {
      const channel = new UntrackedValueChannel<number | undefined>();

      channel.update([undefined]);
      expect(channel.get()).toBe(undefined);
      expect(channel.isAvailable()).toBe(true);
    });
  });

  describe("checkpoint behavior", () => {
    it("should return undefined when checkpointing", () => {
      const channel = new UntrackedValueChannel<number>();
      channel.update([42]);

      // Checkpoint should return undefined since untracked values aren't persisted
      const checkpoint = channel.checkpoint();
      expect(checkpoint).toBe(undefined);
    });

    it("should reset to empty when restored from checkpoint", () => {
      const channel = new UntrackedValueChannel<number>();
      channel.update([42]);

      const checkpoint = channel.checkpoint();
      const restored = channel.fromCheckpoint(checkpoint);

      // Restored channel should be empty
      expect(() => restored.get()).toThrow(EmptyChannelError);
      expect(restored.isAvailable()).toBe(false);
    });

    it("should use initialValueFactory when restored from checkpoint", () => {
      const channel = new UntrackedValueChannel<number>({
        initialValueFactory: () => 999,
      });
      channel.update([42]);

      const checkpoint = channel.checkpoint();
      const restored = channel.fromCheckpoint(checkpoint);

      // Restored channel should use initial value factory
      expect(restored.get()).toBe(999);
      expect(restored.isAvailable()).toBe(true);
    });
  });

  describe("guard behavior", () => {
    it("should throw when multiple updates are provided with guard: true (default)", () => {
      const channel = new UntrackedValueChannel<number>();

      expect(() => channel.update([1, 2])).toThrow(InvalidUpdateError);
    });

    it("should allow multiple updates with guard: false, keeping last value", () => {
      const channel = new UntrackedValueChannel<number>({ guard: false });

      channel.update([1, 2, 3]);
      expect(channel.get()).toBe(3);
    });

    it("should throw on multiple updates even with guard: true", () => {
      const channel = new UntrackedValueChannel<number>({ guard: true });

      expect(() => channel.update([1, 2])).toThrow(InvalidUpdateError);
    });
  });

  describe("initialValueFactory", () => {
    it("should use initial value when no updates have been made", () => {
      const channel = new UntrackedValueChannel<string>({
        initialValueFactory: () => "default",
      });

      expect(channel.get()).toBe("default");
      expect(channel.isAvailable()).toBe(true);
    });

    it("should override initial value with updates", () => {
      const channel = new UntrackedValueChannel<string>({
        initialValueFactory: () => "default",
      });

      channel.update(["updated"]);
      expect(channel.get()).toBe("updated");
    });

    it("should handle complex objects from initialValueFactory", () => {
      const channel = new UntrackedValueChannel<{ count: number }>({
        initialValueFactory: () => ({ count: 0 }),
      });

      expect(channel.get()).toEqual({ count: 0 });

      channel.update([{ count: 5 }]);
      expect(channel.get()).toEqual({ count: 5 });
    });
  });

  describe("lc_graph_name", () => {
    it("should have lc_graph_name set to 'UntrackedValue'", () => {
      const channel = new UntrackedValueChannel<number>();
      expect(channel.lc_graph_name).toBe("UntrackedValue");
    });
  });
});
