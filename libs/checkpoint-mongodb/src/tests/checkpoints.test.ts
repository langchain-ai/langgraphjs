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

const asBinary = (value: unknown) => ({
  value: (encoding: string) => {
    expect(encoding).toBe("utf8");
    return JSON.stringify(value);
  },
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

  describe("TTL support", () => {
    it("should store ttl property when provided", () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
        ttl: 3600,
      });
      // Access protected property for testing
      expect((saver as unknown as { ttl: number }).ttl).toBe(3600);
    });

    it("should not have ttl when not provided", () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });
      expect((saver as unknown as { ttl?: number }).ttl).toBeUndefined();
    });

    it("should enable timestamps implicitly when ttl is provided", () => {
      const client = createMockClient();
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
        ttl: 3600,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const op = (saver as any).timestampOp;
      expect(op).toEqual({ $currentDate: { upserted_at: true } });
    });
  });

  describe("setup", () => {
    it("should create compound indexes on both collections", async () => {
      const createIndexMock = vi.fn().mockResolvedValue("ok");
      const collectionMock = vi.fn(() => ({
        createIndex: createIndexMock,
        find: vi.fn(() => ({
          sort: vi.fn(() => ({
            limit: vi.fn(() => ({
              toArray: vi.fn(() => Promise.resolve([])),
            })),
          })),
        })),
      }));
      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({ collection: collectionMock })),
      };
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const errors = await saver.setup();

      expect(errors).toEqual([]);
      expect(collectionMock).toHaveBeenCalledWith("checkpoints");
      expect(collectionMock).toHaveBeenCalledWith("checkpoint_writes");
      expect(createIndexMock).toHaveBeenCalledTimes(2);
      expect(createIndexMock).toHaveBeenCalledWith(
        { thread_id: 1, checkpoint_ns: 1, checkpoint_id: -1 },
        { name: "thread_ns_checkpoint_idx" }
      );
      expect(createIndexMock).toHaveBeenCalledWith(
        { thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1, task_id: 1, idx: 1 },
        { name: "thread_ns_checkpoint_task_idx" }
      );
    });

    it("should create TTL indexes in addition to compound indexes when ttl is configured", async () => {
      const mockCreateIndex = vi.fn().mockResolvedValue("ok");
      const mockCollection = vi.fn(() => ({
        createIndex: mockCreateIndex,
      }));
      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({
          collection: mockCollection,
        })),
      };

      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
        ttl: 3600,
      });

      await saver.setup();

      expect(mockCollection).toHaveBeenCalledWith("checkpoints");
      expect(mockCollection).toHaveBeenCalledWith("checkpoint_writes");
      // 2 compound indexes + 2 TTL indexes
      expect(mockCreateIndex).toHaveBeenCalledTimes(4);
      expect(mockCreateIndex).toHaveBeenCalledWith(
        { thread_id: 1, checkpoint_ns: 1, checkpoint_id: -1 },
        { name: "thread_ns_checkpoint_idx" }
      );
      expect(mockCreateIndex).toHaveBeenCalledWith(
        { upserted_at: 1 },
        { expireAfterSeconds: 3600 }
      );
    });

    it("should not create TTL indexes when ttl is not configured", async () => {
      const mockCreateIndex = vi.fn().mockResolvedValue("ok");
      const mockCollection = vi.fn(() => ({
        createIndex: mockCreateIndex,
      }));
      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({
          collection: mockCollection,
        })),
      };

      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      await saver.setup();

      // Only the 2 compound indexes, no TTL index.
      expect(mockCreateIndex).toHaveBeenCalledTimes(2);
      expect(mockCreateIndex).not.toHaveBeenCalledWith(
        { upserted_at: 1 },
        expect.anything()
      );
    });

    it("should return empty array on success", async () => {
      const mockCreateIndex = vi.fn().mockResolvedValue("ok");
      const mockCollection = vi.fn(() => ({
        createIndex: mockCreateIndex,
      }));
      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({
          collection: mockCollection,
        })),
      };

      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
        ttl: 3600,
      });

      const errors = await saver.setup();
      expect(errors).toEqual([]);
    });

    it("should return errors for caller to handle", async () => {
      const mockCreateIndex = vi
        .fn()
        .mockRejectedValue(new Error("Index creation failed"));
      const mockCollection = vi.fn(() => ({
        createIndex: mockCreateIndex,
      }));
      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({
          collection: mockCollection,
        })),
      };

      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
        ttl: 3600,
      });

      const errors = await saver.setup();
      // 2 compound + 2 TTL index creations all fail.
      expect(errors).toHaveLength(4);
      expect(errors[0].message).toBe("Index creation failed");
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

  describe("list pendingWrites", () => {
    it("should include pendingWrites in list() results", async () => {
      const checkpointDoc = {
        thread_id: "test-thread",
        checkpoint_ns: "",
        checkpoint_id: "cp-1",
        type: "json",
        checkpoint: asBinary({
          v: 4,
          id: "cp-1",
          ts: "2024-04-19T17:19:07.952Z",
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        }),
        metadata: asBinary({
          source: "input",
          step: 1,
          parents: {},
        }),
        parent_checkpoint_id: null,
      };

      const writeDoc = {
        task_id: "task-1",
        channel: "bar",
        type: "json",
        value: asBinary("baz"),
      };

      const writesFindMock = vi.fn(() => ({
        toArray: vi.fn(() => Promise.resolve([writeDoc])),
      }));

      const checkpointsFindMock = vi.fn(() => ({
        sort: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield checkpointDoc;
          },
        })),
      }));

      const collectionMock = vi.fn((name: string) => {
        if (name === "checkpoints") {
          return { find: checkpointsFindMock };
        }
        if (name === "checkpoint_writes") {
          return { find: writesFindMock };
        }
        throw new Error(`Unexpected collection: ${name}`);
      });

      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({
          collection: collectionMock,
        })),
      };

      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const generator = saver.list({
        configurable: { thread_id: "test-thread" },
      });
      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value?.pendingWrites).toEqual([["task-1", "bar", "baz"]]);
      expect(writesFindMock).toHaveBeenCalledWith({
        thread_id: "test-thread",
        checkpoint_ns: "",
        checkpoint_id: "cp-1",
      });

      const done = await generator.next();
      expect(done.done).toBe(true);
    });

    it("should return empty pendingWrites when none exist", async () => {
      const checkpointDoc = {
        thread_id: "test-thread",
        checkpoint_ns: "",
        checkpoint_id: "cp-1",
        type: "json",
        checkpoint: asBinary({
          v: 4,
          id: "cp-1",
          ts: "2024-04-19T17:19:07.952Z",
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        }),
        metadata: asBinary({
          source: "input",
          step: 1,
          parents: {},
        }),
        parent_checkpoint_id: null,
      };

      const writesFindMock = vi.fn(() => ({
        toArray: vi.fn(() => Promise.resolve([])),
      }));

      const checkpointsFindMock = vi.fn(() => ({
        sort: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield checkpointDoc;
          },
        })),
      }));

      const collectionMock = vi.fn((name: string) => {
        if (name === "checkpoints") {
          return { find: checkpointsFindMock };
        }
        if (name === "checkpoint_writes") {
          return { find: writesFindMock };
        }
        throw new Error(`Unexpected collection: ${name}`);
      });

      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({
          collection: collectionMock,
        })),
      };

      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });

      const generator = saver.list({
        configurable: { thread_id: "test-thread" },
      });
      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value?.pendingWrites).toEqual([]);
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

    it("should pin special channels to fixed negative indices and switch to $setOnInsert for regular writes", async () => {
      // Capture the bulkWrite operations so we can assert on their structure
      // without standing up a real MongoDB.
      const bulkWriteCalls: unknown[][] = [];
      const writesCollection = {
        find: vi.fn(() => ({
          sort: vi.fn(() => ({
            limit: vi.fn(() => ({
              toArray: vi.fn(() => Promise.resolve([])),
            })),
          })),
        })),
        bulkWrite: vi.fn((ops: unknown[]) => {
          bulkWriteCalls.push(ops);
          return Promise.resolve({});
        }),
      };
      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({
          collection: vi.fn(() => writesCollection),
        })),
      };
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });
      const config = {
        configurable: {
          thread_id: "t",
          checkpoint_ns: "",
          checkpoint_id: "c",
        },
      };

      // Mix of regular writes and a special-channel write in the same call.
      // Regular writes must NOT push the special-channel onto a positive idx.
      await saver.putWrites(
        config,
        [
          ["foo", "v_foo"],
          ["bar", "v_bar"],
          ["__interrupt__", "paused"],
        ],
        "task_A"
      );

      const ops = bulkWriteCalls[bulkWriteCalls.length - 1] as Array<{
        updateOne: {
          filter: { idx: number };
          update: Record<string, unknown>;
        };
      }>;
      const indices = ops.map((op) => op.updateOne.filter.idx).sort(
        (a, b) => a - b
      );
      // foo (idx 0), bar (idx 1), __interrupt__ (idx -3 via WRITES_IDX_MAP)
      expect(indices).toEqual([-3, 0, 1]);

      // Mixed batch must go through $setOnInsert so a peer task's row at
      // (task_A, idx=0) can't be silently overwritten.
      for (const op of ops) {
        expect(op.updateOne.update).toHaveProperty("$setOnInsert");
        expect(op.updateOne.update).not.toHaveProperty("$set");
      }

      // A separate call where every write is a special channel must go
      // through $set so e.g. INTERRUPT → RESUME state transitions overwrite.
      await saver.putWrites(
        config,
        [["__resume__", "carry_on"]],
        "task_A"
      );
      const specialOnly = bulkWriteCalls[bulkWriteCalls.length - 1] as Array<{
        updateOne: {
          filter: { idx: number };
          update: Record<string, unknown>;
        };
      }>;
      expect(specialOnly[0].updateOne.filter.idx).toBe(-4); // RESUME
      expect(specialOnly[0].updateOne.update).toHaveProperty("$set");
      expect(specialOnly[0].updateOne.update).not.toHaveProperty(
        "$setOnInsert"
      );
    });

    it("should no-op without calling bulkWrite when writes is empty", async () => {
      // Regression test: an empty `writes` array used to reach `bulkWrite([])`,
      // which the MongoDB driver rejects with "Invalid BulkOperation, Batch
      // cannot be empty" (hit by human-in-the-loop / interrupt() flows).
      const bulkWriteMock = vi.fn(() => Promise.resolve({}));
      const client = {
        appendMetadata: vi.fn(),
        db: vi.fn(() => ({
          collection: vi.fn(() => ({ bulkWrite: bulkWriteMock })),
        })),
      };
      const saver = new MongoDBSaver({
        client: client as unknown as MongoClient,
      });
      const config = {
        configurable: {
          thread_id: "t",
          checkpoint_ns: "",
          checkpoint_id: "c",
        },
      };

      await expect(
        saver.putWrites(config, [], "task_A")
      ).resolves.toBeUndefined();
      // Load-bearing assertion: before the fix, putWrites called bulkWrite([]).
      expect(bulkWriteMock).not.toHaveBeenCalled();
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
