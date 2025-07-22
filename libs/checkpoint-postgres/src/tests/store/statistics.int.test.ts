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

describe("PostgresStore Statistics (integration)", () => {
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
    store = PostgresStore.fromConnectionString(dbConnectionString);
    testStores.push(store);
    await store.setup();
  });

  afterAll(async () => {
    await Promise.all(testStores.map((s) => s.end()));
    testStores = [];
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      const result = await pool.query(
        `SELECT datname FROM pg_database WHERE datname LIKE 'stats_test_%'`
      );
      for (const row of result.rows) {
        await pool.query(`DROP DATABASE ${row.datname} WITH (FORCE)`);
      }
    } finally {
      await pool.end();
    }
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
