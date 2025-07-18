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

describe("PostgresStore TTL (integration)", () => {
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

  afterAll(async () => {
    await Promise.all(testStores.map((s) => s.end()));
    testStores = [];
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      const result = await pool.query(
        `SELECT datname FROM pg_database WHERE datname LIKE 'ttl_test_%'`
      );
      for (const row of result.rows) {
        await pool.query(`DROP DATABASE ${row.datname} WITH (FORCE)`);
      }
    } finally {
      await pool.end();
    }
  });

  it("should support TTL configuration and sweep", async () => {
    // Given
    await store.putAdvanced(["test"], "ttl-item", { data: "expires" });

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
    await store.putAdvanced(["test"], "refresh-item", { data: "refresh test" });

    // When
    const item1 = await store.get(["test"], "refresh-item");
    const item2 = await store.get(["test"], "refresh-item");

    // Then
    expect(item1).toBeTruthy();
    expect(item2).toBeTruthy();
    expect(item2?.value).toEqual({ data: "refresh test" });
  });
});
