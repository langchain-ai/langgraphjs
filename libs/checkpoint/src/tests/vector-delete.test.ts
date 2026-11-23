import { describe, expect, it } from "vitest";
import { Embeddings } from "@langchain/core/embeddings";
import { InMemoryStore } from "../store/memory.js";

class TestEmbeddings extends Embeddings {
  async embedQuery(text: string): Promise<number[]> {
    return text === "apple" ? [1, 0] : [0, 1];
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embedQuery(text)));
  }
}

function createStore(fields = ["text"]): InMemoryStore {
  return new InMemoryStore({
    index: { dims: 2, embeddings: new TestEmbeddings({}), fields },
  });
}

describe("InMemoryStore vector deletion", () => {
  it.each([
    { name: "index: false", value: { text: "banana" }, index: false as const },
    {
      name: "a missing indexed field",
      value: { other: "banana" },
      index: undefined,
    },
  ])("should not reuse deleted vectors with $name", async ({ value, index }) => {
    const store = createStore();
    await store.put(["docs"], "doc", { text: "apple" });
    expect(await store.search(["docs"], { query: "apple" })).toMatchObject([
      { key: "doc", score: 1 },
    ]);

    await store.delete(["docs"], "doc");
    expect(await store.get(["docs"], "doc")).toBeNull();

    await store.put(["docs"], "doc", value, index);
    expect((await store.get(["docs"], "doc"))?.value).toEqual(value);
    const results = await store.search(["docs"], { query: "apple" });
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeUndefined();
  });

  it("should remove every vector before reindexing a deleted item", async () => {
    const store = createStore(["texts[*]"]);
    await store.put(["docs"], "doc", { texts: ["banana", "apple"] });

    await store.delete(["docs"], "doc");
    await store.put(["docs"], "doc", { texts: ["banana"] });

    const oldQuery = await store.search(["docs"], { query: "apple" });
    expect(oldQuery).toHaveLength(1);
    expect(oldQuery[0]).toMatchObject({
      value: { texts: ["banana"] },
      score: 0,
    });
    expect(await store.search(["docs"], { query: "banana" })).toMatchObject([
      { key: "doc", score: 1 },
    ]);
  });

  it("should clean batch deletions without removing other items' vectors", async () => {
    const store = createStore();
    await store.batch([
      { namespace: ["docs"], key: "first", value: { text: "apple" } },
      { namespace: ["docs"], key: "second", value: { text: "apple" } },
      { namespace: ["docs"], key: "kept", value: { text: "apple" } },
      { namespace: ["other"], key: "first", value: { text: "apple" } },
    ]);

    await store.batch([
      { namespace: ["docs"], key: "first", value: null },
      { namespace: ["docs"], key: "second", value: null },
      { namespace: ["docs"], key: "new", value: { text: "banana" } },
    ]);
    expect(await store.get(["docs"], "first")).toBeNull();
    expect(await store.get(["docs"], "second")).toBeNull();

    await store.batch([
      {
        namespace: ["docs"],
        key: "first",
        value: { text: "banana" },
        index: false,
      },
      {
        namespace: ["docs"],
        key: "second",
        value: { text: "banana" },
        index: false,
      },
    ]);

    const results = await store.search(["docs"], { query: "apple" });
    expect(
      Object.fromEntries(results.map(({ key, score }) => [key, score]))
    ).toEqual({
      kept: 1,
      new: 0,
      first: undefined,
      second: undefined,
    });
    expect(await store.search(["other"], { query: "apple" })).toMatchObject([
      { key: "first", score: 1 },
    ]);
  });

  it.each([true, false])(
    "should delete items without vectors idempotently (index configured: %s)",
    async (indexed) => {
      const store = indexed ? createStore() : new InMemoryStore();
      await store.put(["docs"], "kept", { text: "apple" });
      await store.put(["docs"], "unindexed", { text: "banana" }, false);

      await store.delete(["docs"], "unindexed");
      await store.delete(["docs"], "unindexed");
      await store.delete(["docs"], "missing");
      await store.delete(["missing"], "missing");

      expect(await store.get(["docs"], "unindexed")).toBeNull();
      expect(await store.get(["docs"], "missing")).toBeNull();
      expect(await store.get(["missing"], "missing")).toBeNull();
      expect(await store.search(["docs"], { query: "apple" })).toMatchObject([
        { key: "kept", score: indexed ? 1 : undefined },
      ]);
    }
  );
});
