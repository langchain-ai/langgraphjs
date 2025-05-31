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

describe("PostgresStore CRUD Operations (integration)", () => {
  let store: PostgresStore;
  let dbName: string;
  let dbConnectionString: string;

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
});
