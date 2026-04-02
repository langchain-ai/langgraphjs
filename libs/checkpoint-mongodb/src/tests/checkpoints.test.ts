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

  describe("list() pendingWrites", () => {
    it("should query checkpoint_writes and include pendingWrites in result", async () => {
      const mockCheckpointDoc = {
        thread_id: "thread-1",
        checkpoint_ns: "",
        checkpoint_id: "cp-1",
        parent_checkpoint_id: null,
        type: "json",
        checkpoint: { value: () => '{"v":1}' },
        metadata: { value: () => '{"source":"input"}' },
      };

      const mockWriteDoc = {
        task_id: "task-1",
        channel: "messages",
        type: "json",
        value: { value: () => '"hello"' },
      };

      const writesFind = vi.fn(() => ({
        toArray: vi.fn(() => Promise.resolve([mockWriteDoc])),
      }));

      const checkpointsFind = vi.fn(() => ({
        sort: vi.fn(() => ({
          limit: vi.fn(() => ({
            async *[Symbol.asyncIterator]() {
              yield mockCheckpointDoc;
            },
          })),
        })),
      }));

      const mockCollection = vi.fn((name: string) => {
        if (name === "checkpoint_writes") {
          return { find: writesFind };
        }
        return { find: checkpointsFind };
      });

      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({ collection: mockCollection })),
      };

      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const config = { configurable: { thread_id: "thread-1" } };
      const results: Array<{ pendingWrites?: unknown[] }> = [];
      for await (const tuple of saver.list(config, { limit: 1 })) {
        results.push(tuple);
      }

      expect(results).toHaveLength(1);
      expect(results[0].pendingWrites).toBeDefined();
      expect(results[0].pendingWrites).toHaveLength(1);
      expect(results[0].pendingWrites![0]).toEqual([
        "task-1",
        "messages",
        "hello",
      ]);

      expect(writesFind).toHaveBeenCalledWith({
        thread_id: "thread-1",
        checkpoint_ns: "",
        checkpoint_id: "cp-1",
      });
    });
  });

  describe("list() metadata filter uses metadata_search", () => {
    it("should query metadata_search instead of metadata", async () => {
      const findMock = vi.fn(() => ({
        sort: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            // Empty
          },
        })),
      }));

      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({
          collection: vi.fn(() => ({ find: findMock })),
        })),
      };

      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const config = { configurable: { thread_id: "thread-1" } };
      const generator = saver.list(config, {
        filter: { source: "input", step: 3 },
      });
      await generator.next();

      expect(findMock).toHaveBeenCalledWith(
        expect.objectContaining({
          "metadata_search.source": "input",
          "metadata_search.step": 3,
        })
      );
      expect(findMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          "metadata.source": expect.anything(),
        })
      );
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
});
