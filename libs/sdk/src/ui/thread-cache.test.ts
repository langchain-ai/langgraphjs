import { describe, expect, it } from "vitest";
import { ThreadCache } from "./thread-cache.js";

const read = (chars: number) => [{ values: { text: "x".repeat(chars) } }] as never;

describe("ThreadCache", () => {
  it("holds threads up to maxBytes, dropping the one opened least recently", () => {
    const cache = new ThreadCache({ maxBytes: 250 });
    cache.set("a", read(100));
    cache.set("b", read(100));
    cache.get("a");
    cache.set("c", read(100));

    expect(["a", "b", "c"].filter((id) => cache.get(id) != null)).toEqual([
      "a",
      "c",
    ]);
    expect(cache.bytes).toBe(200);
  });

  it("counts an object the read reaches twice once, also through a cycle", () => {
    const shared = { text: "x".repeat(10) };
    const cyclic: Record<string, unknown> = { text: "y".repeat(5) };
    cyclic.self = cyclic;
    const cache = new ThreadCache();
    cache.set("a", [{ values: { one: shared, two: shared, cyclic } }] as never);

    expect(cache.bytes).toBe(15);
  });

  it("keeps no read bigger than maxBytes, and no empty one", () => {
    const cache = new ThreadCache({ maxBytes: 50 });
    cache.set("a", read(10));
    cache.set("a", read(100));
    cache.set("b", read(10));
    cache.set("b", []);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });
});
