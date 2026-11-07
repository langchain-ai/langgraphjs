import { describe, expect, it } from "vitest";
import { Embeddings } from "@langchain/core/embeddings";
import { InMemoryStore } from "../store/memory.js";

class ConstantEmbeddings extends Embeddings {
  constructor() {
    super({});
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0]);
  }

  async embedQuery(): Promise<number[]> {
    return [1, 0];
  }
}

describe("InMemoryStore composite item identities", () => {
  it("preserves distinct batch puts while keeping the last write to the same item", async () => {
    const store = new InMemoryStore();

    await store.batch([
      { namespace: ["a"], key: "b:c", value: { text: "first" } },
      { namespace: ["a", "b"], key: "c", value: { text: "nested" } },
      { namespace: ["a"], key: "b:c", value: { text: "latest" } },
    ]);

    expect((await store.get(["a"], "b:c"))?.value).toEqual({ text: "latest" });
    expect((await store.get(["a", "b"], "c"))?.value).toEqual({ text: "nested" });
  });

  it("does not discard a delete when another item's namespace and key join to the same string", async () => {
    const store = new InMemoryStore();
    await store.put(["a"], "b:c", { text: "remove" });
    await store.put(["a", "b"], "c", { text: "before" });

    await store.batch([
      { namespace: ["a"], key: "b:c", value: null },
      { namespace: ["a", "b"], key: "c", value: { text: "after" } },
    ]);

    expect(await store.get(["a"], "b:c")).toBeNull();
    expect((await store.get(["a", "b"], "c"))?.value).toEqual({ text: "after" });
  });

  it.each([undefined, false] as const)(
    "keeps both vector search results when the second item's index option is %s",
    async (index) => {
      const store = new InMemoryStore({
        index: {
          dims: 2,
          embeddings: new ConstantEmbeddings(),
          fields: ["text"],
        },
      });
      await store.put(["a"], "b:c", { text: "first" });
      await store.put(["a", "b"], "c", { text: "second" }, index);

      const result = await store.search(["a"], { query: "query" });

      expect(result.map(({ namespace, key }) => [namespace, key])).toEqual([
        [["a"], "b:c"],
        [["a", "b"], "c"],
      ]);
      expect(result[0].score).toBe(1);
      expect(result[1].score).toBe(index === false ? undefined : 1);
    }
  );
});
