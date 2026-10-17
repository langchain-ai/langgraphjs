import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisSaver } from "../index.js";

afterEach(() => vi.restoreAllMocks());

describe("RedisSaver channel versions", () => {
  const saver = new RedisSaver({} as never);

  it.each([undefined, 1, 30.370642283883214])(
    "keeps blob-key versions exact and increasing after %s",
    (initial) => {
      vi.spyOn(Math, "random").mockReturnValue(0.370642283883214);
      let current = initial;
      for (let step = 0; step < 32; step += 1) {
        const version = saver.getNextVersion(current);
        expect(Number.isSafeInteger(version)).toBe(true);
        expect(version).toBeGreaterThan(current ?? 0);
        // Safe integers preserve their decimal key suffix in a JSON document.
        const restored = JSON.parse(JSON.stringify({ version })).version;
        expect(String(restored)).toBe(String(version));
        current = version;
      }
    }
  );

  it("distinguishes sibling branches while advancing past the parent", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.9)
      .mockReturnValue(0);
    const first = saver.getNextVersion(1);
    const second = saver.getNextVersion(1);
    expect(first).not.toBe(second);
    expect(saver.getNextVersion(first)).toBeGreaterThan(second);
  });

  it("rejects exhausted precision and unsupported string versions", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(() => saver.getNextVersion(Number.MAX_SAFE_INTEGER)).toThrow(
      "safe integer range"
    );
    expect(() => saver.getNextVersion("1" as never)).toThrow(
      "Please override this method to use string versions."
    );
  });
});
