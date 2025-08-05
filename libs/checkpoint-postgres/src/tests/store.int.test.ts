/* eslint-disable no-process-env */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import pg from "pg";
import { PostgresStore } from "../store/index.js";

const { Pool } = pg;
const { TEST_POSTGRES_URL } = process.env;

if (!TEST_POSTGRES_URL) {
  throw new Error("TEST_POSTGRES_URL environment variable is required");
}

let testStores: PostgresStore[] = [];

afterAll(async () => {
  await Promise.all(testStores.map((s) => s.stop()));
  testStores = [];
  const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
  try {
    const result = await pool.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'crud_test_%'`
    );
    for (const row of result.rows) {
      await pool.query(`DROP DATABASE ${row.datname} WITH (FORCE)`);
    }
  } finally {
    await pool.end();
  }
}, 30_000);

describe("PostgresStore Batch Operations", () => {
  let store: PostgresStore;
  let dbName: string;
  let dbConnectionString: string;

  beforeEach(async () => {
    dbName = `batch_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await pool.end();
    }
    dbConnectionString = `${TEST_POSTGRES_URL.split("/")
      .slice(0, -1)
      .join("/")}/${dbName}`;
    store = PostgresStore.fromConnString(dbConnectionString);
    testStores.push(store);
    await store.setup();
  });

  it("should handle batch put and get operations", async () => {
    // Given
    const operations = [
      { namespace: ["batch"], key: "item1", value: { data: "first" } },
      { namespace: ["batch"], key: "item2", value: { data: "second" } },
      { namespace: ["batch"], key: "item1" }, // get operation
    ];

    // When
    const results = await store.batch(operations);

    // Then
    expect(results).toHaveLength(3);
    expect(results[0]).toBeUndefined(); // put result
    expect(results[1]).toBeUndefined(); // put result
    expect(results[2]).toBeDefined(); // get result
    const getResult = results[2];
    if (getResult && typeof getResult === "object" && "value" in getResult) {
      expect(getResult.value).toEqual({ data: "first" });
    }
  });

  it("should handle batch with mixed valid and invalid operations", async () => {
    // Given
    const operations = [
      { namespace: ["batch"], key: "item1", value: { data: "first" } },
      { namespace: [], key: "item2", value: { data: "invalid" } }, // invalid namespace
      { namespace: ["batch"], key: "item1" },
    ];

    // When/Then
    await expect(store.batch(operations)).rejects.toThrow(
      "Namespace cannot be empty"
    );
  });
});

// Helper for mock embedding
const createMockEmbedding = (dims: number, options: { asEmpty: boolean }) => {
  // Create fixed vectors that will ensure different search results
  const TITLE_VECTOR = new Array(dims).fill(0);
  TITLE_VECTOR[0] = 1.0; // Only first dimension is 1.0

  const CONTENT_VECTOR = new Array(dims).fill(0);
  CONTENT_VECTOR[dims - 1] = 1.0; // Only last dimension is 1.0

  // Empty vector will not match anything
  const EMPTY_VECTOR = new Array(dims).fill(0);

  const mockFn = async (texts: string[]): Promise<number[][]> => {
    mockFn.calls.push(texts);

    return texts.map((text, index) => {
      // Exact matching for testing purposes
      if (text === "Combined Options Test") {
        return [...TITLE_VECTOR]; // Clone to avoid mutation
      } else if (text === "Testing both TTL and indexing options") {
        return [...CONTENT_VECTOR]; // Clone to avoid mutation
      } else if (text === "combined options") {
        return [...TITLE_VECTOR]; // Clone to avoid mutation
      } else if (text === "testing both") {
        return [...CONTENT_VECTOR]; // Clone to avoid mutation
      } else if (options.asEmpty) {
        return [...EMPTY_VECTOR]; // Clone to avoid mutation
      } else {
        const embedding = new Array(dims).fill(0);
        for (let i = 0; i < dims; i += 1) {
          embedding[i] = Math.sin(
            (text.charCodeAt(i % text.length) + index) * 0.1
          );
        }
        return embedding;
      }
    });
  };

  mockFn.calls = [] as string[][];
  mockFn.toHaveBeenCalled = () => mockFn.calls.length > 0;
  return mockFn;
};

describe("PostgresStore CRUD Operations", () => {
  let store: PostgresStore;
  let storeWithVectors: PostgresStore;
  let dbName: string;
  let dbConnectionString: string;
  let mockEmbedding: ((texts: string[]) => Promise<number[][]>) & {
    calls: string[][];
    toHaveBeenCalled: () => boolean;
  };

  beforeEach(async () => {
    dbName = `crud_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await pool.end();
    }

    dbConnectionString = `${TEST_POSTGRES_URL.split("/")
      .slice(0, -1)
      .join("/")}/${dbName}`;

    // Regular store without vector indexing
    store = PostgresStore.fromConnString(dbConnectionString);
    testStores.push(store);
    await store.setup();

    // Store with vector indexing
    mockEmbedding = createMockEmbedding(128, { asEmpty: true });
    storeWithVectors = new PostgresStore({
      connectionOptions: dbConnectionString,
      schema: "test_vectors",
      index: {
        dims: 128,
        embed: mockEmbedding,
        fields: ["content", "title"],
      },
    });
    testStores.push(storeWithVectors);
    await storeWithVectors.setup();
  });

  it("should store and retrieve a simple item", async () => {
    // Given
    const namespace = ["crud", "simple"];
    const key = "item1";
    const value = { foo: "bar", num: 42 };

    // When
    await store.put(namespace, key, value);
    const item = await store.get(namespace, key);

    // Then
    expect(item).toBeDefined();
    expect(item?.namespace).toEqual(namespace);
    expect(item?.key).toBe(key);
    expect(item?.value).toEqual(value);
    expect(item?.createdAt).toBeInstanceOf(Date);
    expect(item?.updatedAt).toBeInstanceOf(Date);
  });

  it("should update an existing item", async () => {
    // Given
    const namespace = ["crud", "update"];
    const key = "item2";
    const originalValue = { foo: "bar" };
    const updatedValue = { foo: "baz", extra: 123 };
    await store.put(namespace, key, originalValue);
    const originalItem = await store.get(namespace, key);

    // When
    await store.put(namespace, key, updatedValue);
    const updatedItem = await store.get(namespace, key);

    // Then
    expect(originalItem?.value).toEqual(originalValue);
    expect(updatedItem?.value).toEqual(updatedValue);
    expect(updatedItem?.updatedAt.getTime()).toBeGreaterThan(
      originalItem?.updatedAt.getTime() || 0
    );
  });

  it("should delete an item", async () => {
    // Given
    const namespace = ["crud", "delete"];
    const key = "item3";
    const value = { toDelete: true };
    await store.put(namespace, key, value);
    let item = await store.get(namespace, key);
    expect(item).toBeDefined();

    // When
    await store.delete(namespace, key);
    item = await store.get(namespace, key);

    // Then
    expect(item).toBeNull();
  });

  it("should handle complex JSON values", async () => {
    // Given
    const namespace = ["crud", "complex"];
    const key = "item4";
    const complexValue = {
      string: "test",
      number: 42,
      boolean: true,
      null: null,
      array: [1, 2, 3, "four"],
      nested: {
        deep: {
          value: "nested data",
        },
      },
    };

    // When
    await store.put(namespace, key, complexValue);
    const retrieved = await store.get(namespace, key);

    // Then
    expect(retrieved?.value).toEqual(complexValue);
  });

  it("should return null for non-existent items", async () => {
    // Given
    const namespace = ["crud", "missing"];
    const key = "nope";

    // When
    const item = await store.get(namespace, key);

    // Then
    expect(item).toBeNull();
  });

  it("should not allow empty namespace", async () => {
    // Given
    const namespace: string[] = [];
    const key = "key";
    const value = { foo: "bar" };

    // When/Then
    await expect(store.put(namespace, key, value)).rejects.toThrow(
      "Namespace cannot be empty"
    );
  });

  it("should not allow namespace labels with periods", async () => {
    // Given
    const namespace = ["invalid.namespace"];
    const key = "key";
    const value = { foo: "bar" };

    // When/Then
    await expect(store.put(namespace, key, value)).rejects.toThrow(
      "Namespace labels cannot contain periods"
    );
  });

  it("should not allow empty namespace label", async () => {
    // Given
    const namespace = ["valid", ""];
    const key = "key";
    const value = { foo: "bar" };

    // When/Then
    await expect(store.put(namespace, key, value)).rejects.toThrow(
      "Namespace labels cannot be empty strings"
    );
  });

  it("should not allow non-string namespace label", async () => {
    // Given
    const namespace = ["valid", 123 as unknown as string];
    const key = "key";
    const value = { foo: "bar" };

    // When/Then
    await expect(store.put(namespace, key, value)).rejects.toThrow(
      "Namespace labels must be strings"
    );
  });

  it("should not allow reserved namespace label", async () => {
    // Given
    const namespace = ["langgraph"];
    const key = "key";
    const value = { foo: "bar" };

    // When/Then
    await expect(store.put(namespace, key, value)).rejects.toThrow(
      'Root label for namespace cannot be "langgraph"'
    );
  });

  it("should support TTL options", async () => {
    // Given
    const namespace = ["ttl", "custom"];
    const key = "tempItem";
    const value = { data: "temporary data" };

    // When
    await store.put(namespace, key, value, undefined, { ttl: 5 }); // 5 minutes TTL
    const item = await store.get(namespace, key);

    // Then
    expect(item).toBeDefined();
    expect(item?.value).toEqual(value);
  });

  it("should support index: false to disable vector indexing", async () => {
    // Given
    const mockCallsBefore = mockEmbedding.calls.length;
    const namespace = ["vectors", "no-index"];
    const key = "doc1";
    const value = {
      title: "Test Document",
      content: "This content should not be indexed",
    };

    // When
    await storeWithVectors.put(namespace, key, value, false); // Disable indexing

    // Then - embedding function should not be called
    expect(mockEmbedding.calls.length).toBe(mockCallsBefore);

    // When - search for this item
    const results = await storeWithVectors.search(namespace, {
      query: "test document",
      mode: "vector",
    });

    // Then - item should not be found via vector search
    expect(results.length).toBe(0);
  });

  it("should support specific fields to index", async () => {
    // Given
    const mockCallsBefore = mockEmbedding.calls.length;
    const namespace = ["vectors", "selective"];
    const key = "doc1";
    const value = {
      title: "Indexed Title",
      content: "Not indexed content",
      summary: "Indexed summary",
      metadata: {
        author: "Test Author",
      },
    };

    // When
    await storeWithVectors.put(
      namespace,
      key,
      value,
      ["title", "summary"] // Only index these fields
    );

    // Then - embedding function should be called
    expect(mockEmbedding.calls.length).toBe(mockCallsBefore + 1);

    // Check that only specified fields were used
    const embedCalls = mockEmbedding.calls[mockCallsBefore];
    expect(embedCalls).toContain("Indexed Title");
    expect(embedCalls).toContain("Indexed summary");
    expect(embedCalls).not.toContain("Not indexed content");

    // When - search for indexed content
    const results = await storeWithVectors.search(namespace, {
      query: "indexed summary",
      mode: "vector",
    });

    // Then - item should be found
    expect(results.length).toBeGreaterThan(0);
  });

  it("should support both TTL and indexing options", async () => {
    // Given
    const mockCallsBefore = mockEmbedding.calls.length;
    const namespace = ["vectors", "combined"];
    const key = "doc1";
    const value = {
      title: "Combined Options Test",
      content: "Testing both TTL and indexing options",
    };

    // When
    await storeWithVectors.put(
      namespace,
      key,
      value,
      ["title"], // Only index the title field
      { ttl: 10 } // 10 minutes TTL
    );

    // Then - item should be retrievable
    const item = await storeWithVectors.get(namespace, key);
    expect(item).toBeDefined();
    expect(item?.value).toEqual(value);

    // Check that only the title was indexed by examining mock embedding calls
    expect(mockEmbedding.calls.length).toBe(mockCallsBefore + 1);
    const indexingCall = mockEmbedding.calls[mockCallsBefore];

    // Verify only title was sent to embedding function
    expect(indexingCall).toContain("Combined Options Test"); // Title should be indexed
    expect(indexingCall).not.toContain("Testing both TTL and indexing options"); // Content should not be indexed

    // Query the database directly to check what's in the vector table
    const pool = new Pool({ connectionString: dbConnectionString });
    try {
      const vectorResult = await pool.query(
        `SELECT field_path, text_content FROM test_vectors.store_vectors 
         WHERE namespace_path = $1 AND key = $2`,
        [namespace.join(":"), key]
      );

      // Should only have indexed the title field
      expect(vectorResult.rows.length).toBe(1);
      expect(vectorResult.rows[0].field_path).toBe("title");
      expect(vectorResult.rows[0].text_content).toBe("Combined Options Test");
    } finally {
      await pool.end();
    }
  });
});

describe("PostgresStore Error Handling", () => {
  let store: PostgresStore;
  let dbName: string;
  let dbConnectionString: string;

  beforeEach(async () => {
    dbName = `err_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await pool.end();
    }
    dbConnectionString = `${TEST_POSTGRES_URL.split("/")
      .slice(0, -1)
      .join("/")}/${dbName}`;
    store = PostgresStore.fromConnString(dbConnectionString);
    testStores.push(store);
    await store.setup();
  });

  it("should handle database connection errors gracefully", async () => {
    // Given
    const invalidStore = new PostgresStore({
      connectionOptions: "postgresql://invalid:invalid@localhost:9999/invalid",
    });

    // When/Then
    await expect(invalidStore.setup()).rejects.toThrow();
  });

  it("should handle malformed connection strings", () => {
    // When/Then
    expect(
      () =>
        new PostgresStore({
          connectionOptions: "not-a-valid-connection-string",
        })
    ).not.toThrow(); // Constructor should not throw, but setup should fail
  });

  it("should throw error when using vector search mode without vector configuration", async () => {
    // When/Then
    await expect(
      store.search(["docs"], {
        query: "test query",
        mode: "vector",
      })
    ).rejects.toThrow(/Vector search requested but not configured/);
  });

  it("should throw error when using hybrid search mode without vector configuration", async () => {
    // When/Then
    await expect(
      store.search(["docs"], {
        query: "test query",
        mode: "hybrid",
      })
    ).rejects.toThrow(
      /Hybrid search requested but vector search not configured/
    );
  });

  it("should throw error when using vectorSearch directly without vector configuration", async () => {
    // When/Then
    await expect(
      store.search(["docs"], { mode: "vector", query: "test query" })
    ).rejects.toThrow(/Vector search requested but not configured/);
  });

  it("should throw error when using hybridSearch directly without vector configuration", async () => {
    // When/Then
    await expect(
      store.search(["docs"], {
        query: "test query",
        mode: "hybrid",
      })
    ).rejects.toThrow(
      /Hybrid search requested but vector search not configured/
    );
  });

  it("should handle unknown search mode", async () => {
    // When/Then
    await expect(
      // @ts-expect-error Testing invalid mode
      store.search(["docs"], { query: "test", mode: "invalid-mode" })
    ).rejects.toThrow(/Unknown search mode/);
  });
});

describe("PostgresStore Hybrid Search", () => {
  let store: PostgresStore;
  let dbName: string;
  let dbConnectionString: string;
  let mockEmbedding: ((texts: string[]) => Promise<number[][]>) & {
    calls: string[][];
    toHaveBeenCalled: () => boolean;
  };

  beforeEach(async () => {
    dbName = `hybrid_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await pool.end();
    }
    dbConnectionString = `${TEST_POSTGRES_URL.split("/")
      .slice(0, -1)
      .join("/")}/${dbName}`;
    mockEmbedding = createMockEmbedding(128, { asEmpty: false });
    store = new PostgresStore({
      connectionOptions: dbConnectionString,
      schema: "test_hybrid",
      index: {
        dims: 128,
        embed: mockEmbedding,
        fields: ["content", "title"],
      },
    });
    testStores.push(store);
    await store.setup();
    // Add documents
    await store.put(["docs"], "doc1", {
      title: "Machine Learning Guide",
      content:
        "Comprehensive guide to machine learning algorithms and techniques",
    });
    await store.put(["docs"], "doc2", {
      title: "Data Science Handbook",
      content: "Statistical methods and data analysis for scientists",
    });
    await store.put(["docs"], "doc3", {
      title: "AI Research Paper",
      content: "Latest research in artificial intelligence and neural networks",
    });
  });

  it("should combine vector and text search effectively", async () => {
    // When
    const vectorHeavy = await store.search(["docs"], {
      mode: "hybrid",
      query: "machine learning algorithms",
      vectorWeight: 0.9,
      limit: 10,
    });
    const textHeavy = await store.search(["docs"], {
      mode: "hybrid",
      query: "machine learning algorithms",
      vectorWeight: 0.1,
      limit: 10,
    });
    const balanced = await store.search(["docs"], {
      mode: "hybrid",
      query: "machine learning algorithms",
      vectorWeight: 0.5,
      limit: 10,
    });

    // Then
    expect(vectorHeavy).toBeDefined();
    expect(textHeavy).toBeDefined();
    expect(balanced).toBeDefined();
    expect(vectorHeavy.length).toBeGreaterThan(0);
    expect(textHeavy.length).toBeGreaterThan(0);
    expect(balanced.length).toBeGreaterThan(0);
    expect(vectorHeavy.every((item) => typeof item.score === "number")).toBe(
      true
    );
    expect(textHeavy.every((item) => typeof item.score === "number")).toBe(
      true
    );
    expect(balanced.every((item) => typeof item.score === "number")).toBe(true);
  });

  it("should maintain result ordering by score", async () => {
    // When
    const results = await store.search(["docs"], {
      mode: "hybrid",
      query: "machine learning algorithms",
      vectorWeight: 0.5,
      limit: 10,
    });

    // Then
    if (results.length > 1) {
      expect(
        results.every((item, index) => {
          if (index === 0) return true;
          const prev = results[index - 1];
          if (item.score !== undefined && prev.score !== undefined) {
            return prev.score >= item.score;
          }
          return true;
        })
      ).toBe(true);
    }
  });

  it("should support hybrid mode in unified search method", async () => {
    // When
    const results = await store.search(["docs"], {
      query: "machine learning algorithms",
      mode: "hybrid",
      vectorWeight: 0.7,
      limit: 10,
    });

    // Then
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((item) => typeof item.score === "number")).toBe(true);
    expect(mockEmbedding.toHaveBeenCalled()).toBe(true);
  });

  it("should pass appropriate parameters through to hybrid search", async () => {
    // When
    const vectorWeight = 0.65;
    const similarityThreshold = 0.25;

    const results = await store.search(["docs"], {
      query: "neural networks research",
      mode: "hybrid",
      vectorWeight,
      similarityThreshold,
      limit: 5,
    });

    // Then
    expect(results).toBeDefined();

    // Verify direct method works with same parameters
    const directResults = await store.search(["docs"], {
      mode: "hybrid",
      query: "neural networks research",
      vectorWeight,
      similarityThreshold,
      limit: 5,
    });

    // Both should have similar result structure
    expect(results.length).toBe(directResults.length);
    if (results.length > 0 && directResults.length > 0) {
      expect(typeof results[0].score).toBe(typeof directResults[0].score);
    }
  });
});

describe("PostgresStore Namespace Listing", () => {
  let store: PostgresStore;
  let dbName: string;
  let dbConnectionString: string;

  beforeEach(async () => {
    dbName = `ns_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await pool.end();
    }
    dbConnectionString = `${TEST_POSTGRES_URL.split("/")
      .slice(0, -1)
      .join("/")}/${dbName}`;
    store = PostgresStore.fromConnString(dbConnectionString);
    testStores.push(store);
    await store.setup();
  });

  it("should list all namespaces", async () => {
    // Given
    await store.put(["docs", "v1"], "item1", { data: "test" });
    await store.put(["docs", "v2"], "item2", { data: "test" });
    await store.put(["cache", "temp"], "item3", { data: "test" });

    // When
    const namespaces = await store.listNamespaces();

    // Then
    expect(namespaces.length).toBeGreaterThan(0);
    expect(namespaces).toContainEqual(["docs", "v1"]);
    expect(namespaces).toContainEqual(["docs", "v2"]);
    expect(namespaces).toContainEqual(["cache", "temp"]);
  });

  it("should list namespaces with prefix filter", async () => {
    // Given
    await store.put(["docs", "v1"], "item1", { data: "test" });
    await store.put(["docs", "v2"], "item2", { data: "test" });
    await store.put(["cache", "temp"], "item3", { data: "test" });

    // When
    const namespaces = await store.listNamespaces({ prefix: ["docs"] });

    // Then
    expect(namespaces.length).toBe(2);
    expect(namespaces).toContainEqual(["docs", "v1"]);
    expect(namespaces).toContainEqual(["docs", "v2"]);
    expect(namespaces).not.toContainEqual(["cache", "temp"]);
  });
});

describe("PostgresStore Search", () => {
  let store: PostgresStore;
  let dbName: string;
  let dbConnectionString: string;

  beforeEach(async () => {
    dbName = `search_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await pool.end();
    }
    dbConnectionString = `${TEST_POSTGRES_URL.split("/")
      .slice(0, -1)
      .join("/")}/${dbName}`;
    store = PostgresStore.fromConnString(dbConnectionString);
    testStores.push(store);
    await store.setup();

    // Setup test data
    await store.put(["docs"], "doc1", {
      title: "JavaScript Guide",
      content: "Complete guide to JavaScript programming",
      category: "programming",
      difficulty: "beginner",
      tags: ["javascript", "web", "tutorial"],
    });

    await store.put(["docs"], "doc2", {
      title: "TypeScript Handbook",
      content: "Advanced TypeScript programming techniques",
      category: "programming",
      difficulty: "intermediate",
      tags: ["typescript", "javascript", "types"],
    });

    await store.put(["docs"], "doc3", {
      title: "Python Basics",
      content: "Introduction to Python programming language",
      category: "programming",
      difficulty: "beginner",
      tags: ["python", "basics"],
    });

    await store.put(["recipes"], "recipe1", {
      title: "Chocolate Cake",
      content: "Delicious chocolate cake recipe with detailed instructions",
      category: "dessert",
      difficulty: "easy",
      tags: ["chocolate", "cake", "baking"],
    });
  });

  it("should perform basic search with no options", async () => {
    // When
    const results = await store.search(["docs"]);

    // Then
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((item) => item.namespace[0] === "docs")).toBe(true);
  });

  it("should search with simple filter", async () => {
    // When
    const results = await store.search(["docs"], {
      filter: { category: "programming" },
    });

    // Then
    expect(results.length).toBe(3);
    expect(results.every((item) => item.value.category === "programming")).toBe(
      true
    );
  });

  it("should search with advanced filter operators", async () => {
    // When
    const results = await store.search(["docs"], {
      filter: {
        difficulty: { $eq: "beginner" },
      },
    });

    // Then
    expect(results.length).toBe(2);
    expect(results.every((item) => item.value.difficulty === "beginner")).toBe(
      true
    );
  });

  it("should search with multiple filter conditions", async () => {
    // When
    const results = await store.search(["docs"], {
      filter: {
        category: "programming",
        difficulty: { $ne: "advanced" },
      },
    });

    // Then
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every(
        (item) =>
          item.value.category === "programming" &&
          item.value.difficulty !== "advanced"
      )
    ).toBe(true);
  });

  it("should search with $in operator", async () => {
    // When
    const results = await store.search(["docs"], {
      filter: {
        difficulty: { $in: ["beginner", "intermediate"] },
      },
    });

    // Then
    expect(results.length).toBe(3);
    expect(
      results.every((item) =>
        ["beginner", "intermediate"].includes(item.value.difficulty)
      )
    ).toBe(true);
  });

  it("should apply limit and offset", async () => {
    // When
    const page1 = await store.search(["docs"], {
      limit: 2,
      offset: 0,
    });

    const page2 = await store.search(["docs"], {
      limit: 2,
      offset: 2,
    });

    // Then
    expect(page1.length).toBeLessThanOrEqual(2);
    expect(page2.length).toBeGreaterThanOrEqual(0);

    // Ensure no overlap
    const page1Keys = page1.map((item) => item.key);
    const page2Keys = page2.map((item) => item.key);
    const overlap = page1Keys.filter((key) => page2Keys.includes(key));
    expect(overlap).toHaveLength(0);
  });

  it("should return empty array for non-existent namespace", async () => {
    // When
    const results = await store.search(["nonexistent"]);
    // Then
    expect(results).toEqual([]);
  });

  it("should support text search mode", async () => {
    // When
    const results = await store.search(["docs"], {
      query: "JavaScript",
      mode: "text",
    });

    // Then
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some(
        (item) =>
          item.value.title.includes("JavaScript") ||
          item.value.content.includes("JavaScript")
      )
    ).toBe(true);
  });

  it("should perform full-text search with auto mode defaulting to text", async () => {
    // When
    const results = await store.search(["docs"], {
      query: "programming",
      mode: "auto",
    });

    // Then
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some(
        (item) =>
          item.value.title.includes("programming") ||
          item.value.content.includes("programming") ||
          item.value.category === "programming"
      )
    ).toBe(true);
  });

  it("should combine filtering with text search", async () => {
    // When
    const results = await store.search(["docs"], {
      query: "guide",
      filter: { difficulty: "beginner" },
      mode: "text",
    });

    // Then
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((item) => item.value.difficulty === "beginner")).toBe(
      true
    );
    expect(
      results.some(
        (item) =>
          item.value.title.toLowerCase().includes("guide") ||
          item.value.content.toLowerCase().includes("guide")
      )
    ).toBe(true);
  });
});

describe("PostgresStore Statistics", () => {
  let store: PostgresStore;
  let dbName: string;
  let dbConnectionString: string;

  beforeEach(async () => {
    dbName = `stats_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await pool.end();
    }
    dbConnectionString = `${TEST_POSTGRES_URL.split("/")
      .slice(0, -1)
      .join("/")}/${dbName}`;
    store = PostgresStore.fromConnString(dbConnectionString);
    testStores.push(store);
    await store.setup();
  });

  it("should provide accurate store statistics", async () => {
    // Given
    await store.put(["namespace1"], "key1", { data: "value1" });
    await store.put(["namespace1"], "key2", { data: "value2" });
    await store.put(["namespace2"], "key1", { data: "value3" });

    // When
    const stats = await store.getStats();

    // Then
    expect(stats.totalItems).toBeGreaterThanOrEqual(3);
    expect(stats.namespaceCount).toBeGreaterThanOrEqual(2);
    expect(stats.expiredItems).toBeGreaterThanOrEqual(0);
    expect(stats.oldestItem).toBeInstanceOf(Date);
    expect(stats.newestItem).toBeInstanceOf(Date);
    if (stats.newestItem && stats.oldestItem) {
      expect(stats.newestItem.getTime()).toBeGreaterThanOrEqual(
        stats.oldestItem.getTime()
      );
    }
  });

  it("should handle empty store statistics", async () => {
    // When
    const stats = await store.getStats();

    // Then
    expect(stats.totalItems).toBe(0);
    expect(stats.expiredItems).toBe(0);
    expect(stats.namespaceCount).toBe(0);
    expect(stats.oldestItem).toBeNull();
    expect(stats.newestItem).toBeNull();
  });
});

describe("PostgresStore TTL", () => {
  let store: PostgresStore;
  let dbName: string;
  let dbConnectionString: string;

  beforeEach(async () => {
    dbName = `ttl_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await pool.end();
    }
    dbConnectionString = `${TEST_POSTGRES_URL.split("/")
      .slice(0, -1)
      .join("/")}/${dbName}`;
    store = new PostgresStore({
      connectionOptions: dbConnectionString,
      schema: "test_ttl",
      ttl: {
        defaultTtl: 1, // 1 minute
        refreshOnRead: true,
        sweepIntervalMinutes: 1,
      },
    });
    testStores.push(store);
    await store.setup();
  });

  it("should support TTL configuration and sweep", async () => {
    // Given
    await store.put(["test"], "ttl-item", { data: "expires" });

    // When
    const item = await store.get(["test"], "ttl-item");
    const sweptCount = await store.sweepExpiredItems();

    // Then
    expect(item).toBeTruthy();
    expect(item?.value).toEqual({ data: "expires" });
    expect(typeof sweptCount).toBe("number");
    expect(sweptCount).toBeGreaterThanOrEqual(0);
  });

  it("should refresh TTL on read", async () => {
    // Given
    await store.put(["test"], "refresh-item", { data: "refresh test" });

    // When
    const item1 = await store.get(["test"], "refresh-item");
    const item2 = await store.get(["test"], "refresh-item");

    // Then
    expect(item1).toBeTruthy();
    expect(item2).toBeTruthy();
    expect(item2?.value).toEqual({ data: "refresh test" });
  });
});

describe("PostgresStore Vector Search", () => {
  let store: PostgresStore;
  let dbName: string;
  let dbConnectionString: string;
  let mockEmbedding: ((texts: string[]) => Promise<number[][]>) & {
    calls: string[][];
    toHaveBeenCalled: () => boolean;
  };

  beforeEach(async () => {
    dbName = `vector_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await pool.end();
    }
    dbConnectionString = `${TEST_POSTGRES_URL.split("/")
      .slice(0, -1)
      .join("/")}/${dbName}`;
    mockEmbedding = createMockEmbedding(128, { asEmpty: false });
    store = new PostgresStore({
      connectionOptions: dbConnectionString,
      schema: "test_vector",
      index: {
        dims: 128,
        embed: mockEmbedding,
        fields: ["content", "title"],
      },
    });
    testStores.push(store);
    await store.setup();
  });

  it("should support vector search", async () => {
    // Given
    await store.put(["docs"], "doc1", {
      title: "Machine Learning Basics",
      content: "Introduction to neural networks and deep learning",
    });
    await store.put(["docs"], "doc2", {
      title: "Data Science Guide",
      content: "Statistical analysis and data visualization techniques",
    });

    // When
    const results = await store.search(["docs"], {
      query: "artificial intelligence",
      mode: "vector",
      limit: 5,
    });

    // Then
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(mockEmbedding.toHaveBeenCalled()).toBe(true);
  });

  it("should handle different distance metrics", async () => {
    // Given
    await store.put(["test"], "item1", { text: "sample content for testing" });

    // When
    const cosineResults = await store.search(["test"], {
      query: "query text",
      mode: "vector",
      distanceMetric: "cosine",
    });
    const l2Results = await store.search(["test"], {
      query: "query text",
      mode: "vector",
      distanceMetric: "l2",
    });
    const ipResults = await store.search(["test"], {
      query: "query text",
      mode: "vector",
      distanceMetric: "inner_product",
    });

    // Then
    expect(cosineResults).toBeDefined();
    expect(l2Results).toBeDefined();
    expect(ipResults).toBeDefined();
  });

  it("should respect similarity thresholds", async () => {
    // Given
    await store.put(["test"], "item1", { text: "very different content" });
    await store.put(["test"], "item2", { text: "similar query content" });

    // When
    const highThresholdResults = await store.search(["test"], {
      query: "query content",
      mode: "vector",
      similarityThreshold: 0.9,
    });
    const lowThresholdResults = await store.search(["test"], {
      query: "query content",
      mode: "vector",
      similarityThreshold: 0.1,
    });

    // Then
    expect(lowThresholdResults.length).toBeGreaterThanOrEqual(
      highThresholdResults.length
    );
  });

  it("should extract text from JSON paths correctly", async () => {
    // Given
    const testObj = {
      title: "Test Document",
      content: {
        sections: [
          { text: "Section 1 content" },
          { text: "Section 2 content" },
        ],
      },
      tags: ["ai", "ml", "nlp"],
      metadata: {
        author: "Test Author",
        version: 1,
      },
    };
    await store.put(["test"], "doc1", testObj);

    // When
    const searchResults = await store.search(["test"], {
      query: "Test Document",
      mode: "vector",
    });

    // Then
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].key).toBe("doc1");
  });

  it("should support vector mode in unified search method", async () => {
    // Given
    await store.put(["unified"], "doc1", {
      title: "Neural Networks",
      content: "Deep learning architectures and applications",
    });

    // When
    const results = await store.search(["unified"], {
      query: "artificial intelligence",
      mode: "vector",
      similarityThreshold: 0.1,
    });

    // Then
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeDefined();
    expect(mockEmbedding.toHaveBeenCalled()).toBe(true);
  });

  it("should use vector search by default when in auto mode with vector config", async () => {
    // Given
    await store.put(["auto"], "doc1", {
      title: "Machine Learning",
      content: "Algorithms for pattern recognition",
    });

    // When
    const results = await store.search(["auto"], {
      query: "data science techniques",
      mode: "auto",
    });

    // Then
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(mockEmbedding.calls[mockEmbedding.calls.length - 1]).toContain(
      "data science techniques"
    );
  });

  it("should honor index: false parameter when putting items", async () => {
    // Given
    const mockCallsBefore = mockEmbedding.calls.length;

    // When - put with index: false
    await store.put(
      ["no-index"],
      "doc1",
      {
        title: "Not Indexed Document",
        content: "This content should not be indexed for vector search",
      },
      false // Disable indexing
    );

    // Then - embedding function should not be called
    expect(mockEmbedding.calls.length).toBe(mockCallsBefore);

    // When - search for this item
    const results = await store.search(["no-index"], {
      query: "not indexed content",
      mode: "vector",
    });

    // Then - item should not be found via vector search
    expect(results.length).toBe(0);
  });

  it("should respect specific fields to index using index array parameter", async () => {
    // Given
    const mockCallsBefore = mockEmbedding.calls.length;

    // When - put with specific fields to index
    await store.put(
      ["selective-index"],
      "doc1",
      {
        title: "Selective Indexing Test",
        content: "Main content here",
        summary: "Summary text here",
        author: "Test Author",
      },
      ["title", "summary"] // Only index title and summary fields
    );

    // Then - embedding function should be called for title and summary only
    expect(mockEmbedding.calls.length).toBe(mockCallsBefore + 1);
    expect(mockEmbedding.calls[mockCallsBefore]).toContain(
      "Selective Indexing Test"
    );
    expect(mockEmbedding.calls[mockCallsBefore]).toContain("Summary text here");
    expect(mockEmbedding.calls[mockCallsBefore]).not.toContain(
      "Main content here"
    );

    // Verify with search
    const results = await store.search(["selective-index"], {
      query: "summary text",
      mode: "vector",
    });
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("PostgresStore Migration System", () => {
  let store: PostgresStore;
  let storeWithVectors: PostgresStore;
  let dbName: string;
  let dbConnectionString: string;
  let mockEmbedding: ((texts: string[]) => Promise<number[][]>) & {
    calls: string[][];
    toHaveBeenCalled: () => boolean;
  };

  beforeEach(async () => {
    dbName = `migration_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await pool.end();
    }
    dbConnectionString = `${TEST_POSTGRES_URL.split("/")
      .slice(0, -1)
      .join("/")}/${dbName}`;
  });

  afterEach(async () => {
    if (store) await store.stop();
    if (storeWithVectors) await storeWithVectors.stop();
  });

  it("should properly track and apply store migrations", async () => {
    // Create store without vector indexing
    store = PostgresStore.fromConnString(dbConnectionString, {
      schema: "migration_test",
    });
    testStores.push(store);

    // First setup should create migration table and apply all migrations
    await store.setup();

    // Verify migration table exists and has correct entries
    const pool = new Pool({ connectionString: dbConnectionString });
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT v FROM migration_test.store_migrations ORDER BY v`
      );

      // Should have exactly 4 migrations for basic store setup (migrations table, main table, indexes, trigger)
      expect(result.rows.length).toBe(4);
      expect(result.rows.map((r) => r.v)).toEqual([0, 1, 2, 3]);

      // Verify main tables were created
      const tablesResult = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'migration_test' 
        AND table_name IN ('store', 'store_migrations')
        ORDER BY table_name
      `);
      expect(tablesResult.rows.map((r) => r.table_name)).toEqual([
        "store",
        "store_migrations",
      ]);

      // Re-running setup should not create duplicate migrations
      await store.setup();
      const result2 = await client.query(
        `SELECT v FROM migration_test.store_migrations ORDER BY v`
      );
      expect(result2.rows.length).toBe(4); // Should still be 4, no duplicates
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("should apply vector migrations when vector indexing is configured", async () => {
    // Create store with vector indexing
    mockEmbedding = createMockEmbedding(128, { asEmpty: false });
    storeWithVectors = new PostgresStore({
      connectionOptions: dbConnectionString,
      schema: "vector_migration_test",
      index: {
        dims: 128,
        embed: mockEmbedding,
        fields: ["content"],
        indexType: "hnsw",
        distanceMetric: "cosine",
      },
    });
    testStores.push(storeWithVectors);

    await storeWithVectors.setup();

    // Verify migration table and vector migrations
    const pool = new Pool({ connectionString: dbConnectionString });
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT v FROM vector_migration_test.store_migrations ORDER BY v`
      );

      // Should have 7 migrations: 4 basic + 3 vector (extension + table + index)
      expect(result.rows.length).toBe(7);
      expect(result.rows.map((r) => r.v)).toEqual([0, 1, 2, 3, 4, 5, 6]);

      // Verify vector table was created
      const tablesResult = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'vector_migration_test' 
        AND table_name IN ('store', 'store_vectors', 'store_migrations')
        ORDER BY table_name
      `);
      expect(tablesResult.rows.map((r) => r.table_name)).toEqual([
        "store",
        "store_migrations",
        "store_vectors",
      ]);

      // Verify vector index was created
      const indexResult = await client.query(`
        SELECT indexname 
        FROM pg_indexes 
        WHERE schemaname = 'vector_migration_test' 
        AND indexname LIKE 'idx_store_vectors_embedding_%'
      `);
      expect(indexResult.rows.length).toBeGreaterThan(0);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("should handle migration failures gracefully", async () => {
    // Create store
    store = PostgresStore.fromConnString(dbConnectionString, {
      schema: "failure_test",
    });
    testStores.push(store);

    // First setup should work
    await store.setup();

    // Verify basic functionality works after migration
    await store.put(["test"], "key1", { data: "value1" });
    const item = await store.get(["test"], "key1");
    expect(item?.value).toEqual({ data: "value1" });
  });

  it("should support multiple schemas with independent migrations", async () => {
    // Create two stores with different schemas
    const store1 = PostgresStore.fromConnString(dbConnectionString, {
      schema: "schema1",
    });
    const store2 = PostgresStore.fromConnString(dbConnectionString, {
      schema: "schema2",
    });
    testStores.push(store1, store2);

    await store1.setup();
    await store2.setup();

    // Verify both schemas have independent migration tables
    const pool = new Pool({ connectionString: dbConnectionString });
    const client = await pool.connect();
    try {
      const schema1Result = await client.query(
        `SELECT v FROM schema1.store_migrations ORDER BY v`
      );
      const schema2Result = await client.query(
        `SELECT v FROM schema2.store_migrations ORDER BY v`
      );

      expect(schema1Result.rows.length).toBe(4);
      expect(schema2Result.rows.length).toBe(4);

      // Both should have same migration versions
      expect(schema1Result.rows.map((r) => r.v)).toEqual([0, 1, 2, 3]);
      expect(schema2Result.rows.map((r) => r.v)).toEqual([0, 1, 2, 3]);
    } finally {
      client.release();
      await pool.end();
    }
  });
});
