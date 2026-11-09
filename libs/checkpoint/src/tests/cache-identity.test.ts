import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheFullKey } from "../cache/base.js";
import { InMemoryCache } from "../cache/memory.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("InMemoryCache identity", () => {
  describe.each([
    { name: "commas", first: ["tenant,region"], second: ["tenant", "region"] },
    { name: "comma placement", first: ["a,b", "c"], second: ["a", "b,c"] },
    { name: "an empty namespace", first: [], second: [""] },
    { name: "empty segments", first: ["a,", ""], second: ["a", "", ""] },
    {
      name: "quotes and backslashes",
      first: ['a,"b"', "c\\d"],
      second: ["a", '"b",c\\d'],
    },
    { name: "Unicode", first: ["用户,文档"], second: ["用户", "文档"] },
  ])("namespaces containing $name", ({ first, second }) => {
    let cache: InMemoryCache<string>;
    const firstKey: CacheFullKey = [first, "shared"];
    const secondKey: CacheFullKey = [second, "shared"];
    const pairs = [
      { key: firstKey, value: "first" },
      { key: secondKey, value: "second" },
    ];

    beforeEach(async () => {
      cache = new InMemoryCache<string>();
      await cache.set(pairs);
    });

    it("should keep separately stored values distinct", async () => {
      expect(await cache.get([firstKey, secondKey])).toEqual(pairs);

      await cache.set([{ key: firstKey, value: "updated" }]);
      expect(await cache.get([firstKey, secondKey])).toEqual([
        { key: firstKey, value: "updated" },
        { key: secondKey, value: "second" },
      ]);
    });

    it("should clear only the requested namespace", async () => {
      await cache.clear([first]);
      expect(await cache.get([firstKey, secondKey])).toEqual([pairs[1]]);

      await cache.set([pairs[0]]);
      await cache.clear([second]);
      expect(await cache.get([firstKey, secondKey])).toEqual([pairs[0]]);
    });

    it("should expire entries independently at their TTL boundary", async () => {
      vi.useFakeTimers();
      await cache.set([
        { ...pairs[0], ttl: 1 },
        { ...pairs[1], ttl: 10 },
      ]);

      vi.advanceTimersByTime(999);
      expect(await cache.get([firstKey, secondKey])).toEqual(pairs);

      vi.advanceTimersByTime(1);
      expect(await cache.get([firstKey, secondKey])).toEqual([pairs[1]]);

      vi.advanceTimersByTime(9000);
      expect(await cache.get([firstKey, secondKey])).toEqual([]);
    });
  });

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "should treat %s as an ordinary cache key",
    async (key) => {
      const cache = new InMemoryCache<string>();
      const fullKey: CacheFullKey = [["docs"], key];
      const neighbor: CacheFullKey = [["docs"], "neighbor"];
      await cache.set([{ key: neighbor, value: "kept" }]);
      expect(await cache.get([fullKey])).toEqual([]);

      await cache.set([{ key: fullKey, value: "stored" }]);
      expect(await cache.get([fullKey, neighbor])).toEqual([
        { key: fullKey, value: "stored" },
        { key: neighbor, value: "kept" },
      ]);

      await cache.clear([["docs"]]);
      expect(await cache.get([fullKey, neighbor])).toEqual([]);
    }
  );

  it("should not expire another namespace when TTL is zero", async () => {
    const cache = new InMemoryCache<string>();
    const permanent: CacheFullKey = [["a,b"], "key"];
    const expired: CacheFullKey = [["a", "b"], "key"];
    await cache.set([
      { key: permanent, value: "kept" },
      { key: expired, value: "expired", ttl: 0 },
    ]);

    expect(await cache.get([expired, permanent])).toEqual([
      { key: permanent, value: "kept" },
    ]);
  });

  it("should distinguish keys within the same namespace", async () => {
    const cache = new InMemoryCache<string>();
    const keys: CacheFullKey[] = [
      [["docs"], ""],
      [["docs"], "a,b"],
      [["docs"], '["a","b"]'],
    ];
    const pairs = keys.map((key, index) => ({ key, value: String(index) }));
    await cache.set(pairs);
    await cache.set([{ key: keys[1], value: "expired", ttl: 0 }]);

    expect(await cache.get(keys)).toEqual([pairs[0], pairs[2]]);
  });

  it("should clear all namespaces and allow them to be reused", async () => {
    const cache = new InMemoryCache<string>();
    const pairs: { key: CacheFullKey; value: string }[] = [
      { key: [["a,b"], "key"], value: "first" },
      { key: [["a", "b"], "key"], value: "second" },
      { key: [[], "key"], value: "root" },
    ];
    const keys = pairs.map(({ key }) => key);
    await cache.set(pairs);
    await cache.clear([]);
    expect(await cache.get(keys)).toEqual([]);

    await cache.set(pairs);
    expect(await cache.get(keys)).toEqual(pairs);
  });

  it("should preserve custom serialization and requested result order", async () => {
    const serde = {
      dumpsTyped: vi.fn(async (value: number): Promise<[string, Uint8Array]> => [
        "number",
        new Uint8Array([value]),
      ]),
      loadsTyped: vi.fn(async (encoding: string, value: Uint8Array | string) => {
        expect(encoding).toBe("number");
        return typeof value === "string" ? Number(value) : value[0];
      }),
    };
    const cache = new InMemoryCache<number>(serde);
    const first: CacheFullKey = [["a,b"], "key"];
    const second: CacheFullKey = [["a", "b"], "key"];
    await cache.set([
      { key: first, value: 3 },
      { key: second, value: 7 },
    ]);

    expect(
      await cache.get([second, [["missing"], "key"], first, second])
    ).toEqual([
      { key: second, value: 7 },
      { key: first, value: 3 },
      { key: second, value: 7 },
    ]);
    expect(serde.dumpsTyped).toHaveBeenCalledTimes(2);
    expect(serde.loadsTyped).toHaveBeenCalledTimes(3);
    expect(await cache.get([])).toEqual([]);
  });
});
