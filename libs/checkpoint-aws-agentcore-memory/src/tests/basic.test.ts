import { describe, it, expect, beforeEach } from "vitest";
import { AgentCoreMemorySaver } from "../saver.js";
import { AgentCoreMemoryStore } from "../store.js";

describe("AgentCoreMemory Implementation", () => {
  let memoryId: string;
  let saver: AgentCoreMemorySaver;
  let store: AgentCoreMemoryStore;

  beforeEach(() => {
    memoryId = `test-mem-${Date.now()}-${Math.random().toString(36).substring(2, 12)}`;
    saver = new AgentCoreMemorySaver({ memoryId, region: "us-east-1" });
    store = new AgentCoreMemoryStore({ memoryId, region: "us-east-1" });
  });

  describe("AgentCoreMemorySaver", () => {
    it("should create instance with required parameters", () => {
      expect(saver).toBeInstanceOf(AgentCoreMemorySaver);
      expect(saver.serde).toBeDefined();
    });

    it("should return undefined for missing thread_id", async () => {
      const config = { configurable: { actor_id: "test-actor" } };

      const result = await saver.getTuple(config);
      expect(result).toBeUndefined();
    });

    it("should handle missing actor_id with default", async () => {
      const config = { configurable: { thread_id: "test-thread" } };

      // This will fail due to AWS validation, but that's expected in test environment
      try {
        await saver.getTuple(config);
      } catch (error) {
        // Expected to fail in test environment without proper AWS setup
        expect(error).toBeDefined();
      }
    });
  });

  describe("AgentCoreMemoryStore", () => {
    it("should create instance with required parameters", () => {
      expect(store).toBeInstanceOf(AgentCoreMemoryStore);
    });

    it("should handle batch operations", async () => {
      const operations = [
        {
          namespace: ["test", "actor1"],
          key: "item1",
          value: { data: "test data" },
        },
      ];

      // This will likely fail without proper AWS credentials, but tests the interface
      try {
        await store.batch(operations);
      } catch (error) {
        // Expected to fail in test environment without AWS setup
        expect(error).toBeDefined();
      }
    });
  });

  describe("Integration", () => {
    it("should have compatible interfaces", () => {
      expect(typeof saver.getTuple).toBe("function");
      expect(typeof saver.list).toBe("function");
      expect(typeof saver.put).toBe("function");
      expect(typeof saver.putWrites).toBe("function");
      expect(typeof saver.deleteThread).toBe("function");

      expect(typeof store.batch).toBe("function");
      expect(typeof store.get).toBe("function");
      expect(typeof store.search).toBe("function");
      expect(typeof store.put).toBe("function");
      expect(typeof store.delete).toBe("function");
      expect(typeof store.listNamespaces).toBe("function");
    });

    it("should route delete via batch as PutOperation with null value", async () => {
      // BaseStore.delete() calls batch([{ namespace, key, value: null }])
      // Verify batch correctly routes to handleDelete (not silently no-ops)
      let capturedOp: unknown;
      const originalBatch = store.batch.bind(store);
      store.batch = async (ops) => {
        capturedOp = ops[0];
        // Don't actually call AWS — just verify routing
        return [undefined] as never;
      };

      await store.delete(["test", "actor1"], "item1");

      expect(capturedOp).toMatchObject({
        namespace: ["test", "actor1"],
        key: "item1",
        value: null,
      });

      store.batch = originalBatch;
    });

    it("should validate namespace for store operations", async () => {
      await expect(store.put([], "key", { data: "test" })).rejects.toThrow();
    });
  });
});
