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

describe("PostgresStore Batch Operations (integration)", () => {
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
        `SELECT datname FROM pg_database WHERE datname LIKE 'batch_test_%'`
      );
      for (const row of result.rows) {
        await pool.query(`DROP DATABASE ${row.datname} WITH (FORCE)`);
      }
    } finally {
      await pool.end();
    }
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
