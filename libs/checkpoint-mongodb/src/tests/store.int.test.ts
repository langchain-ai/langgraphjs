import { MongoClient } from "mongodb";
import { MongoDBStore } from "../store";
import type { IndexConfig } from "../store";
import {
  type PutOperation,
  type GetOperation,
  type SearchOperation,
} from "@langchain/langgraph-checkpoint";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("MongoDBStore Integration Tests", () => {
  let client: MongoClient;
  let store: MongoDBStore;
  const dbName = "langgraph_test";
  const mongoUrl = getEnvironmentVariable("MONGODB_URL") || "mongodb://localhost:27017";

  beforeAll(async () => {
    client = new MongoClient(mongoUrl, {
      auth: { username: "user", password: "password" },
    });
    await client.connect();

    store = new MongoDBStore({
      client,
      dbName,
      collectionName: "test_store",
    });

    await store.start();
    await client.db(dbName).collection("test_store").deleteMany({});
  });

  afterAll(async () => {
    await client.db(dbName).collection("test_store").deleteMany({});
    await client.close();
  });

  describe("put", () => {
    it("should store and retrieve an item", async () => {
      await store.batch([{
        namespace: ["put_test", "profiles"],
        key: "user123",
        value: { name: "Alice", email: "alice@example.com" },
      } as PutOperation]);

      const results = await store.batch([
        { namespace: ["put_test", "profiles"], key: "user123" } as GetOperation,
      ]);
      const item = results[0];

      expect(item).toBeDefined();
      expect(item?.value).toEqual({ name: "Alice", email: "alice@example.com" });
      expect(item?.namespace).toEqual(["put_test", "profiles"]);
      expect(item?.key).toEqual("user123");
    });

    it("should update an existing item", async () => {
      await store.batch([
        { namespace: ["put_test"], key: "doc1", value: { title: "Original", version: 1 } } as PutOperation,
      ]);
      await store.batch([
        { namespace: ["put_test"], key: "doc1", value: { title: "Updated", version: 2 } } as PutOperation,
      ]);

      const results = await store.batch([
        { namespace: ["put_test"], key: "doc1" } as GetOperation,
      ]);

      expect(results[0]?.value.version).toBe(2);
      expect(results[0]?.value.title).toBe("Updated");
    });

    it("should delete an item when value is null", async () => {
      await store.batch([
        { namespace: ["put_test"], key: "to_delete", value: { data: "will delete" } } as PutOperation,
      ]);
      await store.batch([
        { namespace: ["put_test"], key: "to_delete", value: null } as PutOperation,
      ]);

      const results = await store.batch([
        { namespace: ["put_test"], key: "to_delete" } as GetOperation,
      ]);

      expect(results[0]).toBeNull();
    });
  });

  describe("get", () => {
    it("should return null for non-existent item", async () => {
      const results = await store.batch([
        { namespace: ["nonexistent"], key: "missing" } as GetOperation,
      ]);

      expect(results[0]).toBeNull();
    });
  });

  describe("search", () => {
    beforeAll(async () => {
      const ops: PutOperation[] = [
        { namespace: ["products"], key: "prod1", value: { name: "Budget Item", price: 29.99, category: "electronics" } },
        { namespace: ["products"], key: "prod2", value: { name: "Standard Item", price: 99.99, category: "electronics" } },
        { namespace: ["products"], key: "prod3", value: { name: "Premium Item", price: 299.99, category: "electronics" } },
        { namespace: ["products"], key: "prod4", value: { name: "Book", price: 19.99, category: "books" } },
        { namespace: ["search_users"], key: "user1", value: { username: "alice", status: "active", score: 95 } },
        { namespace: ["search_users"], key: "user2", value: { username: "bob", status: "inactive", score: 42 } },
        { namespace: ["search_users"], key: "user3", value: { username: "charlie", status: "active", score: 87 } },
        { namespace: ["search_users", "profiles"], key: "profile1", value: { bio: "Engineer", city: "SF" } },
        { namespace: ["search_users", "profiles"], key: "profile2", value: { bio: "Designer", city: "NYC" } },
      ];

      await store.batch(ops);
    });

    it("should filter with exact match", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: { category: "electronics" },
        limit: 100,
        offset: 0,
      } as SearchOperation]);
      const items = results[0] as any[];

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item: any) => item.value.category === "electronics")).toBe(true);
    });

    it("should filter with comparison operator $gt", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: { price: { $gt: 100 } },
        limit: 100,
        offset: 0,
      } as SearchOperation]);
      const items = results[0] as any[];

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item: any) => item.value.price > 100)).toBe(true);
    });

    it("should filter with comparison operator $lte", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: { price: { $lte: 50 } },
        limit: 100,
        offset: 0,
      } as SearchOperation]);
      const items = results[0] as any[];

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item: any) => item.value.price <= 50)).toBe(true);
    });

    it("should filter with multiple conditions", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: { category: "electronics", price: { $gte: 50 } },
        limit: 100,
        offset: 0,
      } as SearchOperation]);
      const items = results[0] as any[];

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item: any) =>
        item.value.category === "electronics" && item.value.price >= 50
      )).toBe(true);
    });

    it("should match nested namespaces when searching by prefix", async () => {
      const results = await store.batch([{
        namespacePrefix: ["search_users"],
        filter: {},
        limit: 100,
        offset: 0,
      } as SearchOperation]);
      const items = results[0] as any[];

      expect(items.length).toBeGreaterThan(0);
      const namespaces = items.map((item: any) => JSON.stringify(item.namespace));
      expect(namespaces).toContain(JSON.stringify(["search_users"]));
      expect(namespaces).toContain(JSON.stringify(["search_users", "profiles"]));
    });

    it("should apply limit", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: {},
        limit: 2,
        offset: 0,
      } as SearchOperation]);

      expect((results[0] as any[]).length).toBeLessThanOrEqual(2);
    });

    it("should apply offset", async () => {
      const results1 = await store.batch([{
        namespacePrefix: ["search_users"],
        filter: { status: "active" },
        limit: 100,
        offset: 0,
      } as SearchOperation]);

      const results2 = await store.batch([{
        namespacePrefix: ["search_users"],
        filter: { status: "active" },
        limit: 100,
        offset: 1,
      } as SearchOperation]);

      expect((results2[0] as any[]).length).toBeLessThan((results1[0] as any[]).length);
    });

    it("should return empty array for non-matching filter", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: { category: "nonexistent" },
        limit: 100,
        offset: 0,
      } as SearchOperation]);

      expect(results[0]).toEqual([]);
    });
  });

  describe("listNamespaces", () => {
    beforeAll(async () => {
      const ops: PutOperation[] = [
        { namespace: ["threads"], key: "t1", value: { id: 1 } },
        { namespace: ["threads"], key: "t2", value: { id: 2 } },
        { namespace: ["threads", "messages"], key: "m1", value: { text: "hi" } },
        { namespace: ["threads", "messages"], key: "m2", value: { text: "bye" } },
        { namespace: ["ns_users"], key: "u1", value: { name: "Alice" } },
        { namespace: ["ns_users", "profiles"], key: "p1", value: { bio: "..." } },
      ];

      await store.batch(ops);
    });

    it("should list all unique namespaces", async () => {
      const results = await store.batch([{ limit: 100, offset: 0 }]);
      const namespaces = results[0] as string[][];

      expect(namespaces).toContainEqual(["threads"]);
      expect(namespaces).toContainEqual(["threads", "messages"]);
      expect(namespaces).toContainEqual(["ns_users"]);
      expect(namespaces).toContainEqual(["ns_users", "profiles"]);
    });

    it("should apply limit", async () => {
      const results = await store.batch([{ limit: 2, offset: 0 }]);

      expect((results[0] as string[][]).length).toBeLessThanOrEqual(2);
    });

    it("should apply offset", async () => {
      const results1 = await store.batch([{ limit: 100, offset: 0 }]);
      const results2 = await store.batch([{ limit: 100, offset: 2 }]);

      expect((results2[0] as string[][]).length).toBeLessThan(
        (results1[0] as string[][]).length
      );
    });

    it("should filter by prefix matchCondition", async () => {
      const results = await store.batch([{
        matchConditions: [{ matchType: "prefix" as const, path: ["threads"] }],
        limit: 100,
        offset: 0,
      }]);
      const namespaces = results[0] as string[][];

      expect(namespaces).toContainEqual(["threads"]);
      expect(namespaces).toContainEqual(["threads", "messages"]);
      expect(namespaces).not.toContainEqual(["ns_users"]);
      expect(namespaces).not.toContainEqual(["ns_users", "profiles"]);
    });

    it("should filter by suffix matchCondition", async () => {
      const results = await store.batch([{
        matchConditions: [{ matchType: "suffix" as const, path: ["profiles"] }],
        limit: 100,
        offset: 0,
      }]);
      const namespaces = results[0] as string[][];

      expect(namespaces).toContainEqual(["ns_users", "profiles"]);
      expect(namespaces).not.toContainEqual(["threads"]);
      expect(namespaces).not.toContainEqual(["ns_users"]);
    });

    it("should support wildcard in matchCondition", async () => {
      const results = await store.batch([{
        matchConditions: [{ matchType: "prefix" as const, path: ["*", "messages"] }],
        limit: 100,
        offset: 0,
      }]);
      const namespaces = results[0] as string[][];

      expect(namespaces).toContainEqual(["threads", "messages"]);
      expect(namespaces).not.toContainEqual(["threads"]);
      expect(namespaces).not.toContainEqual(["ns_users"]);
    });
  });

  describe("batch", () => {
    it("should execute mixed operations in one batch", async () => {
      const results = await store.batch([
        { namespace: ["batch_test"], key: "item1", value: { num: 1 } } as PutOperation,
        { namespace: ["batch_test"], key: "item2", value: { num: 2 } } as PutOperation,
        { namespace: ["batch_test"], key: "item1" } as GetOperation,
      ]);

      expect(results[0]).toBeUndefined();
      expect(results[1]).toBeUndefined();
      expect(results[2]?.value).toEqual({ num: 1 });
    });
  });

  // Vector search tests require the atlas-local container with mongot.
  // Both manual and auto embedding use $vectorSearch which needs a search index.
  // Skip if TEST_MONGODB_VECTORSEARCH is not set.
  describe.skipIf(!process.env.TEST_MONGODB_VECTORSEARCH)("vector search", () => {
    // Deterministic test embeddings based on text hash
    const createTestEmbeddings = (): EmbeddingsInterface => {
      const hashText = (text: string): number => {
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
          hash = ((hash << 5) - hash) + text.charCodeAt(i);
          hash = hash & hash;
        }
        return hash;
      };

      const textToEmbedding = (text: string): number[] => {
        const hash = hashText(text);
        const embedding = new Array(10).fill(0);
        for (let i = 0; i < 10; i++) {
          embedding[i] = Math.sin((hash + i) * 0.1);
        }
        return embedding;
      };

      return {
        embedDocuments: async (texts: string[]) => texts.map(textToEmbedding),
        embedQuery: async (text: string) => textToEmbedding(text),
      };
    };

    async function searchWithRetry(
      targetStore: MongoDBStore,
      op: SearchOperation,
      timeoutMs = 90_000
    ): Promise<any[]> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const results = (await targetStore.batch([op]))[0] as any[];
        if (results.length > 0) return results;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      throw new Error(
        `Search returned no results within ${timeoutMs}ms`
      );
    }

    describe("manual embedding", () => {
      let manualStore: MongoDBStore;
      const manualCollectionName = "test_manual_embedding";

      beforeAll(async () => {
        await client.db(dbName).collection(manualCollectionName).drop().catch(() => {});

        const connString = getEnvironmentVariable("MONGODB_URL") || "mongodb://localhost:27017";
        manualStore = await MongoDBStore.fromConnString(connString, {
          dbName,
          collectionName: manualCollectionName,
          embeddings: createTestEmbeddings(),
          indexConfig: { name: "test_manual_index", dims: 10 },
        });


        await manualStore.batch([
          { namespace: ["docs", "ai"], key: "ml", value: { content: "Machine learning algorithms for classification" } } as PutOperation,
          { namespace: ["docs", "ai"], key: "dl", value: { content: "Deep neural networks and backpropagation" } } as PutOperation,
          { namespace: ["docs", "db"], key: "idx", value: { content: "Database indexing strategies for performance" } } as PutOperation,
          { namespace: ["docs", "db"], key: "sql", value: { content: "SQL query optimization techniques" } } as PutOperation,
        ]);
      }, 120_000);

      afterAll(async () => {
        await client.db(dbName).collection(manualCollectionName).drop().catch(() => {});
      });

      it("should create a vectorSearch index with vector field", async () => {
        const indexes = await client
          .db(dbName)
          .collection(manualCollectionName)
          .listSearchIndexes()
          .toArray();

        const manualIndex = indexes.find((idx: any) => idx.name === "test_manual_index");
        expect(manualIndex).toBeDefined();

        const vectorField = manualIndex!.latestDefinition?.fields?.find(
          (f: any) => f.type === "vector"
        );
        expect(vectorField).toBeDefined();
        expect(vectorField!.path).toBe("embedding");
        expect(vectorField!.numDimensions).toBe(10);
      });

      it("should store embedding vector on put", async () => {
        const doc = await client
          .db(dbName)
          .collection(manualCollectionName)
          .findOne({ namespace: ["docs", "ai"], key: "ml" });

        expect(doc).toBeDefined();
        expect(Array.isArray(doc!.embedding)).toBe(true);
        expect(doc!.embedding.length).toBe(10);
        expect(doc!.embedding.every((v: any) => typeof v === "number")).toBe(true);
      });

      it("should store namespacePath on put", async () => {
        const doc = await client
          .db(dbName)
          .collection(manualCollectionName)
          .findOne({ namespace: ["docs", "ai"], key: "ml" });

        expect(doc).toBeDefined();
        expect(doc!.namespacePath).toEqual(["docs", "docs/ai"]);
      });

      it("should skip embedding when op.index is false", async () => {
        await manualStore.batch([{
          namespace: ["docs", "skip"],
          key: "skip1",
          value: { content: "Should not embed" },
          index: false,
        } as PutOperation]);

        const doc = await client
          .db(dbName)
          .collection(manualCollectionName)
          .findOne({ namespace: ["docs", "skip"], key: "skip1" });

        expect(doc).toBeDefined();
        expect(doc!.embedding).toBeUndefined();
      });

      it("should return scored results ranked by similarity", async () => {
        const results = await searchWithRetry(manualStore, {
          namespacePrefix: ["docs"],
          query: "neural networks",
          limit: 4,
          offset: 0,
        } as SearchOperation);

        expect(results.length).toBeGreaterThan(1);
        expect(results[0].score).toBeDefined();
        expect(typeof results[0].score).toBe("number");
        // We can only verify scores are in descending order, not semantic relevance,
        // because the test embeddings are synthetic (hash-based, not a real model).
        for (let i = 0; i < results.length - 1; i++) {
          expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
        }
      });

      it("should scope results to the searched namespace prefix", async () => {
        const results = await searchWithRetry(manualStore, {
          namespacePrefix: ["docs", "db"],
          query: "database performance",
          limit: 10,
          offset: 0,
        } as SearchOperation);

        expect(results.length).toBeGreaterThan(0);
        for (const item of results) {
          expect(item.namespace[0]).toBe("docs");
          expect(item.namespace[1]).toBe("db");
        }
      });
    });

    describe.skipIf(!process.env.TEST_MONGODB_AUTOEMBEDDING)("auto embedding", () => {
      let autoStore: MongoDBStore;
      const autoCollectionName = "test_auto_embedding";

      beforeAll(async () => {
        await client.db(dbName).collection(autoCollectionName).drop().catch(() => {});

        const connString = getEnvironmentVariable("MONGODB_URL") || "mongodb://localhost:27017";
        autoStore = await MongoDBStore.fromConnString(connString, {
          dbName,
          collectionName: autoCollectionName,
          indexConfig: { name: "test_auto_index", path: "value.content", model: "voyage-4" } as any as IndexConfig,
        });


        await autoStore.batch([
          { namespace: ["docs", "ai"], key: "ml", value: { content: "Machine learning algorithms for classification" } } as PutOperation,
          { namespace: ["docs", "ai"], key: "dl", value: { content: "Deep neural networks and backpropagation" } } as PutOperation,
          { namespace: ["docs", "db"], key: "idx", value: { content: "Database indexing strategies for performance" } } as PutOperation,
          { namespace: ["docs", "db"], key: "sql", value: { content: "SQL query optimization techniques" } } as PutOperation,
        ]);
      }, 120_000);

      afterAll(async () => {
        await client.db(dbName).collection(autoCollectionName).drop().catch(() => {});
      });

      it("should create a vectorSearch index with autoEmbed field", async () => {
        const indexes = await client
          .db(dbName)
          .collection(autoCollectionName)
          .listSearchIndexes()
          .toArray();

        const autoIndex = indexes.find((idx: any) => idx.name === "test_auto_index");
        expect(autoIndex).toBeDefined();

        const autoEmbedField = autoIndex!.latestDefinition?.fields?.find(
          (f: any) => f.type === "autoEmbed"
        );
        expect(autoEmbedField).toBeDefined();
        expect(autoEmbedField!.path).toBe("value.content");
      });

      it("should store documents without a separate embedding field", async () => {
        const doc = await client
          .db(dbName)
          .collection(autoCollectionName)
          .findOne({ namespace: ["docs", "ai"], key: "ml" });

        expect(doc).toBeDefined();
        expect(doc!.embedding).toBeUndefined();
        expect(doc!.value.content).toBeDefined();
      });

      it("should return the most relevant result first", async () => {
        const results = await searchWithRetry(autoStore, {
          namespacePrefix: ["docs"],
          query: "neural networks",
          limit: 4,
          offset: 0,
        } as SearchOperation);

        expect(results.length).toBeGreaterThan(1);
        // "Deep neural networks..." should rank highest for "neural networks"
        expect(results[0].value.content).toContain("neural networks");
        // Scores should be in descending order
        for (let i = 0; i < results.length - 1; i++) {
          expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
        }
      });

      it("should scope results to the searched namespace prefix", async () => {
        const results = await searchWithRetry(autoStore, {
          namespacePrefix: ["docs", "db"],
          query: "database performance",
          limit: 10,
          offset: 0,
        } as SearchOperation);

        expect(results.length).toBeGreaterThan(0);
        for (const item of results) {
          expect(item.namespace[0]).toBe("docs");
          expect(item.namespace[1]).toBe("db");
        }
      });
    });
  });
});
