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

describe("PostgresStore Search (integration)", () => {
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
    store = PostgresStore.fromConnectionString(dbConnectionString);
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

  afterAll(async () => {
    await Promise.all(testStores.map((s) => s.end()));
    testStores = [];
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      const result = await pool.query(
        `SELECT datname FROM pg_database WHERE datname LIKE 'search_test_%'`
      );
      for (const row of result.rows) {
        await pool.query(`DROP DATABASE ${row.datname} WITH (FORCE)`);
      }
    } finally {
      await pool.end();
    }
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
      mode: "text"
    });

    // Then
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(item => 
      item.value.title.includes("JavaScript") || 
      item.value.content.includes("JavaScript")
    )).toBe(true);
  });

  it("should perform full-text search with auto mode defaulting to text", async () => {
    // When
    const results = await store.search(["docs"], {
      query: "programming",
      mode: "auto"
    });

    // Then
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(item => 
      item.value.title.includes("programming") || 
      item.value.content.includes("programming") ||
      item.value.category === "programming"
    )).toBe(true);
  });

  it("should combine filtering with text search", async () => {
    // When
    const results = await store.search(["docs"], {
      query: "guide",
      filter: { difficulty: "beginner" },
      mode: "text"
    });

    // Then
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(item => item.value.difficulty === "beginner")).toBe(true);
    expect(results.some(item => 
      item.value.title.toLowerCase().includes("guide") || 
      item.value.content.toLowerCase().includes("guide")
    )).toBe(true);
  });
});
