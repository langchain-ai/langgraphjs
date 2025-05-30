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

describe("PostgresStore Error Handling (integration)", () => {
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
        `SELECT datname FROM pg_database WHERE datname LIKE 'err_test_%'`
      );
      for (const row of result.rows) {
        await pool.query(`DROP DATABASE ${row.datname} WITH (FORCE)`);
      }
    } finally {
      await pool.end();
    }
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
});
