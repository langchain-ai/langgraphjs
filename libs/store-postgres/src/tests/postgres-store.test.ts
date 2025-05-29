/* eslint-disable no-process-env */
import { describe, it, expect, beforeEach, afterAll, jest } from "@jest/globals";
import pg from "pg";
import { PostgresStore } from "../index.js";

const { Pool } = pg;

// Type interfaces for test data
interface ProductItem {
  name: string;
  price: number;
  category: string;
  inStock: boolean;
  rating: number;
}

interface DocumentItem {
  title: string;
  content: string;
  category: string;
  difficulty: string;
}

// Skip tests if no test database URL is provided
const { TEST_POSTGRES_URL } = process.env;
const describeIf = TEST_POSTGRES_URL ? describe : describe.skip;

let testStores: PostgresStore[] = [];

describeIf("PostgresStore", () => {
  let store: PostgresStore;
  let dbName: string;

  beforeEach(async () => {
    if (!TEST_POSTGRES_URL) {
      throw new Error("TEST_POSTGRES_URL environment variable is required");
    }

    // Create a unique database for each test
    dbName = `lg_store_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await pool.end();
    }

    // Connect to the test database
    const testDbUrl = `${TEST_POSTGRES_URL.split("/").slice(0, -1).join("/")}/${dbName}`;
    store = PostgresStore.fromConnectionString(testDbUrl);
    testStores.push(store);
    
    await store.setup();
  });

  afterAll(async () => {
    // Clean up all test stores
    const cleanupPromises = testStores.map(async (s) => {
      try {
        await s.end();
      } catch (error: unknown) {
        // Silently ignore "pool already ended" errors during cleanup
        const errorStr = String(error);
        if (!errorStr.includes('Called end on pool more than once')) {
          console.warn("Error closing store:", error);
        }
      }
    });
    
    await Promise.all(cleanupPromises);
    testStores = [];

    if (TEST_POSTGRES_URL) {
      // Drop all test databases
      const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
      try {
        const result = await pool.query(`
          SELECT datname FROM pg_database
          WHERE datname LIKE 'lg_store_test_%'
        `);

        for (const row of result.rows) {
          const dbName = row.datname;
          try {
            await pool.query(`DROP DATABASE ${dbName}`);
          } catch (error) {
            console.warn(`Failed to drop database ${dbName}:`, error);
          }
        }
      } finally {
        await pool.end();
      }
    }
  });

  describe("Basic Operations", () => {
    it("should store and retrieve items", async () => {
      const namespace = ["test", "documents"];
      const key = "doc1";
      const value = { title: "Test Document", content: "This is a test" };

      // Store an item
      await store.put(namespace, key, value);

      // Retrieve the item
      const item = await store.get(namespace, key);
      
      expect(item).toBeDefined();
      expect(item?.namespace).toEqual(namespace);
      expect(item?.key).toBe(key);
      expect(item?.value).toEqual(value);
      expect(item?.createdAt).toBeInstanceOf(Date);
      expect(item?.updatedAt).toBeInstanceOf(Date);
    });

    it("should return null for non-existent items", async () => {
      const item = await store.get(["nonexistent"], "key");
      expect(item).toBeNull();
    });

    it("should delete items", async () => {
      const namespace = ["test"];
      const key = "to-delete";
      const value = { data: "will be deleted" };

      // Store an item
      await store.put(namespace, key, value);
      
      // Verify it exists
      let item = await store.get(namespace, key);
      expect(item).toBeDefined();

      // Delete the item
      await store.delete(namespace, key);

      // Verify it's gone
      item = await store.get(namespace, key);
      expect(item).toBeNull();
    });

    it("should update existing items", async () => {
      const namespace = ["update", "test"];
      const key = "item";
      const originalValue = { version: 1, data: "original" };
      const updatedValue = { version: 2, data: "updated" };

      // Store original item
      await store.put(namespace, key, originalValue);
      
      const originalItem = await store.get(namespace, key);
      expect(originalItem?.value).toEqual(originalValue);

      // Update the item
      await store.put(namespace, key, updatedValue);
      
      const updatedItem = await store.get(namespace, key);
      expect(updatedItem?.value).toEqual(updatedValue);
      expect(updatedItem?.updatedAt.getTime()).toBeGreaterThan(
        originalItem?.updatedAt.getTime() || 0
      );
    });

    it("should handle complex JSON values", async () => {
      const namespace = ["complex"];
      const key = "json-test";
      const complexValue = {
        string: "test",
        number: 42,
        boolean: true,
        null: null,
        array: [1, 2, 3, "four"],
        nested: {
          deep: {
            value: "nested data"
          }
        }
      };

      await store.put(namespace, key, complexValue);
      const retrieved = await store.get(namespace, key);
      
      expect(retrieved?.value).toEqual(complexValue);
    });
  });

  describe("Error Handling", () => {
    it("should validate namespace format", async () => {
      // Empty namespace
      await expect(store.put([], "key", { data: "test" }))
        .rejects.toThrow("Namespace cannot be empty");

      // Namespace with periods
      await expect(store.put(["invalid.namespace"], "key", { data: "test" }))
        .rejects.toThrow("Namespace labels cannot contain periods");

      // Empty namespace label
      await expect(store.put(["valid", ""], "key", { data: "test" }))
        .rejects.toThrow("Namespace labels cannot be empty strings");

      // Reserved namespace
      await expect(store.put(["langgraph"], "key", { data: "test" }))
        .rejects.toThrow("Root label for namespace cannot be \"langgraph\"");

      // Non-string namespace label
      await expect(store.put(["valid", 123 as unknown as string], "key", { data: "test" }))
        .rejects.toThrow("Namespace labels must be strings");
    });

    it("should handle database connection errors gracefully", async () => {
      const invalidStore = new PostgresStore({
        connectionOptions: "postgresql://invalid:invalid@localhost:9999/invalid"
      });

      await expect(invalidStore.setup()).rejects.toThrow();
    });

    it("should handle malformed connection strings", async () => {
      expect(() => new PostgresStore({
        connectionOptions: "not-a-valid-connection-string"
      })).not.toThrow(); // Constructor should not throw, but setup should fail
    });
  });

  it("should search items with filters", async () => {
    const namespace = ["search", "test"];
    
    // Store multiple items
    await store.put(namespace, "item1", { type: "document", title: "First Doc" });
    await store.put(namespace, "item2", { type: "document", title: "Second Doc" });
    await store.put(namespace, "item3", { type: "image", title: "First Image" });

    // Search by type
    const results = await store.search(namespace, {
      filter: { type: "document" },
    });

    expect(results).toHaveLength(2);
    expect(results.every((item) => item.value.type === "document")).toBe(true);
  });

  it("should search items with text query", async () => {
    const namespace = ["search", "text"];
    
    // Store items with different content
    await store.put(namespace, "doc1", { 
      title: "JavaScript Guide", 
      content: "Learn JavaScript programming" 
    });
    await store.put(namespace, "doc2", { 
      title: "Python Tutorial", 
      content: "Learn Python programming" 
    });
    await store.put(namespace, "doc3", { 
      title: "Database Design", 
      content: "Learn database concepts" 
    });

    // Search for programming-related content
    const results = await store.search(namespace, {
      query: "programming",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((item) => 
      JSON.stringify(item.value).toLowerCase().includes("programming")
    )).toBe(true);
  });

  it("should list namespaces", async () => {
    // Store items in different namespaces
    await store.put(["docs", "v1"], "item1", { data: "test" });
    await store.put(["docs", "v2"], "item2", { data: "test" });
    await store.put(["cache", "temp"], "item3", { data: "test" });

    // List all namespaces
    const namespaces = await store.listNamespaces();
    
    expect(namespaces.length).toBeGreaterThan(0);
    expect(namespaces).toContainEqual(["docs", "v1"]);
    expect(namespaces).toContainEqual(["docs", "v2"]);
    expect(namespaces).toContainEqual(["cache", "temp"]);
  });

  it("should list namespaces with prefix filter", async () => {
    // Store items in different namespaces
    await store.put(["docs", "v1"], "item1", { data: "test" });
    await store.put(["docs", "v2"], "item2", { data: "test" });
    await store.put(["cache", "temp"], "item3", { data: "test" });

    // List namespaces with prefix
    const namespaces = await store.listNamespaces({
      prefix: ["docs"],
    });
    
    expect(namespaces.length).toBe(2);
    expect(namespaces).toContainEqual(["docs", "v1"]);
    expect(namespaces).toContainEqual(["docs", "v2"]);
    expect(namespaces).not.toContainEqual(["cache", "temp"]);
  });

  it("should handle batch operations", async () => {
    const operations = [
      { namespace: ["batch"], key: "item1", value: { data: "first" } },
      { namespace: ["batch"], key: "item2", value: { data: "second" } },
      { namespace: ["batch"], key: "item1" }, // get operation
    ];

    const results = await store.batch(operations);
    
    expect(results).toHaveLength(3);
    expect(results[0]).toBeUndefined(); // put result
    expect(results[1]).toBeUndefined(); // put result
    expect(results[2]).toBeDefined(); // get result
    const getResult = results[2];
    if (getResult && typeof getResult === 'object' && 'value' in getResult) {
      expect(getResult.value).toEqual({ data: "first" });
    }
  });

  describe("Advanced Features", () => {
    describe("TTL Support", () => {
      it("should support TTL configuration", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping TTL test - no TEST_POSTGRES_URL provided");
          return;
        }

        const storeWithTtl = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_ttl",
          ttl: {
            defaultTtl: 1, // 1 minute
            refreshOnRead: true,
            sweepIntervalMinutes: 1,
          },
        });

        await storeWithTtl.setup();
        testStores.push(storeWithTtl);

        try {
          // Put an item with default TTL
          await storeWithTtl.putAdvanced(["test"], "ttl-item", { data: "expires" });

          // Item should exist immediately
          const item = await storeWithTtl.get(["test"], "ttl-item");
          expect(item).toBeTruthy();
          expect(item?.value).toEqual({ data: "expires" });

          // Put an item with custom TTL
          await storeWithTtl.putAdvanced(["test"], "custom-ttl", { data: "custom" }, { ttl: 2 });

          const customItem = await storeWithTtl.get(["test"], "custom-ttl");
          expect(customItem).toBeTruthy();

          // Test sweep functionality
          const sweptCount = await storeWithTtl.sweepExpiredItems();
          expect(typeof sweptCount).toBe("number");
          expect(sweptCount).toBeGreaterThanOrEqual(0);
        } finally {
          storeWithTtl.stop();
        }
      });

      it("should handle TTL refresh on read", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          return;
        }

        const storeWithTtl = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_ttl_refresh",
          ttl: {
            defaultTtl: 60, // 60 minutes
            refreshOnRead: true,
          },
        });

        await storeWithTtl.setup();
        testStores.push(storeWithTtl);

        try {
          await storeWithTtl.putAdvanced(["test"], "refresh-item", { data: "refresh test" });
          
          const item1 = await storeWithTtl.get(["test"], "refresh-item");
          expect(item1).toBeTruthy();
          
          // Read again to trigger TTL refresh
          const item2 = await storeWithTtl.get(["test"], "refresh-item");
          expect(item2).toBeTruthy();
          expect(item2?.value).toEqual({ data: "refresh test" });
        } finally {
          storeWithTtl.stop();
        }
      });
    });

    describe("Advanced Filtering", () => {
      beforeEach(async () => {
        // Set up test data for advanced filtering
        await store.put(["products"], "item1", { 
          price: 100, 
          category: "electronics", 
          inStock: true,
          rating: 4.5,
          tags: ["popular", "new"]
        });
        await store.put(["products"], "item2", { 
          price: 200, 
          category: "electronics", 
          inStock: false,
          rating: 3.8,
          tags: ["expensive"]
        });
        await store.put(["products"], "item3", { 
          price: 50, 
          category: "books", 
          inStock: true,
          rating: 4.9,
          tags: ["bestseller", "popular"]
        });
        await store.put(["products"], "item4", { 
          price: 150, 
          category: "clothing", 
          inStock: true,
          rating: 4.2,
          tags: ["fashion", "new"]
        });
      });

      it("should support comparison operators", async () => {
        // Test $gt operator
        const expensiveItems = await store.searchAdvanced(["products"], {
          filter: { price: { $gt: 100 } },
        });
        expect(expensiveItems).toHaveLength(2);
        expect(expensiveItems.every(item => (item.value as unknown as ProductItem).price > 100)).toBe(true);

        // Test $gte operator
        const expensiveOrEqual = await store.searchAdvanced(["products"], {
          filter: { price: { $gte: 100 } },
        });
        expect(expensiveOrEqual).toHaveLength(3);

        // Test $lt operator
        const cheapItems = await store.searchAdvanced(["products"], {
          filter: { price: { $lt: 100 } },
        });
        expect(cheapItems).toHaveLength(1);
        expect((cheapItems[0].value as unknown as ProductItem).price).toBe(50);

        // Test $lte operator
        const cheapOrEqual = await store.searchAdvanced(["products"], {
          filter: { price: { $lte: 100 } },
        });
        expect(cheapOrEqual).toHaveLength(2);
      });

      it("should support array operators", async () => {
        // Test $in operator
        const electronicsOrBooks = await store.searchAdvanced(["products"], {
          filter: { category: { $in: ["electronics", "books"] } },
        });
        expect(electronicsOrBooks).toHaveLength(3);

        // Test $nin operator
        const notClothing = await store.searchAdvanced(["products"], {
          filter: { category: { $nin: ["clothing"] } },
        });
        expect(notClothing).toHaveLength(3);
        expect(notClothing.every(item => (item.value as unknown as ProductItem).category !== "clothing")).toBe(true);
      });

      it("should support existence operators", async () => {
        // Test $exists operator
        const itemsWithStock = await store.searchAdvanced(["products"], {
          filter: { inStock: { $exists: true } },
        });
        expect(itemsWithStock).toHaveLength(4);

        // Test $exists false
        const itemsWithoutDescription = await store.searchAdvanced(["products"], {
          filter: { description: { $exists: false } },
        });
        expect(itemsWithoutDescription).toHaveLength(4); // None have description
      });

      it("should support equality operators", async () => {
        // Test $eq operator
        const electronics = await store.searchAdvanced(["products"], {
          filter: { category: { $eq: "electronics" } },
        });
        expect(electronics).toHaveLength(2);

        // Test $ne operator
        const notElectronics = await store.searchAdvanced(["products"], {
          filter: { category: { $ne: "electronics" } },
        });
        expect(notElectronics).toHaveLength(2);
        expect(notElectronics.every(item => (item.value as unknown as ProductItem).category !== "electronics")).toBe(true);
      });

      it("should support complex filter combinations", async () => {
        // Test complex filter
        const inStockElectronics = await store.searchAdvanced(["products"], {
          filter: {
            category: { $eq: "electronics" },
            inStock: { $eq: true },
            price: { $gte: 50, $lte: 150 }
          },
        });
        expect(inStockElectronics).toHaveLength(1);
        expect((inStockElectronics[0].value as unknown as ProductItem).price).toBe(100);

        // Test with rating filter
        const highRatedInStock = await store.searchAdvanced(["products"], {
          filter: {
            inStock: true,
            rating: { $gte: 4.0 }
          },
        });
        expect(highRatedInStock.length).toBeGreaterThan(0);
        expect(highRatedInStock.every(item => {
          const product = item.value as unknown as ProductItem;
          return product.inStock && product.rating >= 4.0;
        })).toBe(true);
      });
    });

    describe("Enhanced Search", () => {
      beforeEach(async () => {
        // Set up test data with searchable content
        await store.put(["docs"], "doc1", { 
          title: "JavaScript Programming Guide", 
          content: "Learn JavaScript programming with examples and tutorials",
          category: "programming",
          difficulty: "beginner"
        });
        await store.put(["docs"], "doc2", { 
          title: "Python Development", 
          content: "Python programming language guide and best practices",
          category: "programming", 
          difficulty: "intermediate"
        });
        await store.put(["docs"], "doc3", { 
          title: "Web Development with JavaScript", 
          content: "Modern web development using JavaScript frameworks",
          category: "web",
          difficulty: "advanced"
        });
        await store.put(["docs"], "doc4", { 
          title: "Database Design Principles", 
          content: "Learn database concepts and SQL optimization",
          category: "database",
          difficulty: "intermediate"
        });
      });

      it("should support enhanced search with similarity scoring", async () => {
        // Search with query and scoring
        const searchResults = await store.searchAdvanced(["docs"], {
          query: "JavaScript programming",
          limit: 10,
        });

        expect(searchResults.length).toBeGreaterThan(0);
        
        // Results should have scores
        const resultsWithScores = searchResults.filter(item => item.score !== undefined);
        expect(resultsWithScores.length).toBeGreaterThan(0);

        // Results should be ordered by relevance (score)
        for (let i = 1; i < resultsWithScores.length; i += 1) {
          expect(resultsWithScores[i - 1].score).toBeGreaterThanOrEqual(resultsWithScores[i].score!);
        }
      });

      it("should combine search query with filters", async () => {
        const programmingResults = await store.searchAdvanced(["docs"], {
          query: "programming",
          filter: { category: "programming" },
          limit: 5,
        });

        expect(programmingResults.length).toBeGreaterThan(0);
        expect(programmingResults.every(item => item.value.category === "programming")).toBe(true);
      });

      it("should handle search with pagination and scoring", async () => {
        const page1 = await store.searchAdvanced(["docs"], {
          query: "development",
          limit: 2,
          offset: 0,
        });

        const page2 = await store.searchAdvanced(["docs"], {
          query: "development",
          limit: 2,
          offset: 2,
        });

        expect(page1.length).toBeGreaterThan(0);
        expect(page1.length).toBeLessThanOrEqual(2);
        
        // Ensure no overlap in results
        const page1Keys = page1.map(item => item.key);
        const page2Keys = page2.map(item => item.key);
        const overlap = page1Keys.filter(key => page2Keys.includes(key));
        expect(overlap).toHaveLength(0);
      });
    });

    describe("Store Statistics", () => {
      it("should provide accurate store statistics", async () => {
        // Put some test data
        await store.put(["namespace1"], "key1", { data: "value1" });
        await store.put(["namespace1"], "key2", { data: "value2" });
        await store.put(["namespace2"], "key1", { data: "value3" });

        const stats = await store.getStats();

        expect(stats.totalItems).toBeGreaterThanOrEqual(3);
        expect(stats.namespaceCount).toBeGreaterThanOrEqual(2);
        expect(stats.expiredItems).toBeGreaterThanOrEqual(0);
        expect(stats.oldestItem).toBeInstanceOf(Date);
        expect(stats.newestItem).toBeInstanceOf(Date);
        if (stats.newestItem && stats.oldestItem) {
          expect(stats.newestItem.getTime()).toBeGreaterThanOrEqual(stats.oldestItem.getTime());
        }
      });

      it("should handle empty store statistics", async () => {
        // Create a fresh store for this test
        const emptyDbName = `lg_store_empty_${Date.now()}`;
        const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
        
        try {
          await pool.query(`CREATE DATABASE ${emptyDbName}`);
        } finally {
          await pool.end();
        }

        const emptyTestDbUrl = `${TEST_POSTGRES_URL!.split("/").slice(0, -1).join("/")}/${emptyDbName}`;
        const emptyStore = PostgresStore.fromConnectionString(emptyTestDbUrl);
        testStores.push(emptyStore);
        
        await emptyStore.setup();

        const stats = await emptyStore.getStats();
        expect(stats.totalItems).toBe(0);
        expect(stats.expiredItems).toBe(0);
        expect(stats.namespaceCount).toBe(0);
        expect(stats.oldestItem).toBeNull();
        expect(stats.newestItem).toBeNull();
      });
    });
  });

  describe("Vector Search Features", () => {
    // Helper function for vector search tests
    const createMockEmbedding = (dims: number) => {
      const mockFn = async (texts: string[]): Promise<number[][]> => {
        mockFn.calls.push(texts);
        return texts.map((text, index) => {
          const embedding = new Array(dims).fill(0);
          for (let i = 0; i < dims; i += 1) {
            embedding[i] = Math.sin((text.charCodeAt(i % text.length) + index) * 0.1);
          }
          return embedding;
        });
      };
      
      mockFn.calls = [] as string[][];
      mockFn.toHaveBeenCalled = () => mockFn.calls.length > 0;
      
      return mockFn;
    };

    describe("Vector Search Configuration", () => {
      it("should support vector search configuration", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping vector search test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(384);

        const vectorStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_vector",
          index: {
            dims: 384,
            embed: mockEmbedding,
            fields: ["content", "title"]
          }
        });

        await vectorStore.setup();
        testStores.push(vectorStore);

        try {
          // Put items with vector indexing
          await vectorStore.put(
            ["docs"], 
            "doc1", 
            { 
              title: "Machine Learning Basics", 
              content: "Introduction to neural networks and deep learning" 
            }
          );

          await vectorStore.put(
            ["docs"], 
            "doc2", 
            { 
              title: "Data Science Guide", 
              content: "Statistical analysis and data visualization techniques" 
            }
          );

          // Test vector search
          const results = await vectorStore.vectorSearch(
            ["docs"], 
            "artificial intelligence",
            { limit: 5 }
          );

          expect(results).toBeDefined();
          expect(Array.isArray(results)).toBe(true);
          expect(mockEmbedding.toHaveBeenCalled()).toBe(true);

          // Test hybrid search
          const hybridResults = await vectorStore.hybridSearch(
            ["docs"], 
            "machine learning",
            { vectorWeight: 0.7, limit: 5 }
          );

          expect(hybridResults).toBeDefined();
          expect(Array.isArray(hybridResults)).toBe(true);

        } finally {
          await vectorStore.stop();
        }
      });

      it("should handle vector search without pgvector extension", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          return;
        }

        const mockEmbedding = createMockEmbedding(128);

        // Create store with vector config but expect it to handle missing extension gracefully
        const vectorStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_no_vector",
          index: {
            dims: 128,
            embed: mockEmbedding
          }
        });

        // Setup should not fail even if pgvector is not available
        await expect(vectorStore.setup()).resolves.not.toThrow();
        testStores.push(vectorStore);

        await vectorStore.stop();
      });
    });

    describe("Distance Metrics", () => {
      it("should handle different distance metrics", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping distance metrics test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(128);

        const vectorStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_metrics",
          index: {
            dims: 128,
            embed: mockEmbedding
          }
        });

        await vectorStore.setup();
        testStores.push(vectorStore);

        try {
          await vectorStore.put(["test"], "item1", { text: "sample content for testing" });

          // Test different distance metrics
          const cosineResults = await vectorStore.vectorSearch(
            ["test"], 
            "query text",
            { distanceMetric: 'cosine' }
          );

          const l2Results = await vectorStore.vectorSearch(
            ["test"], 
            "query text",
            { distanceMetric: 'l2' }
          );

          const ipResults = await vectorStore.vectorSearch(
            ["test"], 
            "query text",
            { distanceMetric: 'inner_product' }
          );

          expect(cosineResults).toBeDefined();
          expect(l2Results).toBeDefined();
          expect(ipResults).toBeDefined();

          // All should return the same item but potentially different scores
          expect(cosineResults.length).toBeGreaterThanOrEqual(0);
          expect(l2Results.length).toBeGreaterThanOrEqual(0);
          expect(ipResults.length).toBeGreaterThanOrEqual(0);

        } finally {
          await vectorStore.stop();
        }
      });

      it("should respect similarity thresholds", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          return;
        }

        const mockEmbedding = createMockEmbedding(64);

        const vectorStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_threshold",
          index: {
            dims: 64,
            embed: mockEmbedding
          }
        });

        await vectorStore.setup();
        testStores.push(vectorStore);

        try {
          await vectorStore.put(["test"], "item1", { text: "very different content" });
          await vectorStore.put(["test"], "item2", { text: "similar query content" });

          // High threshold should return fewer results
          const highThresholdResults = await vectorStore.vectorSearch(
            ["test"], 
            "query content",
            { similarityThreshold: 0.9 }
          );

          // Low threshold should return more results
          const lowThresholdResults = await vectorStore.vectorSearch(
            ["test"], 
            "query content",
            { similarityThreshold: 0.1 }
          );

          expect(lowThresholdResults.length).toBeGreaterThanOrEqual(highThresholdResults.length);

        } finally {
          await vectorStore.stop();
        }
      });
    });

    describe("Text Extraction", () => {
      it("should extract text from JSON paths correctly", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping text extraction test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(128);
        const vectorStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_text_extraction",
          index: {
            dims: 128,
            embed: mockEmbedding,
            fields: ["title", "content.sections[*].text", "tags[*]", "metadata.author"]
          }
        });

        await vectorStore.setup();
        testStores.push(vectorStore);

        const testObj = {
          title: "Test Document",
          content: {
            sections: [
              { text: "Section 1 content" },
              { text: "Section 2 content" }
            ]
          },
          tags: ["ai", "ml", "nlp"],
          metadata: {
            author: "Test Author",
            version: 1
          }
        };

        // Test that vector indexing works with complex JSON paths
        await vectorStore.put(["test"], "doc1", testObj);
        
        // Verify the document was stored correctly
        const retrieved = await vectorStore.get(["test"], "doc1");
        expect(retrieved).toBeDefined();
        expect(retrieved?.value).toEqual(testObj);
        
        // Test that we can search and find the document (proves text extraction worked)
        const searchResults = await vectorStore.vectorSearch(["test"], "Test Document");
        expect(searchResults.length).toBeGreaterThan(0);
        expect(searchResults[0].key).toBe("doc1");
      });

      it("should handle edge cases in text extraction", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping edge case test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(128);
        const vectorStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_edge_cases",
          index: {
            dims: 128,
            embed: mockEmbedding,
            fields: ["field2", "nested.validField", "filledArray[*]"]
          }
        });

        await vectorStore.setup();
        testStores.push(vectorStore);

        // Test with null values and mixed arrays
        const objWithNulls = {
          field1: null,
          field2: "valid text content",
          nested: {
            nullField: null,
            validField: "nested value for search"
          },
          emptyArray: [],
          filledArray: ["item1", "item2"],
          mixedArray: ["string", 123, null, { nested: "object" }]
        };

        await vectorStore.put(["test"], "edge_case_doc", objWithNulls);

        // Verify document was stored
        const retrieved = await vectorStore.get(["test"], "edge_case_doc");
        expect(retrieved).toBeDefined();
        
        // Test search works (proves text extraction handled edge cases)
        const searchResults = await vectorStore.vectorSearch(["test"], "valid text content");
        expect(searchResults.length).toBeGreaterThan(0);
      });
    });

    describe("Hybrid Search", () => {
      it("should combine vector and text search effectively", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          return;
        }

        const mockEmbedding = createMockEmbedding(256);

        const vectorStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_hybrid",
          index: {
            dims: 256,
            embed: mockEmbedding,
            fields: ["content", "title"]
          }
        });

        await vectorStore.setup();
        testStores.push(vectorStore);

        try {
          // Add documents with varying relevance
          await vectorStore.put(["docs"], "doc1", {
            title: "Machine Learning Guide",
            content: "Comprehensive guide to machine learning algorithms and techniques"
          });

          await vectorStore.put(["docs"], "doc2", {
            title: "Data Science Handbook", 
            content: "Statistical methods and data analysis for scientists"
          });

          await vectorStore.put(["docs"], "doc3", {
            title: "AI Research Paper",
            content: "Latest research in artificial intelligence and neural networks"
          });

          // Test hybrid search with different weights
          const vectorHeavy = await vectorStore.hybridSearch(
            ["docs"],
            "machine learning algorithms",
            { vectorWeight: 0.9, limit: 10 }
          );

          const textHeavy = await vectorStore.hybridSearch(
            ["docs"],
            "machine learning algorithms", 
            { vectorWeight: 0.1, limit: 10 }
          );

          const balanced = await vectorStore.hybridSearch(
            ["docs"],
            "machine learning algorithms",
            { vectorWeight: 0.5, limit: 10 }
          );

          expect(vectorHeavy).toBeDefined();
          expect(textHeavy).toBeDefined();
          expect(balanced).toBeDefined();

          // All should return results
          expect(vectorHeavy.length).toBeGreaterThan(0);
          expect(textHeavy.length).toBeGreaterThan(0);
          expect(balanced.length).toBeGreaterThan(0);

          // Results should have scores
          expect(vectorHeavy.every(item => typeof item.score === 'number')).toBe(true);
          expect(textHeavy.every(item => typeof item.score === 'number')).toBe(true);
          expect(balanced.every(item => typeof item.score === 'number')).toBe(true);

        } finally {
          await vectorStore.stop();
        }
      });
    });

    describe("Error Handling", () => {
      it("should handle invalid embedding dimensions", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          return;
        }

        const mockEmbedding = async (texts: string[]): Promise<number[][]> => {
          // Return wrong dimensions
          return texts.map(() => [0.1, 0.2]); // 2 dimensions instead of expected
        };

        const store = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_invalid_embedding",
          index: {
            dims: 384,
            embed: mockEmbedding,
            fields: ["content"]
          }
        });

        await store.setup();
        testStores.push(store);

        await store.put(["test"], "doc1", {
          content: "This should fail due to dimension mismatch"
        });

        // This should work fine since we're not doing vector search
        const item = await store.get(["test"], "doc1");
        expect(item).toBeDefined();
      });

      it("should handle embedding generation failures gracefully", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping embedding failure test - no TEST_POSTGRES_URL provided");
          return;
        }

        const failingEmbedding = async (): Promise<number[][]> => {
          throw new Error("Embedding generation failed");
        };

        const vectorStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_embedding_error",
          index: {
            dims: 128,
            embed: failingEmbedding
          }
        });

        await vectorStore.setup();
        testStores.push(vectorStore);

        await expect(vectorStore.put(["test"], "item1", { text: "test content" }))
          .rejects.toThrow("Embedding generation failed");
      });
    });
  });

  describe("Search Method", () => {
    // Helper function for vector search tests
    const createMockEmbedding = (dims: number) => {
      const mockFn = async (texts: string[]): Promise<number[][]> => {
        mockFn.calls.push(texts);
        return texts.map((text, index) => {
          const embedding = new Array(dims).fill(0);
          for (let i = 0; i < dims; i += 1) {
            embedding[i] = Math.sin((text.charCodeAt(i % text.length) + index) * 0.1);
          }
          return embedding;
        });
      };
      
      mockFn.calls = [] as string[][];
      mockFn.toHaveBeenCalled = () => mockFn.calls.length > 0;
      
      return mockFn;
    };

    // Helper function to create test data
    const setupSearchTestData = async (store: PostgresStore) => {
      await store.put(["docs"], "doc1", {
        title: "JavaScript Guide",
        content: "Complete guide to JavaScript programming",
        category: "programming",
        difficulty: "beginner",
        tags: ["javascript", "web", "tutorial"]
      });

      await store.put(["docs"], "doc2", {
        title: "TypeScript Handbook",
        content: "Advanced TypeScript programming techniques",
        category: "programming", 
        difficulty: "intermediate",
        tags: ["typescript", "javascript", "types"]
      });

      await store.put(["docs"], "doc3", {
        title: "Python Basics",
        content: "Introduction to Python programming language",
        category: "programming",
        difficulty: "beginner",
        tags: ["python", "basics"]
      });

      await store.put(["recipes"], "recipe1", {
        title: "Chocolate Cake",
        content: "Delicious chocolate cake recipe with detailed instructions",
        category: "dessert",
        difficulty: "easy",
        tags: ["chocolate", "cake", "baking"]
      });
    };

    describe("Basic Search Functionality", () => {
      beforeEach(async () => {
        await setupSearchTestData(store);
      });

      it("should perform basic search with no options", async () => {
        const results = await store.search(["docs"]);
        
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);
        expect(results.every(item => item.namespace[0] === "docs")).toBe(true);
      });

      it("should search with simple filter", async () => {
        const results = await store.search(["docs"], {
          filter: { category: "programming" }
        });

        expect(results.length).toBe(3);
        expect(results.every(item => item.value.category === "programming")).toBe(true);
      });

      it("should search with advanced filter operators", async () => {
        const results = await store.search(["docs"], {
          filter: { 
            difficulty: { $eq: "beginner" }
          }
        });

        expect(results.length).toBe(2);
        expect(results.every(item => item.value.difficulty === "beginner")).toBe(true);
      });

      it("should search with multiple filter conditions", async () => {
        const results = await store.search(["docs"], {
          filter: {
            category: "programming",
            difficulty: { $ne: "advanced" }
          }
        });

        expect(results.length).toBeGreaterThan(0);
        expect(results.every(item => 
          item.value.category === "programming" && 
          item.value.difficulty !== "advanced"
        )).toBe(true);
      });

      it("should search with $in operator", async () => {
        const results = await store.search(["docs"], {
          filter: {
            difficulty: { $in: ["beginner", "intermediate"] }
          }
        });

        expect(results.length).toBe(3);
        expect(results.every(item => 
          ["beginner", "intermediate"].includes((item.value as unknown as DocumentItem).difficulty)
        )).toBe(true);
      });

      it("should apply limit and offset", async () => {
        const page1 = await store.search(["docs"], {
          limit: 2,
          offset: 0
        });

        const page2 = await store.search(["docs"], {
          limit: 2,
          offset: 2
        });

        expect(page1.length).toBeLessThanOrEqual(2);
        expect(page2.length).toBeGreaterThanOrEqual(0);

        // Ensure no overlap
        const page1Keys = page1.map(item => item.key);
        const page2Keys = page2.map(item => item.key);
        const overlap = page1Keys.filter(key => page2Keys.includes(key));
        expect(overlap).toHaveLength(0);
      });

      it("should search across different namespaces", async () => {
        const docsResults = await store.search(["docs"]);
        const recipesResults = await store.search(["recipes"]);

        expect(docsResults.length).toBe(3);
        expect(recipesResults.length).toBe(1);
        expect(docsResults.every(item => item.namespace[0] === "docs")).toBe(true);
        expect(recipesResults.every(item => item.namespace[0] === "recipes")).toBe(true);
      });

      it("should return empty array for non-existent namespace", async () => {
        const results = await store.search(["nonexistent"]);
        expect(results).toEqual([]);
      });
    });

    describe("Text Search Functionality", () => {
      beforeEach(async () => {
        await setupSearchTestData(store);
      });

      it("should perform text search with query", async () => {
        const results = await store.search(["docs"], {
          query: "JavaScript programming"
        });

        expect(results.length).toBeGreaterThan(0);
        // Should find documents containing JavaScript
        const hasJavaScript = results.some(item => 
          item.value.title.includes("JavaScript") || 
          item.value.content.includes("JavaScript")
        );
        expect(hasJavaScript).toBe(true);
      });

      it("should combine text search with filters", async () => {
        const results = await store.search(["docs"], {
          query: "programming",
          filter: { difficulty: "beginner" }
        });

        expect(results.length).toBeGreaterThan(0);
        expect(results.every(item => item.value.difficulty === "beginner")).toBe(true);
      });

      it("should return results with scores when query is provided", async () => {
        const results = await store.search(["docs"], {
          query: "TypeScript"
        });

        expect(results.length).toBeGreaterThan(0);
        // Some results should have scores
        const resultsWithScores = results.filter(item => 
          item.score !== undefined && item.score !== null
        );
        expect(resultsWithScores.length).toBeGreaterThan(0);
      });
    });

    describe("Vector Search Integration", () => {
      it("should delegate to vectorSearch when index config and query are present", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping vector search delegation test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(384);
        const vectorStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_search_vector",
          index: {
            dims: 384,
            embed: mockEmbedding,
            fields: ["content", "title"]
          }
        });

        await vectorStore.setup();
        testStores.push(vectorStore);

        await setupSearchTestData(vectorStore);

        // Spy on vectorSearch method
        const vectorSearchSpy = jest.spyOn(vectorStore, 'vectorSearch');
        const searchAdvancedSpy = jest.spyOn(vectorStore, 'searchAdvanced');

        // Call search with query - should delegate to vectorSearch
        const results = await vectorStore.search(["docs"], {
          query: "JavaScript programming",
          filter: { category: "programming" },
          limit: 5
        });

        expect(vectorSearchSpy).toHaveBeenCalledWith(["docs"], "JavaScript programming", {
          filter: { category: "programming" },
          limit: 5,
          offset: undefined
        });
        expect(searchAdvancedSpy).not.toHaveBeenCalled();
        expect(results).toBeDefined();
        expect(Array.isArray(results)).toBe(true);

        vectorSearchSpy.mockRestore();
        searchAdvancedSpy.mockRestore();
      });

      it("should pass through vector search options correctly", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping vector search options test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(256);
        const vectorStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_search_options",
          index: {
            dims: 256,
            embed: mockEmbedding,
            fields: ["content"]
          }
        });

        await vectorStore.setup();
        testStores.push(vectorStore);

        await setupSearchTestData(vectorStore);

        const vectorSearchSpy = jest.spyOn(vectorStore, 'vectorSearch');

        await vectorStore.search(["docs"], {
          query: "programming guide",
          filter: { difficulty: { $ne: "advanced" } },
          limit: 3,
          offset: 1
        });

        expect(vectorSearchSpy).toHaveBeenCalledWith(["docs"], "programming guide", {
          filter: { difficulty: { $ne: "advanced" } },
          limit: 3,
          offset: 1
        });

        vectorSearchSpy.mockRestore();
      });
    });

    describe("SearchAdvanced Fallback", () => {
      beforeEach(async () => {
        await setupSearchTestData(store);
      });

      it("should delegate to searchAdvanced when no vector config", async () => {
        const searchAdvancedSpy = jest.spyOn(store, 'searchAdvanced');

        const results = await store.search(["docs"], {
          query: "programming",
          filter: { category: "programming" }
        });

        expect(searchAdvancedSpy).toHaveBeenCalledWith(["docs"], {
          query: "programming",
          filter: { category: "programming" }
        });
        expect(results).toBeDefined();
        expect(Array.isArray(results)).toBe(true);

        searchAdvancedSpy.mockRestore();
      });

      it("should delegate to searchAdvanced when no query provided", async () => {
        const searchAdvancedSpy = jest.spyOn(store, 'searchAdvanced');

        const results = await store.search(["docs"], {
          filter: { difficulty: "beginner" },
          limit: 5
        });

        expect(searchAdvancedSpy).toHaveBeenCalledWith(["docs"], {
          filter: { difficulty: "beginner" },
          limit: 5
        });
        expect(results).toBeDefined();

        searchAdvancedSpy.mockRestore();
      });

      it("should pass all options to searchAdvanced", async () => {
        const searchAdvancedSpy = jest.spyOn(store, 'searchAdvanced');

        const searchOptions = {
          filter: { category: "programming" },
          query: "TypeScript",
          limit: 10,
          offset: 2,
          refreshTtl: true
        };

        await store.search(["docs"], searchOptions);

        expect(searchAdvancedSpy).toHaveBeenCalledWith(["docs"], searchOptions);

        searchAdvancedSpy.mockRestore();
      });
    });

    describe("Edge Cases and Error Handling", () => {
      it("should handle empty search options", async () => {
        const results = await store.search(["docs"], {});
        expect(Array.isArray(results)).toBe(true);
      });

      it("should handle undefined search options", async () => {
        const results = await store.search(["docs"]);
        expect(Array.isArray(results)).toBe(true);
      });

      it("should validate namespace format in search", async () => {
        await expect(store.search([])).rejects.toThrow("Namespace cannot be empty");
        
        await expect(store.search(["invalid.namespace"]))
          .rejects.toThrow("Namespace labels cannot contain periods");
      });

      it("should handle search with complex nested filters", async () => {
        await setupSearchTestData(store);

        const results = await store.search(["docs"], {
          filter: {
            category: "programming",
            difficulty: { $in: ["beginner", "intermediate"] },
            title: { $ne: "Advanced Guide" }
          }
        });

        expect(Array.isArray(results)).toBe(true);
        expect(results.every(item => 
          item.value.category === "programming" &&
          ["beginner", "intermediate"].includes((item.value as unknown as DocumentItem).difficulty) &&
          item.value.title !== "Advanced Guide"
        )).toBe(true);
      });

      it("should handle search with zero limit", async () => {
        const results = await store.search(["docs"], { limit: 0 });
        expect(results).toEqual([]);
      });

      it("should handle search with large offset", async () => {
        const results = await store.search(["docs"], { 
          limit: 10, 
          offset: 1000 
        });
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBe(0);
      });
    });

    describe("Performance and Consistency", () => {
      beforeEach(async () => {
        await setupSearchTestData(store);
      });

      it("should return consistent results for identical queries", async () => {
        const searchOptions = {
          filter: { category: "programming" },
          limit: 10
        };

        const results1 = await store.search(["docs"], searchOptions);
        const results2 = await store.search(["docs"], searchOptions);

        expect(results1.length).toBe(results2.length);
        expect(results1.map(r => r.key).sort()).toEqual(
          results2.map(r => r.key).sort()
        );
      });

      it("should handle concurrent search requests", async () => {
        const searchPromises = Array.from({ length: 5 }, (_, i) => 
          store.search(["docs"], {
            filter: { category: "programming" },
            limit: 2,
            offset: i
          })
        );

        const results = await Promise.all(searchPromises);
        
        expect(results).toHaveLength(5);
        expect(results.every(result => Array.isArray(result))).toBe(true);
      });

      it("should maintain search result ordering", async () => {
        const results = await store.search(["docs"], {
          query: "programming guide",
          limit: 10
        });

        if (results.length > 1) {
          // Results should be ordered by relevance/score or creation time
          expect(results.every((item, index) => {
            if (index === 0) return true;
            const prev = results[index - 1];
            // Either both have scores or neither do
            if (item.score !== undefined && prev.score !== undefined) {
              return prev.score >= item.score;
            }
            return true;
          })).toBe(true);
        }
      });
    });
  });
}); 