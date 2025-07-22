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

describe("PostgresStore Namespace Listing (integration)", () => {
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
        `SELECT datname FROM pg_database WHERE datname LIKE 'ns_test_%'`
      );
      for (const row of result.rows) {
        await pool.query(`DROP DATABASE ${row.datname} WITH (FORCE)`);
      }
    } finally {
      await pool.end();
    }
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
