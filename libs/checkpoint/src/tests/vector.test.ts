import { beforeEach, describe, expect, it } from "vitest";
import { Embeddings, EmbeddingsParams } from "@langchain/core/embeddings";
import { InMemoryStore } from "../store/memory.js";

class CharacterEmbeddings extends Embeddings {
  dims: number;

  constructor(params: EmbeddingsParams & { dims?: number } = {}) {
    super(params);
    this.dims = params.dims ?? 500;
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.generateEmbedding(query);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.generateEmbedding(text));
  }

  private generateEmbedding(text: string): number[] {
    const embedding = new Array(this.dims).fill(0);
    for (let i = 0; i < text.length && i < this.dims; i += 1) {
      embedding[text.charCodeAt(i) % this.dims] += 1;
    }
    const magnitude = Math.sqrt(
      embedding.reduce((acc, val) => acc + val * val, 0)
    );
    return embedding.map((val) => val / magnitude);
  }
}

describe("InMemoryStore Vector Search", () => {
  let store: InMemoryStore;
  let embeddings: CharacterEmbeddings;

  beforeEach(() => {
    embeddings = new CharacterEmbeddings({ dims: 500 });
    store = new InMemoryStore({
      index: { dims: embeddings.dims, embeddings },
    });
  });

  it("should initialize with embeddings config", () => {
    const store = new InMemoryStore({
      index: { dims: embeddings.dims, embeddings },
    });
    expect(store.indexConfig).toBeDefined();
    expect(store.indexConfig?.dims).toBe(embeddings.dims);
    expect(store.indexConfig?.embeddings).toBe(embeddings);
  });

  it("should auto-embed and search documents", async () => {
    const docs = [
      ["doc1", { text: "short text" }],
      ["doc2", { text: "longer text document" }],
      ["doc3", { text: "longest text document here" }],
      ["doc4", { description: "text in description field" }],
      ["doc5", { content: "text in content field" }],
      ["doc6", { body: "text in body field" }],
    ] as const;

    for (const [key, value] of docs) {
      await store.put(["test"], key, value);
    }

    const results = await store.search(["test"], { query: "long text" });
    expect(results.length).toBeGreaterThan(0);

    const docOrder = results.map((r) => r.key);
    expect(docOrder).toContain("doc2");
    expect(docOrder).toContain("doc3");
  });

  it("should update embeddings when documents are updated", async () => {
    await store.put(["test"], "doc1", { text: "zany zebra Xerxes" });
    await store.put(["test"], "doc2", { text: "something about dogs" });
    await store.put(["test"], "doc3", { text: "text about birds" });

    const resultsInitial = await store.search(["test"], {
      query: "Zany Xerxes",
    });
    expect(resultsInitial.length).toBeGreaterThan(0);
    const initialScore = resultsInitial[0].score;
    expect(initialScore).toBeDefined();
    expect(resultsInitial[0].key).toBe("doc1");

    await store.put(["test"], "doc1", { text: "new text about dogs" });

    const resultsAfter = await store.search(["test"], { query: "Zany Xerxes" });
    const afterScore = resultsAfter.find((r) => r.key === "doc1")?.score ?? 0;
    expect(afterScore).toBeDefined();
    expect(afterScore).toBeLessThan(initialScore!);

    const resultsNew = await store.search(["test"], {
      query: "new text about dogs",
    });
    const newScore = resultsNew.find((r) => r.key === "doc1")?.score;
    expect(newScore).toBeGreaterThan(afterScore);
  });

  it("should handle non-indexed documents", async () => {
    await store.put(["test"], "doc1", { text: "new text about dogs" });
    await store.put(["test"], "doc2", { text: "new text about dogs" }, false);

    const results = await store.search(["test"], {
      query: "new text about dogs",
      limit: 3,
    });
    expect(results.some((r) => r.key === "doc1")).toBe(true);
    expect(results.some((r) => r.key === "doc2")).toBe(true);
  });

  it("should combine vector search with filters", async () => {
    const docs = [
      ["doc1", { text: "red apple", color: "red", score: 4.5 }],
      ["doc2", { text: "red car", color: "red", score: 3.0 }],
      ["doc3", { text: "green apple", color: "green", score: 4.0 }],
      ["doc4", { text: "blue car", color: "blue", score: 3.5 }],
    ] as const;

    for (const [key, value] of docs) {
      await store.put(["test"], key, value);
    }

    let results = await store.search(["test"], {
      query: "apple",
      filter: { color: "red" },
    });
    expect(results.length).toBe(2);
    expect(results[0].key).toBe("doc1");

    results = await store.search(["test"], {
      query: "car",
      filter: { color: "red" },
    });
    expect(results.length).toBe(2);
    expect(results[0].key).toBe("doc2");

    results = await store.search(["test"], {
      query: "bbbbluuu",
      filter: { score: { $gt: 3.2 } },
    });
    expect(results.length).toBe(3);
    expect(results[0].key).toBe("doc4");

    results = await store.search(["test"], {
      query: "apple",
      filter: { score: { $gte: 4.0 }, color: "green" },
    });
    expect(results.length).toBe(1);
    expect(results[0].key).toBe("doc3");
  });

  it("should handle field-specific indexing at store level", async () => {
    const storeWithFields = new InMemoryStore({
      index: {
        dims: embeddings.dims,
        embeddings,
        fields: ["key0", "key1", "key3"],
      },
    });

    // This will have 2 vectors (key1, key3)
    const doc1 = {
      key1: "xxx",
      key2: "yyy", // Not indexed
      key3: "zzz",
    };

    // This will have 3 vectors (key0, key1, key3)
    const doc2 = {
      key0: "uuu",
      key1: "vvv",
      key2: "www", // Not indexed
      key3: "xxx",
    };

    await storeWithFields.put(["test"], "doc1", doc1);
    await storeWithFields.put(["test"], "doc2", doc2);

    // doc2.key3 and doc1.key1 both have "xxx"
    const results1 = await storeWithFields.search(["test"], { query: "xxx" });
    expect(results1.length).toBe(2);
    expect(results1[0].key).not.toBe(results1[1].key);
    expect(results1[0].score).toBe(results1[1].score);
    const baseScore = results1[0].score!;

    // doc2 has "uuu" in key0
    const results2 = await storeWithFields.search(["test"], { query: "uuu" });
    expect(results2.length).toBe(2);
    expect(results2[0].key).toBe("doc2");
    expect(results2[0].score).toBeGreaterThan(results2[1].score!);
    expect(results2[0].score).toBeCloseTo(baseScore, 5);

    // "www" is in unindexed field key2
    const results3 = await storeWithFields.search(["test"], { query: "www" });
    expect(results3.length).toBe(2);
    expect(results3[0].score).toBeLessThan(baseScore);
    expect(results3[1].score).toBeLessThan(baseScore);
  });

  it("should handle field-specific indexing at operation level", async () => {
    const storeNoDefaults = new InMemoryStore({
      index: {
        dims: embeddings.dims,
        embeddings,
        fields: ["key17"], // Default field that doesn't exist in our docs
      },
    });

    const doc3 = {
      key0: "aaa",
      key1: "bbb",
      key2: "ccc",
      key3: "ddd",
    };

    const doc4 = {
      key0: "eee",
      key1: "bbb", // Same as doc3.key1
      key2: "fff",
      key3: "ggg",
    };

    await storeNoDefaults.put(["test"], "doc3", doc3, ["key0", "key1"]);
    await storeNoDefaults.put(["test"], "doc4", doc4, ["key1", "key3"]);

    // "aaa" is in doc3.key0 which is indexed
    const results1 = await storeNoDefaults.search(["test"], { query: "aaa" });
    expect(results1.length).toBe(2);
    expect(results1[0].key).toBe("doc3");
    expect(results1[0].score).toBeGreaterThan(results1[1].score!);

    // "ggg" is in doc4.key3 which is indexed
    const results2 = await storeNoDefaults.search(["test"], { query: "ggg" });
    expect(results2.length).toBe(2);
    expect(results2[0].key).toBe("doc4");
    expect(results2[0].score).toBeGreaterThan(results2[1].score!);

    // "bbb" is in both docs in indexed fields
    const results3 = await storeNoDefaults.search(["test"], { query: "bbb" });
    expect(results3.length).toBe(2);
    expect(results3[0].key).not.toBe(results3[1].key);
    expect(results3[0].score).toBe(results3[1].score);

    // "ccc" is in unindexed fields
    const results4 = await storeNoDefaults.search(["test"], { query: "ccc" });
    expect(results4.length).toBe(2);
    expect(results4.every((r) => r.score! < results1[0].score!)).toBe(true);

    // Test unindexed document
    const doc5 = {
      key0: "hhh",
      key1: "iii",
    };
    await storeNoDefaults.put(["test"], "doc5", doc5, false);

    const results5 = await storeNoDefaults.search(["test"], { query: "hhh" });
    expect(results5.length).toBe(3);
    const doc5Result = results5.find((r) => r.key === "doc5");
    expect(doc5Result).toBeDefined();
    expect(doc5Result!.score).toBeUndefined();
  });
});
