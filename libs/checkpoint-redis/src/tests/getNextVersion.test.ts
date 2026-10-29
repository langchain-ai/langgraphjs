import { describe, expect, it } from "vitest";
import { RedisSaver } from "../index.js";

describe("RedisSaver.getNextVersion", () => {
  const saver = new RedisSaver({} as never);

  it.each([
    ["a new channel", undefined],
    ["an integer version written by 1.0.x", 41],
    ["a float version written by 1.1.0", 41.370642283883214],
  ])("mints safe integers that keep increasing after %s", (_, start) => {
    let current = start;
    for (let i = 0; i < 100; i++) {
      const next = saver.getNextVersion(current);
      expect(next).toSatisfy(Number.isSafeInteger);
      expect(next).toBeGreaterThan(current ?? 0);
      current = next;
    }
  });

  it("mints different versions for two branches from one checkpoint", () => {
    expect(saver.getNextVersion(1)).not.toBe(saver.getNextVersion(1));
  });
});
