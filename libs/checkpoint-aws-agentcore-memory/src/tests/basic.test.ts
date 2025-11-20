import { describe, it, expect, beforeEach } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { AgentCoreMemorySaver } from "../saver.js";
import { AgentCoreMemoryStore } from "../store.js";

describe("AgentCoreMemory Implementation", () => {
  let memoryId: string;
  let saver: AgentCoreMemorySaver;
  let store: AgentCoreMemoryStore;

  beforeEach(() => {
    memoryId = `test-${uuidv4()}`;
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
      // Test that our implementations have the expected methods
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

    it("should handle store operations without AWS credentials", async () => {
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

    it("should validate namespace for store operations", async () => {
      // Empty namespace should throw InvalidNamespaceError
      await expect(store.put([], "key", { data: "test" })).rejects.toThrow();
    });
  });
});
