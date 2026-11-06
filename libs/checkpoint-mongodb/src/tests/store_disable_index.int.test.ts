import { MongoClient } from "mongodb";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { MongoDBStore } from "../store.js";

describe("MongoDBStore disabling item indexing", () => {
  const client = new MongoClient(
    getEnvironmentVariable("MONGODB_URL") || "mongodb://localhost:27017",
    { auth: { username: "user", password: "password" } }
  );
  const collectionName = "disabled_index_store";
  const collection = client.db("langgraph_test").collection(collectionName);
  const store = new MongoDBStore({
    client,
    dbName: "langgraph_test",
    collectionName,
  });

  beforeAll(async () => {
    await client.connect();
    await collection.deleteMany({});
    await store.start();
  });

  afterAll(async () => {
    await collection.deleteMany({});
    await client.close();
  });

  it.each([undefined, "customEmbedding"])(
    "removes an existing vector at path %s",
    async (path) => {
      const indexed = new MongoDBStore({
        client,
        dbName: "langgraph_test",
        collectionName,
        indexConfig: { name: "test_vector", dims: 2, path },
        embeddings: {
          embedDocuments: async (texts) => texts.map(() => [1, 0]),
          embedQuery: async () => [1, 0],
        },
      });
      const key = path ?? "default";
      const embeddingField = path ?? "embedding";
      await indexed.put(["indexing"], key, { text: "old" });
      const original = await collection.findOne({ key });
      expect(original?.[embeddingField]).toEqual([1, 0]);

      await indexed.put(["indexing"], key, { text: "new" }, false);
      const updated = await collection.findOne({ key });
      expect(updated?.value).toEqual({ text: "new" });
      expect(updated).not.toHaveProperty(embeddingField);
      expect(updated?.createdAt).toEqual(original?.createdAt);

      await indexed.put(["indexing"], key, { text: "indexed again" });
      expect((await collection.findOne({ key }))?.[embeddingField]).toEqual([
        1, 0,
      ]);
    }
  );
});
