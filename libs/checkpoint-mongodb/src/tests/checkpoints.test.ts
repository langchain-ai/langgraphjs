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

  describe("metadata filtering", () => {
    const createCapturingMockClient = () => {
      const findMock = vi.fn(() => ({
        sort: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            // Empty iterator
          },
        })),
      }));
      const updateOneMock = vi.fn().mockResolvedValue({ acknowledged: true });

      const collectionMock = {
        find: findMock,
        updateOne: updateOneMock,
      };

      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({
          collection: vi.fn(() => collectionMock),
        })),
      };

      return { client, findMock, updateOneMock };
    };

    it("should store metadata_search as plain JSON in put()", async () => {
      const { client, updateOneMock } = createCapturingMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const checkpoint = {
        v: 4,
        id: "cp-1",
        ts: "2024-04-19T17:19:07.952Z",
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      };
      const metadata = {
        source: "input" as const,
        step: 1,
        parents: {},
      };

      await saver.put(
        { configurable: { thread_id: "test-thread" } },
        checkpoint,
        metadata
      );

      expect(updateOneMock).toHaveBeenCalledWith(
        {
          thread_id: "test-thread",
          checkpoint_ns: "",
          checkpoint_id: "cp-1",
        },
        expect.objectContaining({
          $set: expect.objectContaining({
            metadata_search: metadata,
          }),
        }),
        { upsert: true }
      );

      const setDoc = updateOneMock.mock.calls[0][1].$set;
      expect(setDoc.metadata).toBeDefined();
      expect(setDoc.metadata).not.toEqual(metadata);
    });

    it("should query metadata_search fields in list()", async () => {
      const { client, findMock } = createCapturingMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const config = { configurable: { thread_id: "test-thread" } };
      const filter = {
        source: "input",
        step: 1,
        active: true,
        optional: null,
      };

      const generator = saver.list(config, { filter });
      await generator.next();

      expect(findMock).toHaveBeenCalledWith({
        thread_id: "test-thread",
        "metadata_search.source": "input",
        "metadata_search.step": 1,
        "metadata_search.active": true,
        "metadata_search.optional": null,
      });
    });
  });

  describe("configurable validation", () => {
    it("should return undefined when thread_id is missing in getTuple", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(saver.getTuple({ configurable: {} })).resolves.toBeUndefined();
    });

    it("should reject object thread_id in getTuple", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.getTuple({
          configurable: { thread_id: { $gt: "" }, checkpoint_ns: "" },
        } as never)
      ).rejects.toThrow('Invalid configurable.thread_id: expected a string');
    });

    it("should reject object checkpoint_ns in getTuple", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.getTuple({
          configurable: { thread_id: "safe-thread", checkpoint_ns: { $ne: null } },
        } as never)
      ).rejects.toThrow('Invalid configurable.checkpoint_ns: expected a string');
    });

    it("should reject object checkpoint_id in getTuple", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.getTuple({
          configurable: {
            thread_id: "safe-thread",
            checkpoint_ns: "",
            checkpoint_id: { $gt: "" },
          },
        } as never)
      ).rejects.toThrow('Invalid configurable.checkpoint_id: expected a string');
    });

    it("should reject object thread_id in list", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const generator = saver.list({
        configurable: { thread_id: { $gt: "" } },
      } as never);
      await expect(generator.next()).rejects.toThrow(
        'Invalid configurable.thread_id: expected a string'
      );
    });

    it("should reject object checkpoint_ns in list", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const generator = saver.list({
        configurable: { thread_id: "safe-thread", checkpoint_ns: { $ne: null } },
      } as never);
      await expect(generator.next()).rejects.toThrow(
        'Invalid configurable.checkpoint_ns: expected a string'
      );
    });

    it("should reject object before.checkpoint_id in list", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const generator = saver.list(
        { configurable: { thread_id: "safe-thread", checkpoint_ns: "" } },
        { before: { configurable: { checkpoint_id: { $lt: "zzz" } } } as never }
      );
      await expect(generator.next()).rejects.toThrow(
        'Invalid configurable.checkpoint_id: expected a string'
      );
    });

    it("should reject non-string thread_id in put", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });
      const checkpoint = {
        v: 4,
        id: "cp-1",
        ts: new Date().toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      } as never;

      await expect(
        saver.put(
          { configurable: { thread_id: { $gt: "" } } } as never,
          checkpoint,
          { source: "input", step: 1, parents: {} } as never
        )
      ).rejects.toThrow('Invalid configurable.thread_id: expected a string');
    });

    it("should reject non-string thread_id in putWrites", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.putWrites(
          {
            configurable: {
              thread_id: { $gt: "" },
              checkpoint_ns: "",
              checkpoint_id: "cp-1",
            },
          } as never,
          [["foo", "bar"]],
          "task-1"
        )
      ).rejects.toThrow('Invalid configurable.thread_id: expected a string');
    });

    it("should reject non-string checkpoint_ns in putWrites", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.putWrites(
          {
            configurable: {
              thread_id: "safe-thread",
              checkpoint_ns: { $ne: null },
              checkpoint_id: "cp-1",
            },
          } as never,
          [["foo", "bar"]],
          "task-1"
        )
      ).rejects.toThrow('Invalid configurable.checkpoint_ns: expected a string');
    });

    it("should reject non-string checkpoint_id in putWrites", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.putWrites(
          {
            configurable: {
              thread_id: "safe-thread",
              checkpoint_ns: "",
              checkpoint_id: { $gt: "" },
            },
          } as never,
          [["foo", "bar"]],
          "task-1"
        )
      ).rejects.toThrow('Invalid configurable.checkpoint_id: expected a string');
    });

    it("should reject non-string threadId in deleteThread", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(saver.deleteThread({} as never)).rejects.toThrow(
        "Invalid threadId: expected a string"
      );
    });
  });
});
