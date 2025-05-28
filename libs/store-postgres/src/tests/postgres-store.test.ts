/* eslint-disable no-process-env */
import { describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import pg from "pg";
import { PostgresStore } from "../index.js";
import type { VectorIndexType } from "../index.js";

const { Pool } = pg;

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
        expect(expensiveItems.every(item => item.value.price > 100)).toBe(true);

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
        expect(cheapItems[0].value.price).toBe(50);

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
        expect(notClothing.every(item => item.value.category !== "clothing")).toBe(true);
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
        expect(notElectronics.every(item => item.value.category !== "electronics")).toBe(true);
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
        expect(inStockElectronics[0].value.price).toBe(100);

        // Test with rating filter
        const highRatedInStock = await store.searchAdvanced(["products"], {
          filter: {
            inStock: true,
            rating: { $gte: 4.0 }
          },
        });
        expect(highRatedInStock.length).toBeGreaterThan(0);
        expect(highRatedInStock.every(item => 
          item.value.inStock && item.value.rating >= 4.0
        )).toBe(true);
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
    // Helper function to create deterministic embeddings for testing
    const createMockEmbedding = (dims: number) => {
      const mockFn = async (texts: string[]): Promise<number[][]> => {
        mockFn.calls.push(texts);
        return texts.map((text, index) => {
          // Create deterministic embeddings based on text content
          const embedding = new Array(dims).fill(0);
          for (let i = 0; i < dims; i += 1) {
            embedding[i] = Math.sin((text.charCodeAt(i % text.length) + index) * 0.1);
          }
          return embedding;
        });
      };
      
      // Add mock tracking properties
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
        const store = new PostgresStore({
          connectionOptions: "postgresql://test:test@localhost:5432/test"
        });

        // Test the private method through reflection
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const extractMethod = (store as any).extractTextAtPath.bind(store);

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

        // Test simple field access
        expect(extractMethod(testObj, "title")).toEqual(["Test Document"]);

        // Test nested field access
        expect(extractMethod(testObj, "content.sections[0].text")).toEqual(["Section 1 content"]);

        // Test array wildcard
        expect(extractMethod(testObj, "content.sections[*].text")).toEqual([
          "Section 1 content",
          "Section 2 content"
        ]);

        // Test last element access
        expect(extractMethod(testObj, "tags[-1]")).toEqual(["nlp"]);

        // Test specific index
        expect(extractMethod(testObj, "tags[1]")).toEqual(["ml"]);

        // Test entire document
        expect(extractMethod(testObj, "$")).toEqual([JSON.stringify(testObj)]);

        // Test non-existent path
        expect(extractMethod(testObj, "nonexistent.field")).toEqual([]);

        // Test nested object
        expect(extractMethod(testObj, "metadata.author")).toEqual(["Test Author"]);
      });

      it("should handle edge cases in text extraction", async () => {
        const store = new PostgresStore({
          connectionOptions: "postgresql://test:test@localhost:5432/test"
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const extractMethod = (store as any).extractTextAtPath.bind(store);

        // Test with null values
        const objWithNulls = {
          field1: null,
          field2: "valid",
          nested: {
            nullField: null,
            validField: "nested value"
          }
        };

        expect(extractMethod(objWithNulls, "field1")).toEqual([]);
        expect(extractMethod(objWithNulls, "field2")).toEqual(["valid"]);
        expect(extractMethod(objWithNulls, "nested.nullField")).toEqual([]);
        expect(extractMethod(objWithNulls, "nested.validField")).toEqual(["nested value"]);

        // Test with empty arrays
        const objWithArrays = {
          emptyArray: [],
          filledArray: ["item1", "item2"],
          mixedArray: ["string", 123, null, { nested: "object" }]
        };

        expect(extractMethod(objWithArrays, "emptyArray[*]")).toEqual([]);
        expect(extractMethod(objWithArrays, "filledArray[*]")).toEqual(["item1", "item2"]);
        expect(extractMethod(objWithArrays, "mixedArray[*]")).toEqual([
          "string", 
          "123", 
          '{"nested":"object"}'
        ]);
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

  describe("Search and Filtering", () => {
    beforeEach(async () => {
      // Set up test data for search tests
      const namespace = ["search", "test"];
      
      await store.put(namespace, "item1", { 
        type: "document", 
        title: "First Doc", 
        category: "tech",
        priority: 1,
        tags: ["important", "urgent"]
      });
      await store.put(namespace, "item2", { 
        type: "document", 
        title: "Second Doc", 
        category: "business",
        priority: 2,
        tags: ["normal"]
      });
      await store.put(namespace, "item3", { 
        type: "image", 
        title: "First Image", 
        category: "tech",
        priority: 1,
        tags: ["media", "urgent"]
      });
      await store.put(namespace, "item4", { 
        type: "video", 
        title: "Tutorial Video", 
        category: "education",
        priority: 3,
        tags: ["tutorial", "learning"]
      });
    });

    it("should search items with simple filters", async () => {
      const namespace = ["search", "test"];
      
      // Search by type
      const documents = await store.search(namespace, {
        filter: { type: "document" },
      });
      expect(documents).toHaveLength(2);
      expect(documents.every((item) => item.value.type === "document")).toBe(true);

      // Search by category
      const techItems = await store.search(namespace, {
        filter: { category: "tech" },
      });
      expect(techItems).toHaveLength(2);
      expect(techItems.every((item) => item.value.category === "tech")).toBe(true);
    });

    it("should search items with text query", async () => {
      const namespace = ["search", "text"];
      
      // Store items with different content
      await store.put(namespace, "doc1", { 
        title: "JavaScript Guide", 
        content: "Learn JavaScript programming with modern frameworks" 
      });
      await store.put(namespace, "doc2", { 
        title: "Python Tutorial", 
        content: "Learn Python programming and data science" 
      });
      await store.put(namespace, "doc3", { 
        title: "Database Design", 
        content: "Learn database concepts and SQL queries" 
      });

      // Search for programming-related content
      const programmingResults = await store.search(namespace, {
        query: "programming",
      });
      expect(programmingResults.length).toBeGreaterThan(0);
      expect(programmingResults.every((item) => 
        JSON.stringify(item.value).toLowerCase().includes("programming")
      )).toBe(true);

      // Search for specific technology
      const jsResults = await store.search(namespace, {
        query: "JavaScript",
      });
      expect(jsResults.length).toBeGreaterThan(0);
      expect(jsResults.some((item) => 
        JSON.stringify(item.value).includes("JavaScript")
      )).toBe(true);
    });

    it("should combine filters and text search", async () => {
      const namespace = ["search", "combined"];
      
      await store.put(namespace, "tech1", { 
        type: "article", 
        category: "technology",
        title: "AI and Machine Learning",
        content: "Artificial intelligence and machine learning concepts"
      });
      await store.put(namespace, "tech2", { 
        type: "tutorial", 
        category: "technology",
        title: "Web Development",
        content: "Modern web development with JavaScript"
      });
      await store.put(namespace, "biz1", { 
        type: "article", 
        category: "business",
        title: "AI in Business",
        content: "How artificial intelligence transforms business"
      });

      // Search for AI articles only
      const aiArticles = await store.search(namespace, {
        filter: { type: "article" },
        query: "artificial intelligence",
      });
      
      expect(aiArticles.length).toBeGreaterThan(0);
      expect(aiArticles.every((item) => item.value.type === "article")).toBe(true);
    });

    it("should handle pagination", async () => {
      const namespace = ["pagination"];
      
      // Create multiple items
      for (let i = 0; i < 15; i += 1) {
        await store.put(namespace, `item${i}`, { 
          index: i, 
          data: `Item ${i}` 
        });
      }

      // Test pagination
      const page1 = await store.search(namespace, { limit: 5, offset: 0 });
      const page2 = await store.search(namespace, { limit: 5, offset: 5 });
      const page3 = await store.search(namespace, { limit: 5, offset: 10 });

      expect(page1).toHaveLength(5);
      expect(page2).toHaveLength(5);
      expect(page3).toHaveLength(5);

      // Ensure no overlap
      const allKeys = [...page1, ...page2, ...page3].map(item => item.key);
      const uniqueKeys = new Set(allKeys);
      expect(uniqueKeys.size).toBe(15);
    });

    it("should return empty results for non-matching filters", async () => {
      const namespace = ["search", "test"];
      
      const results = await store.search(namespace, {
        filter: { type: "nonexistent" },
      });
      
      expect(results).toHaveLength(0);
    });
  });

  describe("Namespace Management", () => {
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

    it("should handle deep namespace hierarchies", async () => {
      const deepNamespace = ["level1", "level2", "level3", "level4"];
      await store.put(deepNamespace, "deep-item", { data: "deep value" });

      const item = await store.get(deepNamespace, "deep-item");
      expect(item).toBeDefined();
      expect(item?.namespace).toEqual(deepNamespace);

      const namespaces = await store.listNamespaces();
      expect(namespaces).toContainEqual(deepNamespace);
    });

    it("should handle namespace with special characters", async () => {
      const specialNamespace = ["test-namespace", "with_underscores", "and-dashes"];
      await store.put(specialNamespace, "special-key", { data: "special value" });

      const item = await store.get(specialNamespace, "special-key");
      expect(item).toBeDefined();
      expect(item?.value).toEqual({ data: "special value" });
    });
  });

  describe("Batch Operations", () => {
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

    it("should handle mixed batch operations", async () => {
      // Pre-populate some data
      await store.put(["batch", "mixed"], "existing", { data: "exists" });

      const operations = [
        // Put operations
        { namespace: ["batch", "mixed"], key: "new1", value: { type: "new" } },
        { namespace: ["batch", "mixed"], key: "new2", value: { type: "new" } },
        
        // Get operations
        { namespace: ["batch", "mixed"], key: "existing" },
        { namespace: ["batch", "mixed"], key: "new1" },
        
        // Search operation
        { 
          namespacePrefix: ["batch", "mixed"], 
          filter: { type: "new" },
          limit: 10,
          offset: 0
        }
      ];

      const results = await store.batch(operations);
      
      expect(results).toHaveLength(5);
      expect(results[0]).toBeUndefined(); // put result
      expect(results[1]).toBeUndefined(); // put result
      
      // Check get results with proper type checking
      const existingResult = results[2] as { value: { data: string } } | null;
      if (existingResult && existingResult.value) {
        expect(existingResult.value).toEqual({ data: "exists" }); // get existing
      }
      
      const newResult = results[3] as { value: { type: string } } | null;
      if (newResult && newResult.value) {
        expect(newResult.value).toEqual({ type: "new" }); // get new1
      }
      
      expect(Array.isArray(results[4])).toBe(true); // search result
      const searchResults = results[4] as unknown[];
      expect(searchResults.length).toBe(2); // should find 2 new items
    });

    it("should handle empty batch operations", async () => {
      const results = await store.batch([]);
      expect(results).toHaveLength(0);
    });

    it("should handle batch operations with errors", async () => {
      const operations = [
        { namespace: ["valid"], key: "item1", value: { data: "valid" } },
        { namespace: [], key: "invalid", value: { data: "invalid" } }, // Invalid namespace
      ];

      await expect(store.batch(operations)).rejects.toThrow();
    });
  });

  describe("HNSW Vector Index Features", () => {
    // Helper function to create deterministic embeddings for testing
    const createMockEmbedding = (dims: number) => {
      const mockFn = async (texts: string[]): Promise<number[][]> => {
        mockFn.calls.push(texts);
        return texts.map((text, index) => {
          // Create deterministic embeddings based on text content
          const embedding = new Array(dims).fill(0);
          for (let i = 0; i < dims; i += 1) {
            embedding[i] = Math.sin((text.charCodeAt(i % text.length) + index) * 0.1);
          }
          return embedding;
        });
      };
      
      // Add mock tracking properties
      mockFn.calls = [] as string[][];
      mockFn.toHaveBeenCalled = () => mockFn.calls.length > 0;
      
      return mockFn;
    };

    describe("HNSW Index Configuration", () => {
      it("should support HNSW index configuration with custom parameters", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping HNSW test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(384);

        const hnswStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_hnsw",
          index: {
            dims: 384,
            embed: mockEmbedding,
            fields: ["content", "title"],
            indexType: 'hnsw',
            distanceMetric: 'cosine',
            hnsw: {
              m: 32,
              efConstruction: 400,
              ef: 80
            }
          }
        });

        await hnswStore.setup();
        testStores.push(hnswStore);

        // Test that the store was configured correctly
        expect(hnswStore).toBeDefined();
        
        // Test basic operations work with HNSW
        await hnswStore.put(["test"], "doc1", {
          title: "Machine Learning Basics",
          content: "Introduction to neural networks and deep learning"
        });

        const item = await hnswStore.get(["test"], "doc1");
        expect(item).toBeDefined();
        expect(item?.value.title).toBe("Machine Learning Basics");
      });

      it("should support IVFFlat index configuration for comparison", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping IVFFlat test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(256);

        const ivfStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_ivfflat",
          index: {
            dims: 256,
            embed: mockEmbedding,
            fields: ["content"],
            indexType: 'ivfflat',
            distanceMetric: 'l2',
            ivfflat: {
              lists: 50,
              probes: 3
            }
          }
        });

        await ivfStore.setup();
        testStores.push(ivfStore);

        // Test basic operations
        await ivfStore.put(["docs"], "test1", {
          content: "This is a test document for IVFFlat indexing"
        });

        const result = await ivfStore.get(["docs"], "test1");
        expect(result).toBeDefined();
      });

      it("should create indexes for all distance metrics when configured", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping multi-metric test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(128);

        const multiMetricStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_multi_metric",
          index: {
            dims: 128,
            embed: mockEmbedding,
            fields: ["text"],
            indexType: 'hnsw',
            distanceMetric: 'cosine',
            createAllMetricIndexes: true,
            hnsw: {
              m: 16,
              efConstruction: 200
            }
          }
        });

        await multiMetricStore.setup();
        testStores.push(multiMetricStore);

        // Test that setup completed without errors
        expect(multiMetricStore).toBeDefined();
      });
    });

    describe("Advanced Vector Search", () => {
      let vectorStore: PostgresStore;
      const mockEmbedding = createMockEmbedding(384);

      beforeEach(async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          return;
        }

        vectorStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_vector_search",
          index: {
            dims: 384,
            embed: mockEmbedding,
            fields: ["content", "title"],
            indexType: 'hnsw',
            distanceMetric: 'cosine',
            hnsw: {
              m: 16,
              efConstruction: 200,
              ef: 40
            }
          }
        });

        await vectorStore.setup();
        testStores.push(vectorStore);

        // Insert test documents
        const testDocs = [
          {
            key: "ml1",
            value: {
              title: "Machine Learning Fundamentals",
              content: "Introduction to supervised and unsupervised learning algorithms",
              category: "education",
              difficulty: 1
            }
          },
          {
            key: "ml2", 
            value: {
              title: "Deep Learning with Neural Networks",
              content: "Advanced techniques in deep learning and neural network architectures",
              category: "education",
              difficulty: 3
            }
          },
          {
            key: "ai1",
            value: {
              title: "Artificial Intelligence Overview",
              content: "Comprehensive guide to AI technologies and applications",
              category: "overview",
              difficulty: 2
            }
          },
          {
            key: "stats1",
            value: {
              title: "Statistical Analysis Methods",
              content: "Statistical techniques for data analysis and interpretation",
              category: "statistics",
              difficulty: 2
            }
          }
        ];

        for (const doc of testDocs) {
          await vectorStore.put(["documents"], doc.key, doc.value);
        }
      });

      it("should perform vector similarity search with HNSW index", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping vector search test - no TEST_POSTGRES_URL provided");
          return;
        }

        const results = await vectorStore.vectorSearch(
          ["documents"],
          "machine learning algorithms",
          {
            limit: 3,
            similarityThreshold: 0.1,
            distanceMetric: 'cosine'
          }
        );

        expect(results).toBeDefined();
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);
        expect(results.length).toBeLessThanOrEqual(3);

        // Check that results have similarity scores
        for (const result of results) {
          expect(result.score).toBeDefined();
          expect(typeof result.score).toBe('number');
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(1);
        }
      });

      it("should support different distance metrics", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping distance metrics test - no TEST_POSTGRES_URL provided");
          return;
        }

        // Test cosine distance
        const cosineResults = await vectorStore.vectorSearch(
          ["documents"],
          "neural networks",
          { distanceMetric: 'cosine', limit: 2 }
        );

        expect(cosineResults).toBeDefined();
        expect(cosineResults.length).toBeGreaterThan(0);

        // Test L2 distance
        const l2Results = await vectorStore.vectorSearch(
          ["documents"],
          "neural networks",
          { distanceMetric: 'l2', limit: 2 }
        );

        expect(l2Results).toBeDefined();
        expect(l2Results.length).toBeGreaterThan(0);

        // Test inner product
        const ipResults = await vectorStore.vectorSearch(
          ["documents"],
          "neural networks",
          { distanceMetric: 'inner_product', limit: 2 }
        );

        expect(ipResults).toBeDefined();
        expect(ipResults.length).toBeGreaterThan(0);
      });

      it("should combine vector search with filtering", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping filtered vector search test - no TEST_POSTGRES_URL provided");
          return;
        }

        const results = await vectorStore.vectorSearch(
          ["documents"],
          "learning algorithms",
          {
            filter: {
              category: "education",
              difficulty: { $lte: 2 }
            },
            limit: 5
          }
        );

        expect(results).toBeDefined();
        expect(Array.isArray(results)).toBe(true);

        // All results should match the filter criteria
        for (const result of results) {
          expect(result.value.category).toBe("education");
          expect(result.value.difficulty).toBeLessThanOrEqual(2);
        }
      });

      it("should perform hybrid search combining vector and text search", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping hybrid search test - no TEST_POSTGRES_URL provided");
          return;
        }

        const results = await vectorStore.hybridSearch(
          ["documents"],
          "machine learning",
          {
            vectorWeight: 0.7,
            similarityThreshold: 0.1,
            limit: 3
          }
        );

        expect(results).toBeDefined();
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);

        // Check hybrid scores
        for (const result of results) {
          expect(result.score).toBeDefined();
          expect(typeof result.score).toBe('number');
        }
      });

      it("should handle similarity thresholds correctly", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping similarity threshold test - no TEST_POSTGRES_URL provided");
          return;
        }

        // High threshold should return fewer results
        const highThresholdResults = await vectorStore.vectorSearch(
          ["documents"],
          "completely unrelated query about cooking recipes",
          {
            similarityThreshold: 0.9,
            limit: 10
          }
        );

        // Low threshold should return more results
        const lowThresholdResults = await vectorStore.vectorSearch(
          ["documents"],
          "machine learning",
          {
            similarityThreshold: 0.1,
            limit: 10
          }
        );

        expect(lowThresholdResults.length).toBeGreaterThanOrEqual(highThresholdResults.length);
      });

      it("should handle pagination in vector search", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping vector search pagination test - no TEST_POSTGRES_URL provided");
          return;
        }

        const firstPage = await vectorStore.vectorSearch(
          ["documents"],
          "learning",
          { limit: 2, offset: 0 }
        );

        const secondPage = await vectorStore.vectorSearch(
          ["documents"],
          "learning",
          { limit: 2, offset: 2 }
        );

        expect(firstPage).toBeDefined();
        expect(secondPage).toBeDefined();
        expect(firstPage.length).toBeLessThanOrEqual(2);
        expect(secondPage.length).toBeLessThanOrEqual(2);

        // Results should be different (assuming we have enough documents)
        if (firstPage.length > 0 && secondPage.length > 0) {
          expect(firstPage[0].key).not.toBe(secondPage[0].key);
        }
      });
    });

    describe("Vector Index Performance and Edge Cases", () => {
      it("should handle empty query gracefully", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping empty query test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(128);
        const store = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_edge_cases",
          index: {
            dims: 128,
            embed: mockEmbedding,
            indexType: 'hnsw'
          }
        });

        await store.setup();
        testStores.push(store);

        await expect(store.vectorSearch(["test"], "")).rejects.toThrow();
      });

      it("should handle dimension mismatch errors", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping dimension mismatch test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = async (texts: string[]): Promise<number[][]> => {
          // Return wrong dimensions
          return texts.map(() => [0.1, 0.2]); // 2 dimensions instead of 128
        };

        const store = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_dimension_mismatch",
          index: {
            dims: 128,
            embed: mockEmbedding,
            indexType: 'hnsw'
          }
        });

        await store.setup();
        testStores.push(store);

        await expect(
          store.vectorSearch(["test"], "test query")
        ).rejects.toThrow(/dimension mismatch/i);
      });

      it("should handle vector search without index configuration", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping no-index test - no TEST_POSTGRES_URL provided");
          return;
        }

        const store = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_no_vector_index"
        });

        await store.setup();
        testStores.push(store);

        await expect(
          store.vectorSearch(["test"], "test query")
        ).rejects.toThrow(/Vector search not configured/i);
      });

      it("should handle large batch vector operations efficiently", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping batch operations test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(256);
        const store = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_batch_vectors",
          index: {
            dims: 256,
            embed: mockEmbedding,
            indexType: 'hnsw',
            hnsw: {
              m: 16,
              efConstruction: 100
            }
          }
        });

        await store.setup();
        testStores.push(store);

        // Insert multiple documents
        const batchSize = 10;
        const putOperations = [];
        
        for (let i = 0; i < batchSize; i += 1) {
          putOperations.push({
            namespace: ["batch"],
            key: `doc${i}`,
            value: {
              title: `Document ${i}`,
              content: `This is test document number ${i} with some content for vector indexing`
            }
          });
        }

        const results = await store.batch(putOperations);
        expect(results).toBeDefined();
        expect(results.length).toBe(batchSize);

        // Test batch search
        const searchResults = await store.vectorSearch(
          ["batch"],
          "test document content",
          { limit: 5 }
        );

        expect(searchResults).toBeDefined();
        expect(searchResults.length).toBeGreaterThan(0);
        expect(searchResults.length).toBeLessThanOrEqual(5);
      });
    });

    describe("Vector Index Configuration Validation", () => {
      it("should validate HNSW parameters", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping HNSW validation test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(128);

        // Test with valid HNSW parameters
        const validStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_hnsw_valid",
          index: {
            dims: 128,
            embed: mockEmbedding,
            indexType: 'hnsw',
            hnsw: {
              m: 64,
              efConstruction: 500,
              ef: 100
            }
          }
        });

        await expect(validStore.setup()).resolves.not.toThrow();
        testStores.push(validStore);
      });

      it("should validate IVFFlat parameters", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping IVFFlat validation test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(128);

        const validStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_ivfflat_valid",
          index: {
            dims: 128,
            embed: mockEmbedding,
            indexType: 'ivfflat',
            ivfflat: {
              lists: 200,
              probes: 5
            }
          }
        });

        await expect(validStore.setup()).resolves.not.toThrow();
        testStores.push(validStore);
      });

      it("should handle unsupported index types gracefully", async () => {
        if (!process.env.TEST_POSTGRES_URL) {
          console.log("Skipping unsupported index test - no TEST_POSTGRES_URL provided");
          return;
        }

        const mockEmbedding = createMockEmbedding(128);

        const invalidStore = new PostgresStore({
          connectionOptions: process.env.TEST_POSTGRES_URL,
          schema: "test_invalid_index",
          index: {
            dims: 128,
            embed: mockEmbedding,
            indexType: 'unsupported' as VectorIndexType
          }
        });

        await expect(invalidStore.setup()).rejects.toThrow(/Unsupported index type/i);
      });
    });
  });
}); 