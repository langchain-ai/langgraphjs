import { describe, it, expect, vi } from "vitest";
import { type MongoClient } from "mongodb";
import { MongoDBSaver } from "../index.js";

const createMockClient = () => ({
  appendMetadata: vi.fn(),
  db: vi.fn(() => ({
    collection: vi.fn(() => ({
      find: vi.fn(() => ({
        sort: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn(() => Promise.resolve([])),
            async *[Symbol.asyncIterator]() {
              // Empty iterator
            },
          })),
          async *[Symbol.asyncIterator]() {
            // Empty iterator
          },
        })),
      })),
    })),
  })),
});

describe("MongoDBSaver", () => {
  it("should set client metadata", async () => {
    const client = createMockClient();
    // eslint-disable-next-line no-new
    new MongoDBSaver({ client: client as unknown as MongoClient });
    expect(client.appendMetadata).toHaveBeenCalledWith({
      name: "langgraphjs_checkpoint_saver",
    });
  });

  describe("timestampOp", () => {
    it("should return empty object when enableTimestamps is not set", () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const op = (saver as any).timestampOp;
      expect(op).toEqual({});
    });

    it("should return $currentDate operator when enableTimestamps is true", () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
        enableTimestamps: true,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const op = (saver as any).timestampOp;
      expect(op).toEqual({ $currentDate: { upserted_at: true } });
    });
  });

  describe("filter validation", () => {
    it("should reject object values in filter to prevent MongoDB operator injection", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const config = { configurable: { thread_id: "test-thread" } };

      // Attempt to use MongoDB operator injection
      const maliciousFilter = {
        source: { $regex: ".*" }, // MongoDB operator injection attempt
      };

      const generator = saver.list(config, { filter: maliciousFilter });

      await expect(generator.next()).rejects.toThrow(
        'Invalid filter value for key "source": filter values must be primitives'
      );
    });

    it("should reject nested objects in filter", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const config = { configurable: { thread_id: "test-thread" } };

      const maliciousFilter = {
        metadata: { nested: "value" },
      };

      const generator = saver.list(config, { filter: maliciousFilter });

      await expect(generator.next()).rejects.toThrow(
        'Invalid filter value for key "metadata": filter values must be primitives'
      );
    });

    it("should allow primitive filter values", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const config = { configurable: { thread_id: "test-thread" } };

      // Valid primitive filters
      const validFilter = {
        source: "input",
        step: 1,
        active: true,
        optional: null,
      };

      const generator = saver.list(config, { filter: validFilter });

      // Should not throw - will return empty since mock returns no results
      const result = await generator.next();
      expect(result.done).toBe(true);
    });
  });

  describe("configurable scalar validation", () => {
    it("should reject MongoDB operator object as thread_id in getTuple", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const maliciousConfig = {
        configurable: {
          thread_id: { $gt: "" },
          checkpoint_ns: { $ne: null },
        },
      };

      await expect(saver.getTuple(maliciousConfig)).rejects.toThrow(
        "Invalid configurable.thread_id: must be a primitive"
      );
    });

    it("should reject object checkpoint_id in getTuple", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const maliciousConfig = {
        configurable: {
          thread_id: "user-A",
          checkpoint_id: { $gt: "" },
        },
      };

      await expect(saver.getTuple(maliciousConfig)).rejects.toThrow(
        "Invalid configurable.checkpoint_id: must be a primitive"
      );
    });

    it("should accept primitive thread_id in getTuple", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const config = { configurable: { thread_id: "test-thread" } };

      const result = await saver.getTuple(config);
      // Mock returns no results, so undefined is expected
      expect(result).toBeUndefined();
    });

    it("should reject object thread_id in list", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const maliciousConfig = {
        configurable: { thread_id: { $gt: "" } },
      };

      const generator = saver.list(maliciousConfig);

      await expect(generator.next()).rejects.toThrow(
        "Invalid configurable.thread_id: must be a primitive"
      );
    });

    it("should reject object checkpoint_id in before option of list", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const config = { configurable: { thread_id: "test-thread" } };
      const before = {
        configurable: { checkpoint_id: { $gt: "" } },
      };

      const generator = saver.list(config, { before });

      await expect(generator.next()).rejects.toThrow(
        "Invalid configurable.checkpoint_id: must be a primitive"
      );
    });

    it("should reject object thread_id in put", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const maliciousConfig = {
        configurable: { thread_id: { $gt: "" } },
      };

      await expect(
        saver.put(
          maliciousConfig,
          {
            v: 1,
            id: "checkpoint-1",
            ts: new Date().toISOString(),
            channel_values: {},
            channel_versions: {},
            versions_seen: {},
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {} as any
        )
      ).rejects.toThrow(
        "Invalid configurable.thread_id: must be a primitive"
      );
    });

    it("should reject object thread_id in putWrites", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const maliciousConfig = {
        configurable: {
          thread_id: { $gt: "" },
          checkpoint_ns: "",
          checkpoint_id: "checkpoint-1",
        },
      };

      await expect(
        saver.putWrites(maliciousConfig, [["channel", "value"]], "task-1")
      ).rejects.toThrow(
        "Invalid configurable.thread_id: must be a primitive"
      );
    });
  });
});
