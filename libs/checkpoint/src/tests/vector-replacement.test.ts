import { describe, expect, it, vi } from "vitest";
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

function createStore(fields = ["text"]) {
  const embeddings = new TestEmbeddings({});
  const store = new InMemoryStore({
    index: { dims: 2, embeddings, fields },
  });
  return { store, embeddings };
}

describe("InMemoryStore vector replacement", () => {
  it.each<{
    name: string;
    value: Record<string, string>;
    index?: false | string[];
    score?: number;
  }>([
    { name: "disabled indexing", value: { text: "banana" }, index: false },
    { name: "an empty index list", value: { text: "banana" }, index: [] },
    { name: "a missing indexed field", value: { other: "banana" } },
    {
      name: "a different indexed field",
      value: { text: "apple", other: "banana" },
      index: ["other"],
      score: 0,
    },
  ])("replaces previous vectors with $name", async ({ value, index, score }) => {
    const { store } = createStore();
    await store.put(["docs"], "doc", { text: "apple" });

    await store.put(["docs"], "doc", value, index);

    expect((await store.get(["docs"], "doc"))?.value).toEqual(value);
    const results = await store.search(["docs"], { query: "apple" });
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(score);
  });

  it.each([
    { before: ["banana", "apple"], after: ["banana"], score: 0 },
    {
      before: ["banana", "banana", "apple"],
      after: ["banana", "banana"],
      score: 0,
    },
    { before: ["apple"], after: ["banana", "banana"], score: 0 },
    { before: ["banana", "apple"], after: [], score: undefined },
  ])("replaces array vectors from $before to $after", async ({ before, after, score }) => {
    const { store } = createStore(["texts[*]"]);
    await store.put(["docs"], "doc", { texts: before });

    await store.put(["docs"], "doc", { texts: after });

    expect((await store.get(["docs"], "doc"))?.value).toEqual({ texts: after });
    const results = await store.search(["docs"], { query: "apple" });
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(score);
  });

  it("replaces vectors for an unchanged field path", async () => {
    const { store } = createStore();
    await store.put(["docs"], "doc", { text: "apple" });

    await store.put(["docs"], "doc", { text: "banana" });

    expect(await store.search(["docs"], { query: "apple" })).toMatchObject([
      { value: { text: "banana" }, score: 0 },
    ]);
    expect(await store.search(["docs"], { query: "banana" })).toMatchObject([
      { key: "doc", score: 1 },
    ]);
  });

  it("preserves text deduplication and item mapping across a batch", async () => {
    const { store, embeddings } = createStore(["texts[*]"]);
    for (const key of ["first", "second", "kept", "unindexed"]) {
      await store.put(["docs"], key, { texts: ["apple"] });
    }
    await store.put(["other"], "first", { texts: ["apple"] });
    const embed = vi.spyOn(embeddings, "embedDocuments");

    await store.batch([
      {
        namespace: ["docs"],
        key: "first",
        value: { texts: ["banana", "banana"] },
      },
      { namespace: ["docs"], key: "second", value: { texts: ["banana"] } },
      { namespace: ["new"], key: "first", value: { texts: ["apple"] } },
      {
        namespace: ["docs"],
        key: "unindexed",
        value: { texts: ["apple"] },
        index: false,
      },
    ]);

    expect(embed).toHaveBeenCalledExactlyOnceWith(["banana", "apple"]);
    expect(
      Object.fromEntries(
        (await store.search(["docs"], { query: "apple" })).map((item) => [
          item.key,
          item.score,
        ])
      )
    ).toEqual({ first: 0, second: 0, kept: 1, unindexed: undefined });
    for (const namespace of [["other"], ["new"]]) {
      expect(await store.search(namespace, { query: "apple" })).toMatchObject([
        { key: "first", score: 1 },
      ]);
    }
  });

  it("uses only the final put for an item in a batch", async () => {
    const { store, embeddings } = createStore();
    await store.put(["docs"], "doc", { text: "apple" });
    const embed = vi.spyOn(embeddings, "embedDocuments");

    await store.batch([
      { namespace: ["docs"], key: "doc", value: { text: "banana" } },
      {
        namespace: ["docs"],
        key: "doc",
        value: { text: "final" },
        index: false,
      },
    ]);

    expect(embed).not.toHaveBeenCalled();
    expect((await store.get(["docs"], "doc"))?.value).toEqual({ text: "final" });
    const results = await store.search(["docs"], { query: "apple" });
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeUndefined();
  });

  it.each(["provider rejection", "missing embedding"])(
    "preserves all original values and vectors after %s",
    async (failure) => {
      const { store, embeddings } = createStore();
      for (const key of ["first", "second", "unindexed"]) {
        await store.put(["docs"], key, { text: "apple" });
      }
      const embed = vi.spyOn(embeddings, "embedDocuments");
      if (failure === "provider rejection") {
        embed.mockRejectedValueOnce(new Error("Embedding provider failed"));
      } else {
        embed.mockResolvedValueOnce([[0, 1]]);
      }

      await expect(
        store.batch([
          {
            namespace: ["docs"],
            key: "unindexed",
            value: { text: "banana" },
            index: false,
          },
          { namespace: ["docs"], key: "first", value: { text: "banana" } },
          { namespace: ["docs"], key: "second", value: { text: "cherry" } },
          { namespace: ["docs"], key: "new", value: { text: "banana" } },
        ])
      ).rejects.toThrow(
        failure === "provider rejection"
          ? "Embedding provider failed"
          : "No embedding found for text: cherry"
      );

      for (const key of ["first", "second", "unindexed"]) {
        expect((await store.get(["docs"], key))?.value).toEqual({ text: "apple" });
      }
      expect(await store.get(["docs"], "new")).toBeNull();
      const results = await store.search(["docs"], { query: "apple" });
      expect(results).toHaveLength(3);
      expect(results.every((item) => item.score === 1)).toBe(true);
    }
  );
});
