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

  /**
   * NoSQL-injection guard for top-level identifiers.
   *
   * The pre-existing `filter` validator (above) blocks operator injection
   * through `metadata.*` keys but did not cover `thread_id`,
   * `checkpoint_ns`, `checkpoint_id`, or `task_id`. Those four identifiers
   * actually drive the primary keys of every query. A caller that can shape
   * those values (multi-tenant SDK deployments where config originates from
   * request input, webhook bodies that flow into a persisted thread, etc.)
   * could promote a string field into an operator expression such as
   * `{ $ne: null }` or `{ $gt: "" }` and read or overwrite checkpoints
   * belonging to other tenants.
   *
   * Each test below picks one method × one identifier × one shape of bad
   * value, and asserts that the saver rejects it before issuing the query.
   */
  describe("identifier validation (NoSQL injection guard)", () => {
    const NOSQL_OPERATOR = { $ne: null };

    it("getTuple rejects an object thread_id (operator-injection attempt)", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.getTuple({
          configurable: {
            thread_id: NOSQL_OPERATOR,
            checkpoint_ns: "",
          },
        })
      ).rejects.toThrow(
        /Invalid configurable value for key "thread_id".*NoSQL operator injection/
      );
    });

    it("getTuple rejects an object checkpoint_ns", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.getTuple({
          configurable: {
            thread_id: "t",
            checkpoint_ns: NOSQL_OPERATOR,
          },
        })
      ).rejects.toThrow(
        /Invalid configurable value for key "checkpoint_ns"/
      );
    });

    it("getTuple rejects an object checkpoint_id", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.getTuple({
          configurable: {
            thread_id: "t",
            checkpoint_ns: "",
            checkpoint_id: NOSQL_OPERATOR,
          },
        })
      ).rejects.toThrow(
        /Invalid configurable value for key "checkpoint_id"/
      );
    });

    it("getTuple rejects a non-string primitive (number) thread_id", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.getTuple({
          configurable: {
            thread_id: 42,
            checkpoint_ns: "",
          },
        })
      ).rejects.toThrow(/got number/);
    });

    it("getTuple rejects an array thread_id (regression for typeof-only checks)", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.getTuple({
          configurable: {
            thread_id: ["t"],
            checkpoint_ns: "",
          },
        })
      ).rejects.toThrow(/got array/);
    });

    it("getTuple rejects null thread_id with a precise diagnostic", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.getTuple({
          configurable: {
            thread_id: null,
            checkpoint_ns: "",
          },
        })
      ).rejects.toThrow(/got null/);
    });

    it("getTuple accepts the empty-string checkpoint_ns (the documented default)", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      // Valid identifiers must pass through; mock returns no rows, so the
      // call resolves to undefined rather than throwing.
      await expect(
        saver.getTuple({
          configurable: { thread_id: "t", checkpoint_ns: "" },
        })
      ).resolves.toBeUndefined();
    });

    it("list rejects an object thread_id", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const generator = saver.list({
        configurable: { thread_id: NOSQL_OPERATOR },
      });

      await expect(generator.next()).rejects.toThrow(
        /Invalid configurable value for key "thread_id"/
      );
    });

    it("list rejects an object checkpoint_ns", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const generator = saver.list({
        configurable: {
          thread_id: "t",
          checkpoint_ns: NOSQL_OPERATOR,
        },
      });

      await expect(generator.next()).rejects.toThrow(
        /Invalid configurable value for key "checkpoint_ns"/
      );
    });

    it("list rejects an object checkpoint_id in the `before` cursor", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const generator = saver.list(
        { configurable: { thread_id: "t" } },
        {
          before: {
            configurable: { checkpoint_id: NOSQL_OPERATOR },
          },
        }
      );

      await expect(generator.next()).rejects.toThrow(
        /Invalid configurable value for key "checkpoint_id"/
      );
    });

    it("put rejects an object thread_id", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.put(
          {
            configurable: {
              thread_id: NOSQL_OPERATOR,
              checkpoint_ns: "",
            },
          },
          {
            // Minimal Checkpoint-shaped object; the validator runs before
            // anything tries to read other fields.
            id: "cp-1",
            v: 4,
            ts: new Date().toISOString(),
            channel_values: {},
            channel_versions: {},
            versions_seen: {},
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          {} as never
        )
      ).rejects.toThrow(
        /Invalid configurable value for key "thread_id"/
      );
    });

    it("put rejects an object parent_checkpoint_id", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.put(
          {
            configurable: {
              thread_id: "t",
              checkpoint_ns: "",
              checkpoint_id: NOSQL_OPERATOR, // becomes parent_checkpoint_id
            },
          },
          {
            id: "cp-2",
            v: 4,
            ts: new Date().toISOString(),
            channel_values: {},
            channel_versions: {},
            versions_seen: {},
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          {} as never
        )
      ).rejects.toThrow(
        /Invalid configurable value for key "parent_checkpoint_id"/
      );
    });

    it("putWrites rejects an object thread_id", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.putWrites(
          {
            configurable: {
              thread_id: NOSQL_OPERATOR,
              checkpoint_ns: "",
              checkpoint_id: "cp-1",
            },
          },
          [],
          "task-1"
        )
      ).rejects.toThrow(
        /Invalid configurable value for key "thread_id"/
      );
    });

    it("putWrites rejects an object task_id (covers caller-supplied identifier)", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        saver.putWrites(
          {
            configurable: {
              thread_id: "t",
              checkpoint_ns: "",
              checkpoint_id: "cp-1",
            },
          },
          [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          NOSQL_OPERATOR as any
        )
      ).rejects.toThrow(
        /Invalid configurable value for key "task_id"/
      );
    });

    it("deleteThread rejects an object thread_id", async () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        saver.deleteThread(NOSQL_OPERATOR as any)
      ).rejects.toThrow(
        /Invalid configurable value for key "thread_id"/
      );
    });

    it("the existing filter-injection guard is still active", async () => {
      // Regression test: the new top-level guard must not have shadowed or
      // weakened the pre-existing `metadata.*` filter validation.
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const generator = saver.list(
        { configurable: { thread_id: "t" } },
        { filter: { source: { $regex: ".*" } } }
      );

      await expect(generator.next()).rejects.toThrow(
        /Invalid filter value for key "source"/
      );
    });
  });
});
