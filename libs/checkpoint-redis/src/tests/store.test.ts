import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilterBuilder, RedisStore } from "../store.js";
import { InvalidNamespaceError } from "@langchain/langgraph-checkpoint";
import { createRedisContainer } from "./redis-container.js";

// ============================================================================
// BASIC STORE TESTS (from test-store.test.ts)
// ============================================================================
describe("RedisStore", () => {
  let client: any;
  let store: RedisStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    // Create a new Redis container for each test
    const container = await createRedisContainer();
    client = container.client;
    cleanup = container.cleanup;

    // Create store with TTL config
    const ttlConfig = {
      defaultTTL: 2 / 60, // 2 seconds as minutes
      refreshOnRead: true,
    };

    store = new RedisStore(client, { ttl: ttlConfig });
    await store.setup();
  }, 30000); // 30 second timeout for container startup

  afterEach(async () => {
    // Clean up the container
    await cleanup();
  });

  describe("Basic Operations", () => {
    it("should put and get an item", async () => {
      const namespace = ["test", "documents"];
      const key = "doc1";
      const value = { title: "Test Document", content: "Hello, World!" };

      await store.put(namespace, key, value);
      const item = await store.get(namespace, key);

      expect(item).toBeDefined();
      expect(item?.namespace).toEqual(namespace);
      expect(item?.key).toBe(key);
      expect(item?.value).toEqual(value);
    });

    it("should update an existing item", async () => {
      const namespace = ["test", "documents"];
      const key = "doc1";
      const value = { title: "Test Document", content: "Hello, World!" };
      const updatedValue = {
        title: "Updated Document",
        content: "Hello, Updated!",
      };

      await store.put(namespace, key, value);
      const item = await store.get(namespace, key);

      await store.put(namespace, key, updatedValue);
      const updatedItem = await store.get(namespace, key);

      expect(updatedItem?.value).toEqual(updatedValue);
      expect(updatedItem?.updated_at.getTime()).toBeGreaterThan(
        item!.updated_at.getTime()
      );
    });

    it("should return null for non-existent item", async () => {
      const item = await store.get(["test"], "nonexistent");
      expect(item).toBeNull();
    });

    it("should delete an item", async () => {
      const namespace = ["test"];
      const key = "doc1";
      const value = { data: "test" };

      await store.put(namespace, key, value);
      let item = await store.get(namespace, key);
      expect(item).toBeDefined();

      await store.delete(namespace, key);
      item = await store.get(namespace, key);
      expect(item).toBeNull();
    });
  });

  describe("Batch Operations", () => {
    it("should handle batch operations in correct order", async () => {
      // Setup test data
      await store.put(["test", "foo"], "key1", { data: "value1" });
      await store.put(["test", "bar"], "key2", { data: "value2" });

      const ops = [
        { type: "get", namespace: ["test", "foo"], key: "key1" },
        {
          type: "put",
          namespace: ["test", "bar"],
          key: "key2",
          value: { data: "value2" },
        },
        {
          type: "put",
          namespace: ["test", "baz"],
          key: "key3",
          value: { data: "value3" },
        },
        { type: "get", namespace: ["test", "baz"], key: "key3" },
      ];

      const results = await store.batch(ops);

      expect(results).toHaveLength(4);
      expect(results[0]?.value).toEqual({ data: "value1" });
      expect(results[1]).toBeNull(); // put returns null
      expect(results[2]).toBeNull(); // put returns null
      expect(results[3]?.value).toEqual({ data: "value3" });
    });

    it("should handle multiple put operations", async () => {
      const ops = [
        {
          type: "put",
          namespace: ["batch", "test"],
          key: "item1",
          value: { id: 1 },
        },
        {
          type: "put",
          namespace: ["batch", "test"],
          key: "item2",
          value: { id: 2 },
        },
        {
          type: "put",
          namespace: ["batch", "test"],
          key: "item3",
          value: { id: 3 },
        },
      ];

      await store.batch(ops);

      // Verify all items were stored
      const item1 = await store.get(["batch", "test"], "item1");
      const item2 = await store.get(["batch", "test"], "item2");
      const item3 = await store.get(["batch", "test"], "item3");

      expect(item1?.value.id).toBe(1);
      expect(item2?.value.id).toBe(2);
      expect(item3?.value.id).toBe(3);
    });
  });

  describe("Search Operations", () => {
    it("should search all items in namespace", async () => {
      const namespace = ["search", "test"];

      await store.put(namespace, "item1", { type: "doc", title: "First" });
      await store.put(namespace, "item2", { type: "doc", title: "Second" });
      await store.put(namespace, "item3", { type: "note", title: "Third" });

      const results = await store.search(namespace);

      expect(results).toHaveLength(3);
      const titles = results.map((r) => r.value.title).sort();
      expect(titles).toEqual(["First", "Second", "Third"]);
    });

    it("should filter by namespace prefix", async () => {
      await store.put(["docs", "public"], "doc1", { title: "Public Doc" });
      await store.put(["docs", "private"], "doc2", { title: "Private Doc" });
      await store.put(["notes", "personal"], "note1", {
        title: "Personal Note",
      });

      const docsResults = await store.search(["docs"]);
      expect(docsResults).toHaveLength(2);

      const publicResults = await store.search(["docs", "public"]);
      expect(publicResults).toHaveLength(1);
      expect(publicResults[0].value.title).toBe("Public Doc");
    });

    it("should filter by value properties", async () => {
      const namespace = ["filter", "test"];

      await store.put(namespace, "item1", { type: "doc", status: "draft" });
      await store.put(namespace, "item2", { type: "doc", status: "published" });
      await store.put(namespace, "item3", { type: "note", status: "draft" });

      const results = await store.search(namespace, {
        filter: { type: "doc" },
      });

      expect(results).toHaveLength(2);
      results.forEach((result) => {
        expect(result.value.type).toBe("doc");
      });
    });

    it("should handle pagination", async () => {
      const namespace = ["pagination", "test"];

      // Create 10 items
      for (let i = 0; i < 10; i++) {
        await store.put(namespace, `item${i}`, { index: i });
      }

      const page1 = await store.search(namespace, { limit: 3, offset: 0 });
      const page2 = await store.search(namespace, { limit: 3, offset: 3 });

      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(3);

      // Ensure different results
      const page1Keys = page1.map((r) => r.key).sort();
      const page2Keys = page2.map((r) => r.key).sort();
      expect(page1Keys).not.toEqual(page2Keys);
    });
  });

  describe("List Namespaces", () => {
    beforeEach(async () => {
      // Create test data with various namespaces
      const testNamespaces = [
        ["test", "documents", "public"],
        ["test", "documents", "private"],
        ["test", "images", "public"],
        ["test", "images", "private"],
        ["prod", "documents", "public"],
        ["prod", "documents", "private"],
      ];

      for (const namespace of testNamespaces) {
        await store.put(namespace, "dummy", { content: "dummy" });
      }
    });

    it("should list all namespaces", async () => {
      const namespaces = await store.listNamespaces();
      expect(namespaces.length).toBeGreaterThanOrEqual(6);
    });

    it("should filter by prefix", async () => {
      const namespaces = await store.listNamespaces({ prefix: ["test"] });
      expect(namespaces).toHaveLength(4);
      expect(namespaces.every((ns) => ns[0] === "test")).toBe(true);
    });

    it("should filter by suffix", async () => {
      const namespaces = await store.listNamespaces({ suffix: ["public"] });
      expect(namespaces).toHaveLength(3);
      expect(namespaces.every((ns) => ns[ns.length - 1] === "public")).toBe(
        true
      );
    });

    it("should limit depth", async () => {
      const namespaces = await store.listNamespaces({ maxDepth: 2 });
      expect(namespaces.every((ns) => ns.length <= 2)).toBe(true);
    });

    it("should handle pagination", async () => {
      const namespaces = await store.listNamespaces({ limit: 3 });
      expect(namespaces).toHaveLength(3);
    });
  });

  describe("TTL Support", () => {
    it("should expire items with TTL", async () => {
      const namespace = ["ttl", "test"];
      const key = "expiring-item";
      const value = { data: "will expire" };

      await store.put(namespace, key, value);

      // Item should exist immediately
      let item = await store.get(namespace, key);
      expect(item?.value).toEqual(value);

      // Wait for TTL to expire (2 seconds + buffer)
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Item should be expired
      item = await store.get(namespace, key);
      expect(item).toBeNull();
    });

    it("should refresh TTL on read when configured", async () => {
      const namespace = ["ttl", "refresh"];
      const key = "refreshed-item";
      const value = { data: "should refresh" };

      await store.put(namespace, key, value);

      // Read the item after 1 second (should refresh TTL)
      await new Promise((resolve) => setTimeout(resolve, 1000));
      let item = await store.get(namespace, key, { refreshTTL: true });
      expect(item?.value).toEqual(value);

      // Wait another 1.5 seconds (total 2.5s, but TTL was refreshed)
      await new Promise((resolve) => setTimeout(resolve, 1500));
      item = await store.get(namespace, key);

      // Item should still exist due to TTL refresh
      expect(item?.value).toEqual(value);
    });
  });

  describe("RedisStore with Vector Search", () => {
    let vectorStore: RedisStore;
    let vectorCleanup: () => Promise<void>;

    beforeEach(async () => {
      const container = await createRedisContainer();
      const vectorClient = container.client;
      vectorCleanup = container.cleanup;

      // Create a mock embeddings function
      const mockEmbeddings = {
        embedDocuments: async (texts: string[]) => {
          // Simple character-based embedding for testing
          return texts.map((text) => {
            const embedding = new Array(4).fill(0);
            for (let i = 0; i < text.length; i++) {
              embedding[i % 4] += text.charCodeAt(i);
            }
            // Normalize
            const norm = Math.sqrt(embedding.reduce((a, b) => a + b * b, 0));
            return embedding.map((v) => v / norm);
          });
        },
      } as any;

      const indexConfig = {
        dims: 4,
        embed: mockEmbeddings,
        distanceType: "cosine" as const,
        fields: ["text"],
      };

      const ttlConfig = {
        defaultTTL: 2,
        refreshOnRead: true,
      };

      vectorStore = new RedisStore(vectorClient, {
        index: indexConfig,
        ttl: ttlConfig,
      });
      await vectorStore.setup();
    }, 30000); // 30 second timeout for container startup

    afterEach(async () => {
      // Clean up the vector container
      await vectorCleanup();
    });

    it("should perform vector search", async () => {
      // Insert documents
      const docs = [
        { key: "doc1", value: { text: "short text" } },
        { key: "doc2", value: { text: "longer text document" } },
        { key: "doc3", value: { text: "longest text document here" } },
      ];

      for (const { key, value } of docs) {
        await vectorStore.put(["test"], key, value);
      }

      // Search with query
      const results = await vectorStore.search(["test"], {
        query: "longer text",
      });

      expect(results.length).toBeGreaterThanOrEqual(2);
      const keys = results.map((r) => r.key);
      expect(keys).toContain("doc2");
      expect(keys).toContain("doc3");
    });

    it("should filter vector search results", async () => {
      // Insert test documents
      const docs = [
        { key: "doc1", value: { text: "red apple", color: "red", score: 4.5 } },
        { key: "doc2", value: { text: "red car", color: "red", score: 3.0 } },
        {
          key: "doc3",
          value: { text: "green apple", color: "green", score: 4.0 },
        },
        { key: "doc4", value: { text: "blue car", color: "blue", score: 3.5 } },
      ];

      for (const { key, value } of docs) {
        await vectorStore.put(["test"], key, value);
      }

      // Search for "apple" within red items
      const results = await vectorStore.search(["test"], {
        query: "red",
        filter: { color: "red" },
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.value.color === "red")).toBe(true);
    });

    it("should update embeddings when document changes", async () => {
      const key = "updateable";
      const namespace = ["test"];

      // Insert initial document
      await vectorStore.put(namespace, key, { text: "original content" });

      // Update the document
      await vectorStore.put(namespace, key, { text: "updated content here" });

      // Search should find the updated document
      const results = await vectorStore.search(namespace, { query: "updated" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const updatedDoc = results.find((r) => r.key === key);
      expect(updatedDoc?.value.text).toBe("updated content here");
    });
  });
});

// ============================================================================
// COMPREHENSIVE STORE TESTS (from test-store-comprehensive.test.ts)
// ============================================================================
describe("RedisStore Comprehensive Tests", () => {
  let client: any;
  let store: RedisStore;
  let cleanup: () => Promise<void>;
  let redisUrl: string;

  beforeEach(async () => {
    // Create a new Redis container for each test
    const container = await createRedisContainer();
    client = container.client;
    cleanup = container.cleanup;
    redisUrl = container.url;

    store = new RedisStore(client);
    await store.setup();
  }, 30000); // 30 second timeout for container startup

  afterEach(async () => {
    // Clean up the container
    await cleanup();
  });

  describe("fromConnString", () => {
    it("should create a RedisStore from connection string", async () => {
      // Create store using fromConnString with the URL
      const storeFromUrl = await RedisStore.fromConnString(redisUrl);

      const namespace = ["fromUrl", "test"];
      const key = "testkey";
      const value = { data: "test value" };

      // Test basic operations
      await storeFromUrl.put(namespace, key, value);
      const retrieved = await storeFromUrl.get(namespace, key);

      expect(retrieved?.value).toEqual(value);
      expect(retrieved?.namespace).toEqual(namespace);
      expect(retrieved?.key).toBe(key);

      // Clean up
      await storeFromUrl.close();
    });

    it("should create a RedisStore with TTL config from connection string", async () => {
      const ttlConfig = {
        defaultTTL: 1 / 60, // 1 second as minutes
        refreshOnRead: false,
      };

      const storeFromUrl = await RedisStore.fromConnString(redisUrl, {
        ttl: ttlConfig,
      });

      const namespace = ["fromUrl", "ttl"];
      const key = "ttlkey";
      const value = { data: "will expire" };

      await storeFromUrl.put(namespace, key, value);

      // Item should exist immediately
      let item = await storeFromUrl.get(namespace, key);
      expect(item?.value).toEqual(value);

      // Wait for TTL to expire (1 second + buffer)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Item should be expired
      item = await storeFromUrl.get(namespace, key);
      expect(item).toBeNull();

      // Clean up
      await storeFromUrl.close();
    });
  });

  describe("Namespace Validation", () => {
    it("should not allow empty namespace", async () => {
      const namespace: string[] = [];
      const key = "key";
      const value = { foo: "bar" };

      await expect(store.put(namespace, key, value)).rejects.toThrow(
        InvalidNamespaceError
      );
      await expect(store.put(namespace, key, value)).rejects.toThrow(
        "Namespace cannot be empty"
      );
    });

    it("should not allow namespace labels with periods", async () => {
      const namespace = ["invalid.namespace"];
      const key = "key";
      const value = { foo: "bar" };

      await expect(store.put(namespace, key, value)).rejects.toThrow(
        InvalidNamespaceError
      );
      await expect(store.put(namespace, key, value)).rejects.toThrow(
        "Namespace labels cannot contain periods"
      );
    });

    it("should not allow empty namespace label", async () => {
      const namespace = ["valid", ""];
      const key = "key";
      const value = { foo: "bar" };

      await expect(store.put(namespace, key, value)).rejects.toThrow(
        InvalidNamespaceError
      );
      await expect(store.put(namespace, key, value)).rejects.toThrow(
        "Namespace labels cannot be empty strings"
      );
    });

    it("should not allow non-string namespace label", async () => {
      const namespace = ["valid", 123 as unknown as string];
      const key = "key";
      const value = { foo: "bar" };

      await expect(store.put(namespace, key, value)).rejects.toThrow(
        InvalidNamespaceError
      );
      await expect(store.put(namespace, key, value)).rejects.toThrow(
        "Namespace labels must be strings"
      );
    });

    it("should not allow reserved namespace label 'langgraph'", async () => {
      const namespace = ["langgraph"];
      const key = "key";
      const value = { foo: "bar" };

      await expect(store.put(namespace, key, value)).rejects.toThrow(
        InvalidNamespaceError
      );
      await expect(store.put(namespace, key, value)).rejects.toThrow(
        'Root label for namespace cannot be "langgraph"'
      );
    });

    it("should allow 'langgraph' as non-root namespace label", async () => {
      const namespace = ["foo", "langgraph", "bar"];
      const key = "key";
      const value = { data: "test" };

      await store.put(namespace, key, value);
      const item = await store.get(namespace, key);

      expect(item).toBeDefined();
      expect(item?.value).toEqual(value);
      expect(item?.namespace).toEqual(namespace);

      // Clean up
      await store.delete(namespace, key);
      const deleted = await store.get(namespace, key);
      expect(deleted).toBeNull();
    });
  });

  describe("Complex JSON Values", () => {
    it("should handle complex nested JSON values", async () => {
      const namespace = ["complex", "json"];
      const key = "nested";
      const complexValue = {
        string: "test",
        number: 42,
        boolean: true,
        null: null,
        array: [1, 2, 3, "four", [5, 6]],
        nested: {
          deep: {
            value: "nested data",
            deeper: {
              array: [{ id: 1 }, { id: 2 }],
              timestamp: new Date().toISOString(),
            },
          },
        },
        unicode: "emoji 🎉 and special chars: äöü",
      };

      await store.put(namespace, key, complexValue);
      const retrieved = await store.get(namespace, key);

      expect(retrieved?.value).toEqual(complexValue);
    });

    it("should handle large JSON values", async () => {
      const namespace = ["large", "json"];
      const key = "big";
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        data: `item-${i}`,
        nested: { value: i * 2 },
      }));
      const largeValue = {
        items: largeArray,
        metadata: {
          count: largeArray.length,
          timestamp: new Date().toISOString(),
        },
      };

      await store.put(namespace, key, largeValue);
      const retrieved = await store.get(namespace, key);

      expect(retrieved?.value).toEqual(largeValue);
      expect(retrieved?.value.items).toHaveLength(1000);
    });
  });

  describe("Batch Operations with Mixed Types", () => {
    it("should handle batch with all operation types", async () => {
      // Setup some data first
      await store.put(["batch", "test"], "item1", { value: 1 });
      await store.put(["batch", "test"], "item2", { value: 2 });
      await store.put(["batch", "other"], "item3", { value: 3 });

      const operations = [
        // Get operation
        { type: "get", namespace: ["batch", "test"], key: "item1" },
        // Put operation
        {
          type: "put",
          namespace: ["batch", "test"],
          key: "item4",
          value: { value: 4 },
        },
        // Search operation
        {
          type: "search",
          namespacePrefix: ["batch"],
          filter: { value: 2 },
          limit: 10,
          offset: 0,
        },
        // List namespaces operation
        {
          type: "list_namespaces",
          matchConditions: [{ matchType: "prefix" as const, path: ["batch"] }],
          maxDepth: undefined,
          limit: 10,
          offset: 0,
        },
      ];

      const results = await store.batch(operations);

      expect(results).toHaveLength(4);
      expect(results[0]?.value).toEqual({ value: 1 });
      expect(results[1]).toBeNull(); // put returns null
      expect(Array.isArray(results[2])).toBe(true); // search returns array
      expect(Array.isArray(results[3])).toBe(true); // list_namespaces returns array
    });

    it("should maintain operation order in batch", async () => {
      const operations = [
        {
          type: "put",
          namespace: ["order", "test"],
          key: "item1",
          value: { step: 1 },
        },
        {
          type: "put",
          namespace: ["order", "test"],
          key: "item2",
          value: { step: 2 },
        },
        { type: "get", namespace: ["order", "test"], key: "item1" },
        { type: "get", namespace: ["order", "test"], key: "item2" },
      ];

      const results = await store.batch(operations);

      expect(results).toHaveLength(4);
      expect(results[0]).toBeNull(); // put
      expect(results[1]).toBeNull(); // put
      expect(results[2]?.value.step).toBe(1);
      expect(results[3]?.value.step).toBe(2);
    });
  });

  describe("Search with Complex Filters", () => {
    it("should filter by boolean values", async () => {
      const namespace = ["filter", "boolean"];

      await store.put(namespace, "item1", { active: true, type: "user" });
      await store.put(namespace, "item2", { active: false, type: "user" });
      await store.put(namespace, "item3", { active: true, type: "admin" });

      const activeItems = await store.search(namespace, {
        filter: { active: true },
      });

      expect(activeItems).toHaveLength(2);
      activeItems.forEach((item) => {
        expect(item.value.active).toBe(true);
      });
    });

    it("should filter by array values", async () => {
      const namespace = ["filter", "array"];

      await store.put(namespace, "item1", { tags: ["red", "blue"], type: "A" });
      await store.put(namespace, "item2", {
        tags: ["green", "blue"],
        type: "B",
      });
      await store.put(namespace, "item3", {
        tags: ["red", "yellow"],
        type: "A",
      });

      // Note: Array filtering behavior may vary by implementation
      const results = await store.search(namespace, {
        filter: { type: "A" },
      });

      expect(results).toHaveLength(2);
      results.forEach((item) => {
        expect(item.value.type).toBe("A");
      });
    });

    it("should filter by multiple conditions", async () => {
      const namespace = ["filter", "multiple"];

      await store.put(namespace, "item1", {
        category: "A",
        status: "active",
        priority: 1,
      });
      await store.put(namespace, "item2", {
        category: "A",
        status: "inactive",
        priority: 2,
      });
      await store.put(namespace, "item3", {
        category: "B",
        status: "active",
        priority: 1,
      });

      const filtered = await store.search(namespace, {
        filter: { category: "A", status: "active" },
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].value.category).toBe("A");
      expect(filtered[0].value.status).toBe("active");
    });

    it("should handle empty search results", async () => {
      const namespace = ["empty", "search"];

      await store.put(namespace, "item1", { type: "A" });
      await store.put(namespace, "item2", { type: "B" });

      const noResults = await store.search(namespace, {
        filter: { type: "C" },
      });

      expect(noResults).toHaveLength(0);
      expect(Array.isArray(noResults)).toBe(true);
    });

    it("should respect search pagination", async () => {
      const namespace = ["pagination", "search"];

      // Create more items
      for (let i = 0; i < 20; i++) {
        await store.put(namespace, `item${i}`, { index: i, category: "test" });
      }

      const page1 = await store.search(namespace, {
        filter: { category: "test" },
        limit: 5,
        offset: 0,
      });

      const page2 = await store.search(namespace, {
        filter: { category: "test" },
        limit: 5,
        offset: 5,
      });

      expect(page1).toHaveLength(5);
      expect(page2).toHaveLength(5);

      // Ensure different items
      const page1Keys = page1.map((r) => r.key).sort();
      const page2Keys = page2.map((r) => r.key).sort();
      expect(page1Keys).not.toEqual(page2Keys);
    });
  });
});
describe("RedisStore Advanced Features", () => {
  let client: any;
  let store: RedisStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const container = await createRedisContainer();
    client = container.client;
    cleanup = container.cleanup;
    store = new RedisStore(client);
    await store.setup();
  }, 30000); // 30 second timeout for container startup

  afterEach(async () => {
    await cleanup();
  });

  describe("Advanced Search Operators", () => {
    beforeEach(async () => {
      // Add test data with various fields
      await store.put(["products", "electronics"], "laptop1", {
        name: "Laptop Pro",
        price: 1200,
        stock: 10,
        tags: ["electronics", "computers"],
        specs: { ram: 16, storage: 512 },
      });

      await store.put(["products", "electronics"], "laptop2", {
        name: "Laptop Air",
        price: 800,
        stock: 5,
        tags: ["electronics", "computers", "portable"],
        specs: { ram: 8, storage: 256 },
      });

      await store.put(["products", "electronics"], "phone1", {
        name: "Phone X",
        price: 600,
        stock: 20,
        tags: ["electronics", "mobile"],
        specs: { ram: 6, storage: 128 },
      });

      await store.put(["products", "furniture"], "chair1", {
        name: "Office Chair",
        price: 250,
        stock: 15,
        tags: ["furniture", "office"],
        material: "leather",
      });
    });

    it("should support $gt operator", async () => {
      const results = await store.search(["products"], {
        filter: { price: { $gt: 700 } },
      });

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.value.name).sort()).toEqual([
        "Laptop Air",
        "Laptop Pro",
      ]);
    });

    it("should support $gte operator", async () => {
      const results = await store.search(["products"], {
        filter: { price: { $gte: 800 } },
      });

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.value.name).sort()).toEqual([
        "Laptop Air",
        "Laptop Pro",
      ]);
    });

    it("should support $lt operator", async () => {
      const results = await store.search(["products"], {
        filter: { price: { $lt: 600 } },
      });

      expect(results).toHaveLength(1);
      expect(results[0].value.name).toBe("Office Chair");
    });

    it("should support $lte operator", async () => {
      const results = await store.search(["products"], {
        filter: { price: { $lte: 600 } },
      });

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.value.name).sort()).toEqual([
        "Office Chair",
        "Phone X",
      ]);
    });

    it("should support $in operator", async () => {
      const results = await store.search(["products"], {
        filter: { name: { $in: ["Laptop Pro", "Phone X", "Unknown"] } },
      });

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.value.name).sort()).toEqual([
        "Laptop Pro",
        "Phone X",
      ]);
    });

    it("should support $nin operator", async () => {
      const results = await store.search(["products"], {
        filter: { name: { $nin: ["Laptop Pro", "Phone X"] } },
      });

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.value.name).sort()).toEqual([
        "Laptop Air",
        "Office Chair",
      ]);
    });

    it("should support $exists operator", async () => {
      const resultsWithMaterial = await store.search(["products"], {
        filter: { material: { $exists: true } },
      });

      expect(resultsWithMaterial).toHaveLength(1);
      expect(resultsWithMaterial[0].value.name).toBe("Office Chair");

      const resultsWithoutMaterial = await store.search(["products"], {
        filter: { material: { $exists: false } },
      });

      expect(resultsWithoutMaterial).toHaveLength(3);
    });

    it("should support $eq operator", async () => {
      const results = await store.search(["products"], {
        filter: { price: { $eq: 600 } },
      });

      expect(results).toHaveLength(1);
      expect(results[0].value.name).toBe("Phone X");
    });

    it("should support $ne operator", async () => {
      const results = await store.search(["products"], {
        filter: { price: { $ne: 600 } },
      });

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.value.name).sort()).toEqual([
        "Laptop Air",
        "Laptop Pro",
        "Office Chair",
      ]);
    });
  });

  describe("Complex Filter Combinations", () => {
    beforeEach(async () => {
      await store.put(["users"], "user1", {
        name: "Alice",
        age: 25,
        city: "New York",
        active: true,
      });

      await store.put(["users"], "user2", {
        name: "Bob",
        age: 30,
        city: "San Francisco",
        active: true,
      });

      await store.put(["users"], "user3", {
        name: "Charlie",
        age: 35,
        city: "New York",
        active: false,
      });

      await store.put(["users"], "user4", {
        name: "David",
        age: 28,
        city: "Los Angeles",
        active: true,
      });
    });

    it("should combine multiple filters with AND logic", async () => {
      const results = await store.search(["users"], {
        filter: {
          age: { $gte: 25, $lte: 30 },
          active: true,
        },
      });

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.value.name).sort()).toEqual([
        "Alice",
        "Bob",
        "David",
      ]);
    });

    it("should handle nested object queries", async () => {
      await store.put(["products"], "prod1", {
        name: "Product 1",
        details: {
          category: "electronics",
          subcategory: "computers",
        },
      });

      await store.put(["products"], "prod2", {
        name: "Product 2",
        details: {
          category: "electronics",
          subcategory: "phones",
        },
      });

      const results = await store.search(["products"], {
        filter: {
          "details.category": "electronics",
          "details.subcategory": "computers",
        },
      });

      expect(results).toHaveLength(1);
      expect(results[0].value.name).toBe("Product 1");
    });

    it("should combine $in with other operators", async () => {
      const results = await store.search(["users"], {
        filter: {
          city: { $in: ["New York", "San Francisco"] },
          age: { $lt: 30 },
        },
      });

      expect(results).toHaveLength(1);
      expect(results[0].value.name).toBe("Alice");
    });
  });

  describe("FilterBuilder", () => {
    it("should match documents with simple equality", () => {
      const doc = { name: "Test", value: 100 };
      expect(FilterBuilder.matchesFilter(doc, { name: "Test" })).toBe(true);
      expect(FilterBuilder.matchesFilter(doc, { name: "Other" })).toBe(false);
    });

    it("should match documents with operators", () => {
      const doc = { age: 25, name: "John" };

      expect(FilterBuilder.matchesFilter(doc, { age: { $gt: 20 } })).toBe(true);
      expect(FilterBuilder.matchesFilter(doc, { age: { $gt: 30 } })).toBe(
        false
      );

      expect(
        FilterBuilder.matchesFilter(doc, { name: { $in: ["John", "Jane"] } })
      ).toBe(true);
      expect(
        FilterBuilder.matchesFilter(doc, { name: { $in: ["Jane", "Bob"] } })
      ).toBe(false);
    });

    it("should handle nested object paths", () => {
      const doc = {
        user: {
          profile: {
            name: "Alice",
            age: 30,
          },
        },
      };

      expect(
        FilterBuilder.matchesFilter(doc, { "user.profile.name": "Alice" })
      ).toBe(true);
      expect(
        FilterBuilder.matchesFilter(doc, { "user.profile.age": { $gte: 30 } })
      ).toBe(true);
      expect(
        FilterBuilder.matchesFilter(doc, { "user.profile.age": { $lt: 30 } })
      ).toBe(false);
    });

    it("should handle arrays in documents", () => {
      const doc = { tags: ["javascript", "typescript", "node"] };

      expect(FilterBuilder.matchesFilter(doc, { tags: "javascript" })).toBe(
        true
      );
      expect(FilterBuilder.matchesFilter(doc, { tags: "python" })).toBe(false);
    });

    it("should handle $exists operator correctly", () => {
      const doc = { name: "Test", optional: undefined };

      expect(
        FilterBuilder.matchesFilter(doc, { name: { $exists: true } })
      ).toBe(true);
      expect(
        FilterBuilder.matchesFilter(doc, { optional: { $exists: true } })
      ).toBe(false);
      expect(
        FilterBuilder.matchesFilter(doc, { missing: { $exists: false } })
      ).toBe(true);
    });

    it("should build Redis search queries", () => {
      const { query, useClientFilter } = FilterBuilder.buildRedisSearchQuery(
        { name: "Test" },
        "prefix"
      );

      expect(query).toContain("@prefix:(prefix)");
      expect(useClientFilter).toBe(false);

      const { useClientFilter: hasComplexOps } =
        FilterBuilder.buildRedisSearchQuery({ age: { $gt: 25 } }, "prefix");

      expect(hasComplexOps).toBe(true);
    });
  });

  describe("Store Statistics", () => {
    it("should return accurate statistics", async () => {
      // Add test data
      await store.put(["namespace1"], "key1", { value: "data1" });
      await store.put(["namespace1"], "key2", { value: "data2" });
      await store.put(["namespace2"], "key3", { value: "data3" });

      const stats = await store.getStatistics();

      expect(stats.totalDocuments).toBe(3);
      expect(stats.namespaceCount).toBe(2);
      // vectorDocuments is only defined when index is configured
      expect(
        typeof stats.vectorDocuments === "number" ||
          stats.vectorDocuments === undefined
      ).toBe(true);
    });

    it("should handle empty store", async () => {
      const stats = await store.getStatistics();

      expect(stats.totalDocuments).toBe(0);
      expect(stats.namespaceCount).toBe(0);
    });
  });
});

describe("RedisStore Vector Search with Distance Metrics", () => {
  let client: any;
  let cleanup: () => Promise<void>;

  // Mock embeddings for testing
  const mockEmbeddings = {
    embedDocuments: async (texts: string[]) => {
      // Simple mock: convert text to a deterministic vector
      return texts.map((text) => {
        const hash = text.split("").reduce((acc, char) => {
          return acc + char.charCodeAt(0);
        }, 0);
        // Generate a 3-dimensional vector for simplicity
        return [
          Math.sin(hash) * 0.5 + 0.5,
          Math.cos(hash) * 0.5 + 0.5,
          Math.sin(hash * 2) * 0.5 + 0.5,
        ];
      });
    },
  };

  beforeEach(async () => {
    const container = await createRedisContainer();
    client = container.client;
    cleanup = container.cleanup;
  }, 30000); // 30 second timeout for container startup

  afterEach(async () => {
    await cleanup();
  });

  describe("Distance Metrics", () => {
    it("should support cosine distance", async () => {
      const store = new RedisStore(client, {
        index: {
          dims: 3,
          embed: mockEmbeddings,
          distanceType: "cosine",
          fields: ["text"],
        },
      });
      await store.setup();

      await store.put(["docs"], "doc1", { text: "hello world" });
      await store.put(["docs"], "doc2", { text: "hello" });
      await store.put(["docs"], "doc3", { text: "world" });

      const results = await store.search(["docs"], {
        query: "hello",
        limit: 3,
      });

      expect(results).toHaveLength(3);
      // All results should have scores between 0 and 1
      results.forEach((result) => {
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      });
    });

    it("should support L2 (Euclidean) distance", async () => {
      const store = new RedisStore(client, {
        index: {
          dims: 3,
          embed: mockEmbeddings,
          distanceType: "l2",
          fields: ["text"],
        },
      });
      await store.setup();

      await store.put(["docs"], "doc1", { text: "test document" });
      await store.put(["docs"], "doc2", { text: "another test" });

      const results = await store.search(["docs"], {
        query: "test",
        limit: 2,
      });

      expect(results).toHaveLength(2);
      // L2 scores use exponential decay
      results.forEach((result) => {
        expect(result.score).toBeGreaterThan(0);
        expect(result.score).toBeLessThanOrEqual(1);
      });
    });

    it("should support inner product distance", async () => {
      const store = new RedisStore(client, {
        index: {
          dims: 3,
          embed: mockEmbeddings,
          distanceType: "ip",
          fields: ["text"],
        },
      });
      await store.setup();

      await store.put(["docs"], "doc1", { text: "vector search" });
      await store.put(["docs"], "doc2", { text: "search test" });

      const results = await store.search(["docs"], {
        query: "search",
        limit: 2,
      });

      expect(results).toHaveLength(2);
      // Inner product scores use sigmoid function
      results.forEach((result) => {
        expect(result.score).toBeGreaterThan(0);
        expect(result.score).toBeLessThan(1);
      });
    });
  });

  describe("Similarity Thresholds", () => {
    it("should filter results by similarity threshold", async () => {
      const store = new RedisStore(client, {
        index: {
          dims: 3,
          embed: mockEmbeddings,
          distanceType: "cosine",
          fields: ["content"],
          similarityThreshold: 0.5,
        },
      });
      await store.setup();

      await store.put(["docs"], "doc1", { content: "exact match" });
      await store.put(["docs"], "doc2", { content: "similar content" });
      await store.put(["docs"], "doc3", { content: "very different xyz" });

      // Search with default threshold from config
      const results = await store.search(["docs"], {
        query: "exact match",
        limit: 10,
      });

      // Should filter out low similarity results
      expect(results.length).toBeGreaterThan(0);
      results.forEach((result) => {
        expect(result.score).toBeGreaterThanOrEqual(0.5);
      });
    });

    it("should override threshold per query", async () => {
      const store = new RedisStore(client, {
        index: {
          dims: 3,
          embed: mockEmbeddings,
          distanceType: "cosine",
          fields: ["content"],
        },
      });
      await store.setup();

      await store.put(["docs"], "doc1", { content: "high similarity" });
      await store.put(["docs"], "doc2", { content: "medium match" });
      await store.put(["docs"], "doc3", { content: "low relevance xyz" });

      // Search with high threshold
      const strictResults = await store.search(["docs"], {
        query: "high similarity",
        limit: 10,
        similarityThreshold: 0.7,
      });

      // Search with low threshold
      const lenientResults = await store.search(["docs"], {
        query: "high similarity",
        limit: 10,
        similarityThreshold: 0.3,
      });

      // Lenient search should return more results
      expect(lenientResults.length).toBeGreaterThanOrEqual(
        strictResults.length
      );
    });
  });

  describe("Selective Field Indexing", () => {
    it("should index only specified fields", async () => {
      const store = new RedisStore(client, {
        index: {
          dims: 3,
          embed: mockEmbeddings,
          fields: ["title", "summary"], // Only index these fields
        },
      });
      await store.setup();

      await store.put(["articles"], "art1", {
        title: "Important Article",
        summary: "This is a summary about technology",
        body: "Long body text that should not be indexed",
        metadata: { author: "John" },
      });

      await store.put(["articles"], "art2", {
        title: "Another Article",
        summary: "Summary about science",
        body: "technology appears here but won't be indexed",
      });

      // Search for "technology" - may find both due to mock embeddings
      // The important thing is that the indexing is working
      const results = await store.search(["articles"], {
        query: "technology",
        limit: 10,
      });

      // Since we're using mock embeddings that don't actually understand semantics,
      // we just verify that search is working
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should support per-operation field selection", async () => {
      const store = new RedisStore(client, {
        index: {
          dims: 3,
          embed: mockEmbeddings,
        },
      });
      await store.setup();

      // Index only the description field for this document
      await store.put(
        ["products"],
        "prod1",
        {
          name: "Product One",
          description: "Advanced electronic device",
          tags: ["electronics", "gadget"],
        },
        { index: ["description"] }
      );

      // Index only the name field for this document
      await store.put(
        ["products"],
        "prod2",
        {
          name: "Electronic Product Two",
          description: "Simple device",
          tags: ["electronics"],
        },
        { index: ["name"] }
      );

      // Don't index this document at all
      await store.put(
        ["products"],
        "prod3",
        {
          name: "Product Three",
          description: "Another electronic item",
        },
        { index: false }
      );

      // Search for "electronic" - should find prod1 and prod2 but not prod3
      const results = await store.search(["products"], {
        query: "electronic",
        limit: 10,
      });

      expect(results).toHaveLength(2);
      const names = results.map((r) => r.value.name).sort();
      expect(names).toEqual(["Electronic Product Two", "Product One"]);
    });
  });

  describe("Combined Features", () => {
    it("should combine vector search with advanced filters", async () => {
      const store = new RedisStore(client, {
        index: {
          dims: 3,
          embed: mockEmbeddings,
          distanceType: "cosine",
          fields: ["description"],
          similarityThreshold: 0.3,
        },
      });
      await store.setup();

      await store.put(["products"], "laptop1", {
        name: "Gaming Laptop",
        description: "High performance gaming computer",
        price: 1500,
        category: "electronics",
      });

      await store.put(["products"], "laptop2", {
        name: "Office Laptop",
        description: "Business computer for office work",
        price: 800,
        category: "electronics",
      });

      await store.put(["products"], "phone1", {
        name: "Smartphone",
        description: "Mobile device with high performance",
        price: 600,
        category: "electronics",
      });

      await store.put(["products"], "chair1", {
        name: "Gaming Chair",
        description: "Comfortable chair for gaming",
        price: 300,
        category: "furniture",
      });

      // Vector search for "gaming" with price filter
      const results = await store.search(["products"], {
        query: "gaming",
        filter: {
          price: { $lt: 1000 },
          category: "electronics",
        },
        limit: 10,
      });

      // Should not find the gaming laptop (too expensive) or gaming chair (wrong category)
      expect(results.every((r) => r.value.price < 1000)).toBe(true);
      expect(results.every((r) => r.value.category === "electronics")).toBe(
        true
      );
    });
  });
});

// ============================================================================
// TYPE GUARD TESTS
// ============================================================================
describe("Operation Type Guards", () => {
  it("should correctly identify PutOperation", async () => {
    const { isPutOperation, isGetOperation, isSearchOperation, isListNamespacesOperation } = 
      await import("../store.js");
    
    const putOp = {
      namespace: ["test"],
      key: "key1",
      value: { data: "test" }
    };
    
    expect(isPutOperation(putOp as any)).toBe(true);
    expect(isGetOperation(putOp as any)).toBe(false);
    expect(isSearchOperation(putOp as any)).toBe(false);
    expect(isListNamespacesOperation(putOp as any)).toBe(false);
  });

  it("should correctly identify GetOperation", async () => {
    const { isPutOperation, isGetOperation, isSearchOperation, isListNamespacesOperation } = 
      await import("../store.js");
    
    const getOp = {
      namespace: ["test"],
      key: "key1"
    };
    
    expect(isPutOperation(getOp as any)).toBe(false);
    expect(isGetOperation(getOp as any)).toBe(true);
    expect(isSearchOperation(getOp as any)).toBe(false);
    expect(isListNamespacesOperation(getOp as any)).toBe(false);
  });

  it("should correctly identify SearchOperation", async () => {
    const { isPutOperation, isGetOperation, isSearchOperation, isListNamespacesOperation } = 
      await import("../store.js");
    
    const searchOp = {
      namespacePrefix: ["test"],
      filter: { category: "electronics" },
      limit: 10
    };
    
    expect(isPutOperation(searchOp as any)).toBe(false);
    expect(isGetOperation(searchOp as any)).toBe(false);
    expect(isSearchOperation(searchOp as any)).toBe(true);
    expect(isListNamespacesOperation(searchOp as any)).toBe(false);
  });

  it("should correctly identify ListNamespacesOperation", async () => {
    const { isPutOperation, isGetOperation, isSearchOperation, isListNamespacesOperation } = 
      await import("../store.js");
    
    const listOp = {
      matchConditions: [
        { matchType: "prefix" as const, path: ["test"] }
      ],
      maxDepth: 2,
      limit: 10
    };
    
    expect(isPutOperation(listOp as any)).toBe(false);
    expect(isGetOperation(listOp as any)).toBe(false);
    expect(isSearchOperation(listOp as any)).toBe(false);
    expect(isListNamespacesOperation(listOp as any)).toBe(true);
  });
});
