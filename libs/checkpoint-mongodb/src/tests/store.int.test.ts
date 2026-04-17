import { MongoClient } from "mongodb";
import { MongoDBStore } from "../store";
import {
  type PutOperation,
  type GetOperation,
  type SearchOperation,
} from "@langchain/langgraph-checkpoint";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("MongoDBStore Integration Tests", () => {
  let client: MongoClient;
  let store: MongoDBStore;
  const dbName = "langgraph_test";
  const mongoUrl = getEnvironmentVariable("MONGODB_URL") || "mongodb://localhost:27017";

  beforeAll(async () => {
    client = new MongoClient(mongoUrl, {
      auth: { username: "user", password: "password" },
    });
    await client.connect();

    store = new MongoDBStore({
      client,
      dbName,
      collectionName: "test_store",
    });

    await store.start();
    await client.db(dbName).collection("test_store").deleteMany({});
  });

  afterAll(async () => {
    await client.db(dbName).collection("test_store").deleteMany({});
    await client.close();
  });

  describe("put", () => {
    it("should store and retrieve an item", async () => {
      await store.batch([{
        namespace: ["put_test", "profiles"],
        key: "user123",
        value: { name: "Alice", email: "alice@example.com" },
      } as PutOperation]);

      const results = await store.batch([
        { namespace: ["put_test", "profiles"], key: "user123" } as GetOperation,
      ]);
      const item = results[0];

      expect(item).toBeDefined();
      expect(item?.value).toEqual({ name: "Alice", email: "alice@example.com" });
      expect(item?.namespace).toEqual(["put_test", "profiles"]);
      expect(item?.key).toEqual("user123");
    });

    it("should update an existing item", async () => {
      await store.batch([
        { namespace: ["put_test"], key: "doc1", value: { title: "Original", version: 1 } } as PutOperation,
      ]);
      await store.batch([
        { namespace: ["put_test"], key: "doc1", value: { title: "Updated", version: 2 } } as PutOperation,
      ]);

      const results = await store.batch([
        { namespace: ["put_test"], key: "doc1" } as GetOperation,
      ]);

      expect(results[0]?.value.version).toBe(2);
      expect(results[0]?.value.title).toBe("Updated");
    });

    it("should delete an item when value is null", async () => {
      await store.batch([
        { namespace: ["put_test"], key: "to_delete", value: { data: "will delete" } } as PutOperation,
      ]);
      await store.batch([
        { namespace: ["put_test"], key: "to_delete", value: null } as PutOperation,
      ]);

      const results = await store.batch([
        { namespace: ["put_test"], key: "to_delete" } as GetOperation,
      ]);

      expect(results[0]).toBeNull();
    });
  });

  describe("get", () => {
    it("should return null for non-existent item", async () => {
      const results = await store.batch([
        { namespace: ["nonexistent"], key: "missing" } as GetOperation,
      ]);

      expect(results[0]).toBeNull();
    });
  });

  describe("search", () => {
    beforeAll(async () => {
      const ops: PutOperation[] = [
        { namespace: ["products"], key: "prod1", value: { name: "Budget Item", price: 29.99, category: "electronics" } },
        { namespace: ["products"], key: "prod2", value: { name: "Standard Item", price: 99.99, category: "electronics" } },
        { namespace: ["products"], key: "prod3", value: { name: "Premium Item", price: 299.99, category: "electronics" } },
        { namespace: ["products"], key: "prod4", value: { name: "Book", price: 19.99, category: "books" } },
        { namespace: ["search_users"], key: "user1", value: { username: "alice", status: "active", score: 95 } },
        { namespace: ["search_users"], key: "user2", value: { username: "bob", status: "inactive", score: 42 } },
        { namespace: ["search_users"], key: "user3", value: { username: "charlie", status: "active", score: 87 } },
        { namespace: ["search_users", "profiles"], key: "profile1", value: { bio: "Engineer", city: "SF" } },
        { namespace: ["search_users", "profiles"], key: "profile2", value: { bio: "Designer", city: "NYC" } },
      ];

      await store.batch(ops);
    });

    it("should filter with exact match", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: { category: "electronics" },
        limit: 100,
        offset: 0,
      } as SearchOperation]);
      const items = results[0] as any[];

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item: any) => item.value.category === "electronics")).toBe(true);
    });

    it("should filter with comparison operator $gt", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: { price: { $gt: 100 } },
        limit: 100,
        offset: 0,
      } as SearchOperation]);
      const items = results[0] as any[];

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item: any) => item.value.price > 100)).toBe(true);
    });

    it("should filter with comparison operator $lte", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: { price: { $lte: 50 } },
        limit: 100,
        offset: 0,
      } as SearchOperation]);
      const items = results[0] as any[];

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item: any) => item.value.price <= 50)).toBe(true);
    });

    it("should filter with multiple conditions", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: { category: "electronics", price: { $gte: 50 } },
        limit: 100,
        offset: 0,
      } as SearchOperation]);
      const items = results[0] as any[];

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item: any) =>
        item.value.category === "electronics" && item.value.price >= 50
      )).toBe(true);
    });

    it("should match nested namespaces when searching by prefix", async () => {
      const results = await store.batch([{
        namespacePrefix: ["search_users"],
        filter: {},
        limit: 100,
        offset: 0,
      } as SearchOperation]);
      const items = results[0] as any[];

      expect(items.length).toBeGreaterThan(0);
      const namespaces = items.map((item: any) => JSON.stringify(item.namespace));
      expect(namespaces).toContain(JSON.stringify(["search_users"]));
      expect(namespaces).toContain(JSON.stringify(["search_users", "profiles"]));
    });

    it("should apply limit", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: {},
        limit: 2,
        offset: 0,
      } as SearchOperation]);

      expect((results[0] as any[]).length).toBeLessThanOrEqual(2);
    });

    it("should apply offset", async () => {
      const results1 = await store.batch([{
        namespacePrefix: ["search_users"],
        filter: { status: "active" },
        limit: 100,
        offset: 0,
      } as SearchOperation]);

      const results2 = await store.batch([{
        namespacePrefix: ["search_users"],
        filter: { status: "active" },
        limit: 100,
        offset: 1,
      } as SearchOperation]);

      expect((results2[0] as any[]).length).toBeLessThan((results1[0] as any[]).length);
    });

    it("should return empty array for non-matching filter", async () => {
      const results = await store.batch([{
        namespacePrefix: ["products"],
        filter: { category: "nonexistent" },
        limit: 100,
        offset: 0,
      } as SearchOperation]);

      expect(results[0]).toEqual([]);
    });
  });

  describe("listNamespaces", () => {
    beforeAll(async () => {
      const ops: PutOperation[] = [
        { namespace: ["threads"], key: "t1", value: { id: 1 } },
        { namespace: ["threads"], key: "t2", value: { id: 2 } },
        { namespace: ["threads", "messages"], key: "m1", value: { text: "hi" } },
        { namespace: ["threads", "messages"], key: "m2", value: { text: "bye" } },
        { namespace: ["ns_users"], key: "u1", value: { name: "Alice" } },
        { namespace: ["ns_users", "profiles"], key: "p1", value: { bio: "..." } },
      ];

      await store.batch(ops);
    });

    it("should list all unique namespaces", async () => {
      const results = await store.batch([{ limit: 100, offset: 0 }]);
      const namespaces = results[0] as string[][];

      expect(namespaces).toContainEqual(["threads"]);
      expect(namespaces).toContainEqual(["threads", "messages"]);
      expect(namespaces).toContainEqual(["ns_users"]);
      expect(namespaces).toContainEqual(["ns_users", "profiles"]);
    });

    it("should apply limit", async () => {
      const results = await store.batch([{ limit: 2, offset: 0 }]);

      expect((results[0] as string[][]).length).toBeLessThanOrEqual(2);
    });

    it("should apply offset", async () => {
      const results1 = await store.batch([{ limit: 100, offset: 0 }]);
      const results2 = await store.batch([{ limit: 100, offset: 2 }]);

      expect((results2[0] as string[][]).length).toBeLessThan(
        (results1[0] as string[][]).length
      );
    });

    it("should filter by prefix matchCondition", async () => {
      const results = await store.batch([{
        matchConditions: [{ matchType: "prefix" as const, path: ["threads"] }],
        limit: 100,
        offset: 0,
      }]);
      const namespaces = results[0] as string[][];

      expect(namespaces).toContainEqual(["threads"]);
      expect(namespaces).toContainEqual(["threads", "messages"]);
      expect(namespaces).not.toContainEqual(["ns_users"]);
      expect(namespaces).not.toContainEqual(["ns_users", "profiles"]);
    });

    it("should filter by suffix matchCondition", async () => {
      const results = await store.batch([{
        matchConditions: [{ matchType: "suffix" as const, path: ["profiles"] }],
        limit: 100,
        offset: 0,
      }]);
      const namespaces = results[0] as string[][];

      expect(namespaces).toContainEqual(["ns_users", "profiles"]);
      expect(namespaces).not.toContainEqual(["threads"]);
      expect(namespaces).not.toContainEqual(["ns_users"]);
    });

    it("should support wildcard in matchCondition", async () => {
      const results = await store.batch([{
        matchConditions: [{ matchType: "prefix" as const, path: ["*", "messages"] }],
        limit: 100,
        offset: 0,
      }]);
      const namespaces = results[0] as string[][];

      expect(namespaces).toContainEqual(["threads", "messages"]);
      expect(namespaces).not.toContainEqual(["threads"]);
      expect(namespaces).not.toContainEqual(["ns_users"]);
    });
  });

  describe("batch", () => {
    it("should execute mixed operations in one batch", async () => {
      const results = await store.batch([
        { namespace: ["batch_test"], key: "item1", value: { num: 1 } } as PutOperation,
        { namespace: ["batch_test"], key: "item2", value: { num: 2 } } as PutOperation,
        { namespace: ["batch_test"], key: "item1" } as GetOperation,
      ]);

      expect(results[0]).toBeUndefined();
      expect(results[1]).toBeUndefined();
      expect(results[2]?.value).toEqual({ num: 1 });
    });
  });
});
