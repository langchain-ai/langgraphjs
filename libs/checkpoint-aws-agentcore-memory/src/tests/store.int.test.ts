/* eslint-disable no-process-env */
import { config } from "dotenv";
import { describe, it, expect, beforeEach } from "vitest";
import { AgentCoreMemoryStore } from "../store.js";

// Load environment variables from .env file
config();

const { AWS_REGION, AGENTCORE_MEMORY_ID } = process.env;
if (!AWS_REGION || !AGENTCORE_MEMORY_ID) {
  throw new Error(
    "AWS_REGION and AGENTCORE_MEMORY_ID environment variables are required"
  );
}

describe("AgentCoreMemoryStore Integration Tests", () => {
  let store: AgentCoreMemoryStore;

  beforeEach(() => {
    store = new AgentCoreMemoryStore({
      memoryId: AGENTCORE_MEMORY_ID,
      region: AWS_REGION,
    });
  });

  describe("Basic Operations", () => {
    it("should put and get an item", async () => {
      const namespace = ["test", "actor1", "documents"];
      const key = `doc-${Date.now()}`;
      const value = { title: "Test Document", content: "Hello, World!" };

      await store.put(namespace, key, value);
      const item = await store.get(namespace, key);

      expect(item).toBeDefined();
      expect(item?.namespace).toEqual(namespace);
      expect(item?.key).toBe(key);
      expect(item?.value).toEqual(value);
      expect(item?.createdAt).toBeInstanceOf(Date);
      expect(item?.updatedAt).toBeInstanceOf(Date);
    });

    it("should update an existing item", async () => {
      const namespace = ["test", "actor1", "documents"];
      const key = `doc-update-${Date.now()}`;
      const value = { title: "Test Document", content: "Hello, World!" };
      const updatedValue = {
        title: "Updated Document",
        content: "Hello, Updated!",
      };

      await store.put(namespace, key, value);
      const item = await store.get(namespace, key);

      await store.put(namespace, key, updatedValue);
      const updatedItem = await store.get(namespace, key);

      expect(updatedItem?.value).toEqual(updatedValue);
      expect(updatedItem?.updatedAt.getTime()).toBeGreaterThan(
        item!.updatedAt.getTime()
      );
    });

    it("should return null for non-existent item", async () => {
      const item = await store.get(["test", "actor1"], "nonexistent");
      expect(item).toBeNull();
    });

    it("should handle delete operation (warn and skip)", async () => {
      const namespace = ["test", "actor1"];
      const key = `doc-delete-${Date.now()}`;
      const value = { data: "test" };

      await store.put(namespace, key, value);
      let item = await store.get(namespace, key);
      expect(item).toBeDefined();

      // Delete should warn and skip (AgentCore Memory doesn't support deletion)
      await store.delete(namespace, key);

      // Item should still exist since deletion is not supported
      item = await store.get(namespace, key);
      expect(item).toBeDefined();
    });
  });

  describe("Batch Operations", () => {
    it("should handle batch operations in correct order", async () => {
      const timestamp = Date.now();

      // Setup test data
      await store.put(["test", "actor1", "foo"], `key1-${timestamp}`, {
        data: "value1",
      });
      await store.put(["test", "actor1", "bar"], `key2-${timestamp}`, {
        data: "value2",
      });

      const ops = [
        { namespace: ["test", "actor1", "foo"], key: `key1-${timestamp}` },
        {
          namespace: ["test", "actor1", "bar"],
          key: `key2-${timestamp}`,
          value: { data: "value2" },
        },
        {
          namespace: ["test", "actor1", "baz"],
          key: `key3-${timestamp}`,
          value: { data: "value3" },
        },
        { namespace: ["test", "actor1", "baz"], key: `key3-${timestamp}` },
      ];

      const results = await store.batch(ops);

      expect(results).toHaveLength(4);
      expect(results[0]?.value).toEqual({ data: "value1" });
      expect(results[1]).toBeUndefined(); // put returns undefined
      expect(results[2]).toBeUndefined(); // put returns undefined
      expect(results[3]?.value).toEqual({ data: "value3" });
    });

    it("should handle multiple put operations", async () => {
      const timestamp = Date.now();
      const ops = [
        {
          namespace: ["batch", "actor1", "test"],
          key: `item1-${timestamp}`,
          value: { id: 1 },
        },
        {
          namespace: ["batch", "actor1", "test"],
          key: `item2-${timestamp}`,
          value: { id: 2 },
        },
        {
          namespace: ["batch", "actor1", "test"],
          key: `item3-${timestamp}`,
          value: { id: 3 },
        },
      ];

      await store.batch(ops);

      // Verify all items were stored
      const item1 = await store.get(
        ["batch", "actor1", "test"],
        `item1-${timestamp}`
      );
      const item2 = await store.get(
        ["batch", "actor1", "test"],
        `item2-${timestamp}`
      );
      const item3 = await store.get(
        ["batch", "actor1", "test"],
        `item3-${timestamp}`
      );

      expect(item1?.value.id).toBe(1);
      expect(item2?.value.id).toBe(2);
      expect(item3?.value.id).toBe(3);
    });
  });

  describe("Search Operations", () => {
    beforeEach(async () => {
      const timestamp = Date.now();
      const namespace = ["search", "actor1", "test"];

      await store.put(namespace, `item1-${timestamp}`, {
        type: "doc",
        title: "First",
        timestamp,
      });
      await store.put(namespace, `item2-${timestamp}`, {
        type: "doc",
        title: "Second",
        timestamp,
      });
      await store.put(namespace, `item3-${timestamp}`, {
        type: "note",
        title: "Third",
        timestamp,
      });
    });

    it("should search all items in namespace", async () => {
      const namespace = ["search", "actor1", "test"];

      const results = await store.search(namespace);

      expect(results.length).toBeGreaterThanOrEqual(3);
      // Check that we have items with the expected structure
      results.forEach((result) => {
        expect(result.namespace).toEqual(namespace);
        expect(result.key).toBeDefined();
        expect(result.value).toBeDefined();
        expect(result.createdAt).toBeInstanceOf(Date);
        expect(result.updatedAt).toBeInstanceOf(Date);
      });
    });

    it("should filter by value properties", async () => {
      const namespace = ["filter", "actor1", "test"];
      const timestamp = Date.now();

      await store.put(namespace, `item1-${timestamp}`, {
        type: "doc",
        status: "draft",
        timestamp,
      });
      await store.put(namespace, `item2-${timestamp}`, {
        type: "doc",
        status: "published",
        timestamp,
      });
      await store.put(namespace, `item3-${timestamp}`, {
        type: "note",
        status: "draft",
        timestamp,
      });

      const results = await store.search(namespace, {
        filter: { type: "doc" },
      });

      expect(results.length).toBeGreaterThanOrEqual(2);
      results.forEach((result) => {
        expect(result.value.type).toBe("doc");
      });
    });

    it("should handle pagination", async () => {
      const namespace = ["pagination", "actor1", "test"];
      const timestamp = Date.now();

      // Create multiple items
      for (let i = 0; i < 5; i++) {
        await store.put(namespace, `item${i}-${timestamp}`, {
          index: i,
          category: "test",
          timestamp,
        });
      }

      const page1 = await store.search(namespace, { limit: 2, offset: 0 });
      const page2 = await store.search(namespace, { limit: 2, offset: 2 });

      expect(page1.length).toBeLessThanOrEqual(2);
      expect(page2.length).toBeLessThanOrEqual(2);

      if (page1.length > 0 && page2.length > 0) {
        // Ensure different results
        const page1Keys = page1.map((r) => r.key).sort();
        const page2Keys = page2.map((r) => r.key).sort();
        expect(page1Keys).not.toEqual(page2Keys);
      }
    });

    it("should handle empty search results", async () => {
      const namespace = ["empty", "actor1", "search"];

      const noResults = await store.search(namespace, {
        filter: { type: "nonexistent" },
      });

      expect(noResults).toHaveLength(0);
      expect(Array.isArray(noResults)).toBe(true);
    });
  });

  describe("Complex JSON Values", () => {
    it("should handle complex nested JSON values", async () => {
      const namespace = ["complex", "actor1", "json"];
      const key = `nested-${Date.now()}`;
      const complexValue = {
        string: "test",
        number: 42,
        boolean: true,
        null: null,
        array: [1, 2, 3, "four", [5, 6]],
        nested: {
          deep: {
            value: "nested data",
            deeper: {
              array: [{ id: 1 }, { id: 2 }],
              timestamp: new Date().toISOString(),
            },
          },
        },
        unicode: "emoji 🎉 and special chars: äöü",
      };

      await store.put(namespace, key, complexValue);
      const retrieved = await store.get(namespace, key);

      expect(retrieved?.value).toEqual(complexValue);
    });

    it("should handle large JSON values", async () => {
      const namespace = ["large", "actor1", "json"];
      const key = `big-${Date.now()}`;
      const largeArray = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        data: `item-${i}`,
        nested: { value: i * 2 },
      }));
      const largeValue = {
        items: largeArray,
        metadata: {
          count: largeArray.length,
          timestamp: new Date().toISOString(),
        },
      };

      await store.put(namespace, key, largeValue);
      const retrieved = await store.get(namespace, key);

      expect(retrieved?.value).toEqual(largeValue);
      expect(retrieved?.value.items).toHaveLength(100);
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid namespace gracefully", async () => {
      // Empty namespace should throw InvalidNamespaceError
      await expect(store.put([], "key", { data: "test" })).rejects.toThrow();
    });

    it("should handle network errors gracefully", async () => {
      // Create store with invalid memory ID to trigger errors
      const invalidStore = new AgentCoreMemoryStore({
        memoryId: "invalid-memory-id",
        region: AWS_REGION,
      });

      await expect(
        invalidStore.get(["test", "actor1"], "key")
      ).rejects.toThrow();
    });
  });

  describe("Namespace Handling", () => {
    it("should handle different namespace structures", async () => {
      const timestamp = Date.now();

      // Test different namespace lengths
      const namespaces = [
        ["single"],
        ["two", "parts"],
        ["three", "part", "namespace"],
        ["four", "part", "namespace", "structure"],
      ];

      for (const namespace of namespaces) {
        const key = `test-${timestamp}`;
        const value = {
          namespace: namespace.join(":"),
          length: namespace.length,
        };

        await store.put(namespace, key, value);
        const retrieved = await store.get(namespace, key);

        expect(retrieved?.value).toEqual(value);
        expect(retrieved?.namespace).toEqual(namespace);
      }
    });

    it("should isolate items by namespace", async () => {
      const timestamp = Date.now();
      const key = `isolated-${timestamp}`;
      const value1 = { data: "namespace1" };
      const value2 = { data: "namespace2" };

      await store.put(["ns1", "actor1"], key, value1);
      await store.put(["ns2", "actor1"], key, value2);

      const item1 = await store.get(["ns1", "actor1"], key);
      const item2 = await store.get(["ns2", "actor1"], key);

      expect(item1?.value).toEqual(value1);
      expect(item2?.value).toEqual(value2);
      expect(item1?.value).not.toEqual(item2?.value);
    });
  });

  describe("List Namespaces", () => {
    it("should handle listNamespaces operation", async () => {
      // AgentCore Memory doesn't have direct namespace listing
      // This should return empty array and warn
      const namespaces = await store.listNamespaces();
      expect(Array.isArray(namespaces)).toBe(true);
      expect(namespaces).toHaveLength(0);
    });
  });
});
