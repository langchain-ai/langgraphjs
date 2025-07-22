/* eslint-disable no-process-env */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { PostgresStore } from "../../store/index.js";

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

describe("PostgresStore Hybrid Search (integration)", () => {
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
    mockEmbedding = createMockEmbedding(128);
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

  afterAll(async () => {
    await Promise.all(testStores.map((s) => s.end()));
    testStores = [];
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      const result = await pool.query(
        `SELECT datname FROM pg_database WHERE datname LIKE 'hybrid_test_%'`
      );
      for (const row of result.rows) {
        await pool.query(`DROP DATABASE ${row.datname} WITH (FORCE)`);
      }
    } finally {
      await pool.end();
    }
  });

  it("should combine vector and text search effectively", async () => {
    // When
    const vectorHeavy = await store.hybridSearch(
      ["docs"],
      "machine learning algorithms",
      { vectorWeight: 0.9, limit: 10 }
    );
    const textHeavy = await store.hybridSearch(
      ["docs"],
      "machine learning algorithms",
      { vectorWeight: 0.1, limit: 10 }
    );
    const balanced = await store.hybridSearch(
      ["docs"],
      "machine learning algorithms",
      { vectorWeight: 0.5, limit: 10 }
    );

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
    const results = await store.hybridSearch(
      ["docs"],
      "machine learning algorithms",
      { vectorWeight: 0.5, limit: 10 }
    );

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
    const directResults = await store.hybridSearch(
      ["docs"],
      "neural networks research",
      {
        vectorWeight,
        similarityThreshold,
        limit: 5,
      }
    );

    // Both should have similar result structure
    expect(results.length).toBe(directResults.length);
    if (results.length > 0 && directResults.length > 0) {
      expect(typeof results[0].score).toBe(typeof directResults[0].score);
    }
  });
});
