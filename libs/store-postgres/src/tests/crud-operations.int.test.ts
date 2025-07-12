/* eslint-disable no-process-env */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { PostgresStore } from "../index.js";

const { Pool } = pg;
const { TEST_POSTGRES_URL } = process.env;

if (!TEST_POSTGRES_URL) {
  throw new Error("TEST_POSTGRES_URL environment variable is required");
}

let testStores: PostgresStore[] = [];

// Helper for mock embedding
const createMockEmbedding = (dims: number) => {
  // Create fixed vectors that will ensure different search results
  const TITLE_VECTOR = new Array(dims).fill(0);
  TITLE_VECTOR[0] = 1.0; // Only first dimension is 1.0

  const CONTENT_VECTOR = new Array(dims).fill(0);
  CONTENT_VECTOR[dims - 1] = 1.0; // Only last dimension is 1.0

  // Empty vector will not match anything
  const EMPTY_VECTOR = new Array(dims).fill(0);

  const mockFn = async (texts: string[]): Promise<number[][]> => {
    mockFn.calls.push(texts);

    return texts.map((text) => {
      // Exact matching for testing purposes
      if (text === "Combined Options Test") {
        return [...TITLE_VECTOR]; // Clone to avoid mutation
      } else if (text === "Testing both TTL and indexing options") {
        return [...CONTENT_VECTOR]; // Clone to avoid mutation
      } else if (text === "combined options") {
        return [...TITLE_VECTOR]; // Clone to avoid mutation
      } else if (text === "testing both") {
        return [...CONTENT_VECTOR]; // Clone to avoid mutation
      } else {
        return [...EMPTY_VECTOR]; // Clone to avoid mutation
      }
    });
  };

  mockFn.calls = [] as string[][];
  mockFn.toHaveBeenCalled = () => mockFn.calls.length > 0;
  return mockFn;
};

describe("PostgresStore CRUD Operations (integration)", () => {
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
    store = PostgresStore.fromConnectionString(dbConnectionString);
    testStores.push(store);
    await store.setup();

    // Store with vector indexing
    mockEmbedding = createMockEmbedding(128);
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

  afterAll(async () => {
    await Promise.all(testStores.map((s) => s.end()));
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
    const results = await storeWithVectors.vectorSearch(
      namespace,
      "test document"
    );

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
    const results = await storeWithVectors.vectorSearch(
      namespace,
      "indexed summary"
    );

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
