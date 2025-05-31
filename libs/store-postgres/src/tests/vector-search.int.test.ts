/* eslint-disable no-process-env */
import { describe, it, expect, beforeEach, afterAll } from "@jest/globals";
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
  const mockFn = async (texts: string[]): Promise<number[][]> => {
    mockFn.calls.push(texts);
    return texts.map((text, index) => {
      const embedding = new Array(dims).fill(0);
      for (let i = 0; i < dims; i += 1) {
        embedding[i] = Math.sin(
          (text.charCodeAt(i % text.length) + index) * 0.1
        );
      }
      return embedding;
    });
  };
  mockFn.calls = [] as string[][];
  mockFn.toHaveBeenCalled = () => mockFn.calls.length > 0;
  return mockFn;
};

describe("PostgresStore Vector Search (integration)", () => {
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
    mockEmbedding = createMockEmbedding(128);
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

  afterAll(async () => {
    await Promise.all(testStores.map((s) => s.end()));
    testStores = [];
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      const result = await pool.query(
        `SELECT datname FROM pg_database WHERE datname LIKE 'vector_test_%'`
      );
      for (const row of result.rows) {
        await pool.query(`DROP DATABASE ${row.datname} WITH (FORCE)`);
      }
    } finally {
      await pool.end();
    }
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
    const results = await store.vectorSearch(
      ["docs"],
      "artificial intelligence",
      { limit: 5 }
    );

    // Then
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(mockEmbedding.toHaveBeenCalled()).toBe(true);
  });

  it("should handle different distance metrics", async () => {
    // Given
    await store.put(["test"], "item1", { text: "sample content for testing" });

    // When
    const cosineResults = await store.vectorSearch(["test"], "query text", {
      distanceMetric: "cosine",
    });
    const l2Results = await store.vectorSearch(["test"], "query text", {
      distanceMetric: "l2",
    });
    const ipResults = await store.vectorSearch(["test"], "query text", {
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
    const highThresholdResults = await store.vectorSearch(
      ["test"],
      "query content",
      { similarityThreshold: 0.9 }
    );
    const lowThresholdResults = await store.vectorSearch(
      ["test"],
      "query content",
      { similarityThreshold: 0.1 }
    );

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
    const searchResults = await store.vectorSearch(["test"], "Test Document");

    // Then
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].key).toBe("doc1");
  });

  it("should support vector mode in unified search method", async () => {
    // Given
    await store.put(["unified"], "doc1", {
      title: "Neural Networks",
      content: "Deep learning architectures and applications"
    });

    // When
    const results = await store.search(["unified"], {
      query: "artificial intelligence",
      mode: "vector",
      similarityThreshold: 0.1
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
      content: "Algorithms for pattern recognition"
    });

    // When
    const results = await store.search(["auto"], {
      query: "data science techniques",
      mode: "auto"
    });

    // Then
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(mockEmbedding.calls[mockEmbedding.calls.length-1]).toContain("data science techniques");
  });
});
