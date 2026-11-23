import { describe, expect, it } from "vitest";
import { EmptyChannelError } from "../errors.js";
import { DynamicBarrierValue } from "./dynamic_barrier_value.js";

describe("DynamicBarrierValue checkpoint restoration", () => {
  it.each([false, true])(
    "keeps a priming barrier unavailable (previously consumed: %s)",
    (consumed) => {
      const channel = new DynamicBarrierValue<string>();
      if (consumed) {
        channel.update([{ __names: ["worker"] }]);
        channel.update(["worker"]);
        expect(channel.consume()).toBe(true);
      }

      const restored = channel.fromCheckpoint(channel.checkpoint());
      expect(restored.isAvailable()).toBe(false);
      expect(() => restored.get()).toThrow(EmptyChannelError);
      expect(restored.consume()).toBe(false);

      restored.update([{ __names: ["a", "b"] }]);
      restored.update(["a"]);
      expect(restored.isAvailable()).toBe(false);
      restored.update(["b"]);
      expect(restored.isAvailable()).toBe(true);
    }
  );

  it("preserves a primed barrier waiting for no names", () => {
    const channel = new DynamicBarrierValue<string>();
    channel.update([{ __names: [] }]);
    const restored = channel.fromCheckpoint(channel.checkpoint());
    expect(restored.isAvailable()).toBe(true);
    expect(restored.get()).toBeUndefined();
    expect(restored.consume()).toBe(true);
    expect(restored.isAvailable()).toBe(false);
  });

  it("preserves partial progress while waiting for names", () => {
    const channel = new DynamicBarrierValue<string>();
    channel.update([{ __names: ["a", "b"] }]);
    channel.update(["a"]);
    const restored = channel.fromCheckpoint(channel.checkpoint());
    expect(restored.isAvailable()).toBe(false);
    restored.update(["b"]);
    expect(restored.isAvailable()).toBe(true);
    expect(restored.consume()).toBe(true);
  });
});
