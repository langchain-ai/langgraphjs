import { describe, expect, it } from "vitest";
import { Embeddings } from "@langchain/core/embeddings";
import { InMemoryStore } from "../store/memory.js";

class TestEmbeddings extends Embeddings {
  constructor() {
    super({});
  }

  async embedQuery(): Promise<number[]> {
    return [1, 0];
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => (text === "match" ? [1, 0] : [0, 1]));
  }
}

function createStore(fields = ["text"]): InMemoryStore {
  return new InMemoryStore({
    index: { dims: 2, embeddings: new TestEmbeddings(), fields },
  });
}

async function createMixedStore(): Promise<InMemoryStore> {
  const store = createStore();
  for (const [key, text, index] of [
    ["unindexed-1", "match", false],
    ["indexed-1", "match", undefined],
    ["unindexed-2", "match", false],
    ["indexed-2", "other", undefined],
    ["unindexed-3", "match", false],
    ["unindexed-4", "match", false],
  ] as const) {
    await store.put(["docs"], key, { text }, index);
  }
  return store;
}

describe("InMemoryStore vector search pagination", () => {
  it.each<[number, string[]]>([
    [0, ["indexed-1", "indexed-2"]],
    [1, ["indexed-2", "unindexed-1"]],
    [2, ["unindexed-1", "unindexed-2"]],
    [3, ["unindexed-2", "unindexed-3"]],
    [4, ["unindexed-3", "unindexed-4"]],
    [5, ["unindexed-4"]],
    [6, []],
    [8, []],
  ])("paginates mixed results at offset %i", async (offset, expectedKeys) => {
    const store = await createMixedStore();

    const results = await store.search(["docs"], {
      query: "match",
      offset,
      limit: 2,
    });

    expect(results.map((item) => item.key)).toEqual(expectedKeys);
    for (const item of results) {
      if (item.key.startsWith("unindexed")) {
        expect(item.score).toBeUndefined();
      } else {
        expect(item.score).toBe(item.key === "indexed-1" ? 1 : 0);
      }
    }
  });

  it("applies the offset when all matching items are unindexed", async () => {
    const store = createStore();
    for (const key of ["first", "second", "third"]) {
      await store.put(["docs"], key, { text: "match" }, false);
    }

    const results = await store.search(["docs"], {
      query: "match",
      offset: 1,
      limit: 1,
    });

    expect(results.map((item) => item.key)).toEqual(["second"]);
    expect(results[0].score).toBeUndefined();
    expect(
      await store.search(["docs"], { query: "match", offset: 3, limit: 1 })
    ).toEqual([]);
  });

  it.each([0, 1, 3, 8])(
    "returns no items for limit zero at offset %i",
    async (offset) => {
      const store = await createMixedStore();

      expect(
        await store.search(["docs"], { query: "match", offset, limit: 0 })
      ).toEqual([]);
    }
  );

  it("applies filters before counting indexed and unindexed items", async () => {
    const store = createStore();
    await store.put(["docs"], "excluded", { text: "match", visible: false });
    await store.put(["docs"], "indexed", { text: "match", visible: true });
    for (const key of ["unindexed-1", "unindexed-2"]) {
      await store.put(["docs"], key, { text: "match", visible: true }, false);
    }

    const results = await store.search(["docs"], {
      query: "match",
      filter: { visible: true },
      offset: 2,
      limit: 1,
    });

    expect(results.map((item) => item.key)).toEqual(["unindexed-2"]);
    expect(results[0].score).toBeUndefined();
  });

  it("counts a document with multiple vectors only once when skipping results", async () => {
    const store = createStore(["texts[*]"]);
    await store.put(["docs"], "indexed", {
      texts: ["match", "other", "match"],
    });
    for (const key of ["unindexed-1", "unindexed-2", "unindexed-3"]) {
      await store.put(["docs"], key, { texts: ["match"] }, false);
    }

    const results = await store.search(["docs"], {
      query: "match",
      offset: 2,
      limit: 2,
    });

    expect(results.map((item) => item.key)).toEqual([
      "unindexed-2",
      "unindexed-3",
    ]);
    expect(results.every((item) => item.score === undefined)).toBe(true);
  });

  it("preserves pagination and relevance ordering for indexed items", async () => {
    const store = createStore();
    await store.put(["docs"], "lower-score", { text: "other" });
    await store.put(["docs"], "higher-score", { text: "match" });

    const results = await store.search(["docs"], {
      query: "match",
      offset: 1,
      limit: 1,
    });

    expect(results.map((item) => item.key)).toEqual(["lower-score"]);
    expect(results[0].score).toBe(0);
  });
});
