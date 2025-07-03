import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryCache } from "../cache/memory.js";

describe("InMemoryCache", () => {
  let cache: InMemoryCache<string>;

  beforeEach(() => {
    cache = new InMemoryCache<string>();
  });

  describe("get and set", () => {
    it("should set and get a single value", async () => {
      const key: [string[], string] = [["test"], "key1"];
      await cache.set([{ key, value: "value1", ttl: 1000 }]);
      expect(await cache.get([key])).toEqual([{ key, value: "value1" }]);
    });

    it("should handle multiple values", async () => {
      const pairs = [
        {
          key: [["test"], "key1"] as [string[], string],
          value: "value1",
          ttl: 1000,
        },
        {
          key: [["test"], "key2"] as [string[], string],
          value: "value2",
          ttl: 1000,
        },
      ];

      await cache.set(pairs);
      const result = await cache.get(pairs.map((p) => p.key));

      expect(result).toEqual([
        { key: [["test"], "key1"], value: "value1" },
        { key: [["test"], "key2"], value: "value2" },
      ]);
    });

    it("should return empty array for non-existent keys", async () => {
      const result = await cache.get([[["test"], "nonexistent"]]);
      expect(result).toHaveLength(0);
    });
  });

  describe("TTL behavior", () => {
    it("should expire values after TTL", async () => {
      const key: [string[], string] = [["test"], "key1"];
      await cache.set([{ key, value: "value1", ttl: 0.1 }]); // 100ms TTL

      // Wait for TTL to expire
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });

      expect(await cache.get([key])).toEqual([]);
    });

    it("should not expire values before TTL", async () => {
      const key: [string[], string] = [["test"], "key1"];
      await cache.set([{ key, value: "value1", ttl: 0.2 }]); // 200ms TTL

      // Check before TTL expires
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });

      const result = await cache.get([key]);
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe("value1");
    });
  });

  describe("namespace handling", () => {
    it("should handle different namespaces separately", async () => {
      const pairs = [
        {
          key: [["ns1"], "key1"] as [string[], string],
          value: "value1",
          ttl: 1000,
        },
        {
          key: [["ns2"], "key1"] as [string[], string],
          value: "value2",
          ttl: 1000,
        },
      ];

      await cache.set(pairs);
      const result = await cache.get(pairs.map((p) => p.key));

      expect(result).toEqual([
        { key: [["ns1"], "key1"], value: "value1" },
        { key: [["ns2"], "key1"], value: "value2" },
      ]);
    });

    it("should handle nested namespaces", async () => {
      const key: [string[], string] = [["ns1", "subns"], "key1"];
      await cache.set([{ key, value: "value1", ttl: 1.0 }]);

      expect(await cache.get([key])).toEqual([{ key, value: "value1" }]);
    });
  });

  describe("clear operations", () => {
    it("should clear specific namespace", async () => {
      const pairs = [
        {
          key: [["ns1"], "key1"] as [string[], string],
          value: "value1",
          ttl: 1.0,
        },
        {
          key: [["ns2"], "key1"] as [string[], string],
          value: "value2",
          ttl: 1.0,
        },
      ];

      await cache.set(pairs);
      await cache.clear([["ns1"]]);

      expect(await cache.get(pairs.map((p) => p.key))).toEqual([
        { key: [["ns2"], "key1"], value: "value2" },
      ]);
    });

    it("should clear all namespaces when no namespace specified", async () => {
      const pairs = [
        {
          key: [["ns1"], "key1"] as [string[], string],
          value: "value1",
          ttl: 1.0,
        },
        {
          key: [["ns2"], "key1"] as [string[], string],
          value: "value2",
          ttl: 1.0,
        },
      ];

      await cache.set(pairs);
      await cache.clear([]);

      expect(await cache.get(pairs.map((p) => p.key))).toEqual([]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty key arrays", async () => {
      expect(await cache.get([])).toEqual([]);
    });

    it("should handle empty namespace arrays", async () => {
      expect(await cache.clear([])).toBeUndefined();
    });

    it("should handle setting empty pairs", async () => {
      expect(await cache.set([])).toBeUndefined();
    });
  });
});
