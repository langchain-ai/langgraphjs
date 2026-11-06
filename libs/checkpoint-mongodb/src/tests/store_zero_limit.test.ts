import { describe, expect, it, vi } from "vitest";
import { MongoDBStore } from "../store.js";
import type { MongoClient } from "mongodb";

describe("MongoDBStore zero-limit vector search", () => {
  it("does not embed the query or send an invalid vector limit to MongoDB", async () => {
    const collection = { aggregate: vi.fn() };
    const client = {
      appendMetadata: vi.fn(),
      db: () => ({ collection: () => collection }),
    } as unknown as MongoClient;
    const embeddings = { embedQuery: vi.fn(), embedDocuments: vi.fn() };
    const store = new MongoDBStore({
      client,
      indexConfig: { name: "vectors", dims: 2 },
      embeddings,
    });
    await expect(
      store.search(["docs"], { query: "question", limit: 0 })
    ).resolves.toEqual([]);
    expect(embeddings.embedQuery).not.toHaveBeenCalled();
    expect(collection.aggregate).not.toHaveBeenCalled();
  });
});
