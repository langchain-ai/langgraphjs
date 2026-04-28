import { MongoDBStore } from "../store";
import type { PutOperation } from "@langchain/langgraph-checkpoint";
import { beforeEach, describe, it, expect, vi } from "vitest";

describe("MongoDBStore", () => {
  let store: MongoDBStore;
  let mockClient: any;
  let mockDb: any;
  let mockCollection: any;

  beforeEach(() => {
    const createFindCursor = () => ({
      skip: vi.fn(() => ({
        limit: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([]),
        })),
      })),
      toArray: vi.fn().mockResolvedValue([]),
    });

    const collectionMock = {
      updateOne: vi.fn().mockResolvedValue({ ok: 1 }),
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn(() => createFindCursor()),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      createIndex: vi.fn().mockResolvedValue("namespace_1_key_1"),
      aggregate: vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      })),
      bulkWrite: vi.fn().mockResolvedValue({ ok: 1 }),
    };

    mockDb = {
      collection: vi.fn(() => collectionMock),
    };

    mockClient = {
      appendMetadata: vi.fn(),
      db: vi.fn(() => mockDb),
    };

    mockCollection = collectionMock;

    store = new MongoDBStore({
      client: mockClient as any,
      dbName: "test",
      collectionName: "store",
    });
  });

  describe("put", () => {
    it("should upsert a document", async () => {
      await store.batch([{
        namespace: ["documents", "user123"],
        key: "doc1",
        value: { title: "Test", content: "Hello" },
      } as PutOperation]);

      expect(mockCollection.bulkWrite).toHaveBeenCalled();
      const calls = mockCollection.bulkWrite.mock.calls[0][0];
      expect(calls).toHaveLength(1);
      const { updateOne } = calls[0];
      expect(updateOne.filter).toEqual({
        namespace: ["documents", "user123"],
        key: "doc1",
      });
      expect(updateOne.update.$set.value).toEqual({ title: "Test", content: "Hello" });
      expect(updateOne.upsert).toBe(true);
    });

    it("should delete document when value is null", async () => {
      await store.batch([{
        namespace: ["documents", "user123"],
        key: "doc1",
        value: null,
      } as PutOperation]);

      expect(mockCollection.bulkWrite).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            deleteOne: expect.objectContaining({
              filter: { namespace: ["documents", "user123"], key: "doc1" },
            }),
          }),
        ])
      );
    });

    it("should throw InvalidNamespaceError for empty namespace", async () => {
      await expect(
        store.batch([{ namespace: [], key: "doc1", value: { title: "Test" } } as PutOperation])
      ).rejects.toThrow("Namespace cannot be empty");
    });

    it("should throw InvalidNamespaceError for namespace with periods", async () => {
      await expect(
        store.batch([{ namespace: ["docs.invalid"], key: "doc1", value: { title: "Test" } } as PutOperation])
      ).rejects.toThrow("Namespace labels cannot contain periods");
    });

    it("should throw InvalidNamespaceError for 'langgraph' root label", async () => {
      await expect(
        store.batch([{ namespace: ["langgraph", "data"], key: "doc1", value: { title: "Test" } } as PutOperation])
      ).rejects.toThrow('Root label for namespace cannot be "langgraph"');
    });
  });

  describe("get", () => {
    it("should return null if document not found", async () => {
      mockCollection.findOne.mockResolvedValueOnce(null);
      const results = await store.batch([{ namespace: ["documents"], key: "missing" }]);
      expect(results[0]).toBeNull();
    });

    it("should return item with value, key, namespace, and timestamps", async () => {
      const now = new Date();
      mockCollection.findOne.mockResolvedValueOnce({
        namespace: ["documents"], key: "doc1", value: { title: "Test" },
        createdAt: now, updatedAt: now,
      });

      const results = await store.batch([{ namespace: ["documents"], key: "doc1" }]);
      expect(results[0]).toEqual({
        namespace: ["documents"], key: "doc1", value: { title: "Test" },
        createdAt: now, updatedAt: now,
      });
    });
  });

  describe("search", () => {
    it("should build prefix query using dot-notation", async () => {
      const findMock = vi.fn(() => ({
        skip: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue([]),
          })),
        })),
      }));
      mockCollection.find = findMock;

      await store.batch([
        { namespacePrefix: ["users", "profiles"], filter: {}, limit: 10, offset: 0 },
      ]);

      expect(findMock.mock.calls[0][0]).toEqual({
        "namespace.0": "users",
        "namespace.1": "profiles",
      });
    });

    it("should throw when query is provided without indexConfig", async () => {
      await expect(
        store.batch([{ namespacePrefix: ["docs"], query: "find something", limit: 10, offset: 0 }])
      ).rejects.toThrow(/indexConfig/i);
    });
  });

  describe("listNamespaces", () => {
    it("should return empty array if no documents exist", async () => {
      mockCollection.aggregate = vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      }));

      const results = await store.batch([{ limit: 100, offset: 0 }]);
      expect(results[0]).toEqual([]);
    });

    it("should build prefix matchCondition pipeline", async () => {
      const capturedPipelines: any[][] = [];
      mockCollection.aggregate = vi.fn((pipeline: any[]) => {
        capturedPipelines.push(pipeline);
        return { toArray: vi.fn().mockResolvedValue([]) };
      });

      await store.batch([{
        matchConditions: [{ matchType: "prefix" as const, path: ["users"] }],
        limit: 100, offset: 0,
      }]);

      const matchStage = capturedPipelines[0].find((s: any) => s.$match);
      expect(matchStage).toEqual({
        $match: {
          $expr: {
            $and: [
              { $eq: [{ $arrayElemAt: ["$namespace", 0] }, "users"] },
              { $gte: [{ $size: "$namespace" }, 1] },
            ],
          },
        },
      });
    });

    it("should build suffix matchCondition pipeline", async () => {
      const capturedPipelines: any[][] = [];
      mockCollection.aggregate = vi.fn((pipeline: any[]) => {
        capturedPipelines.push(pipeline);
        return { toArray: vi.fn().mockResolvedValue([]) };
      });

      await store.batch([{
        matchConditions: [{ matchType: "suffix" as const, path: ["v1"] }],
        limit: 100, offset: 0,
      }]);

      const matchStage = capturedPipelines[0].find((s: any) => s.$match);
      expect(matchStage).toEqual({
        $match: {
          $expr: {
            $and: [
              { $eq: [{ $arrayElemAt: ["$namespace", -1] }, "v1"] },
              { $gte: [{ $size: "$namespace" }, 1] },
            ],
          },
        },
      });
    });

    it("should skip wildcard positions in matchCondition pipeline", async () => {
      const capturedPipelines: any[][] = [];
      mockCollection.aggregate = vi.fn((pipeline: any[]) => {
        capturedPipelines.push(pipeline);
        return { toArray: vi.fn().mockResolvedValue([]) };
      });

      await store.batch([{
        matchConditions: [{ matchType: "prefix" as const, path: ["users", "*", "settings"] }],
        limit: 100, offset: 0,
      }]);

      const matchStage = capturedPipelines[0].find((s: any) => s.$match);
      expect(matchStage).toEqual({
        $match: {
          $expr: {
            $and: [
              { $eq: [{ $arrayElemAt: ["$namespace", 0] }, "users"] },
              { $eq: [{ $arrayElemAt: ["$namespace", 2] }, "settings"] },
              { $gte: [{ $size: "$namespace" }, 3] },
            ],
          },
        },
      });
    });
  });

  describe("batch", () => {
    it("should execute mixed operations in one batch", async () => {
      const now = new Date();
      mockCollection.findOne.mockResolvedValueOnce({
        namespace: ["batch"], key: "item1", value: { num: 1 },
        createdAt: now, updatedAt: now,
      });

      const results = await store.batch([
        { namespace: ["batch"], key: "item1", value: { num: 1 } } as PutOperation,
        { namespace: ["batch"], key: "item2", value: { num: 2 } } as PutOperation,
        { namespace: ["batch"], key: "item1" },
      ]);

      expect(results[0]).toBeUndefined();
      expect(results[1]).toBeUndefined();
      expect(results[2]?.value).toEqual({ num: 1 });
    });
  });

  describe("vector search", () => {
    it("should store embeddings on put in manual mode", async () => {
      const embedDocuments = vi.fn().mockResolvedValue([[0.1, 0.2]]);
      const storeWithEmbeddings = new MongoDBStore({
        client: mockClient as any,
        dbName: "test",
        collectionName: "store",
        embeddings: { embedQuery: vi.fn().mockResolvedValue([0.1, 0.2]), embedDocuments } as any,
        indexConfig: { name: "test_index", dims: 2 },
      });

      await storeWithEmbeddings.batch([{
        namespace: ["memories", "alice"],
        key: "mem1",
        value: { text: "hello world" },
      } as PutOperation]);

      expect(embedDocuments).toHaveBeenCalledWith([JSON.stringify({ text: "hello world" })]);
      const calls = mockCollection.bulkWrite.mock.calls[0][0];
      const doc = calls[0].updateOne.update.$set;
      expect(doc.embedding).toEqual([0.1, 0.2]);
      expect(doc.namespacePath).toEqual(["memories", "memories/alice"]);
    });

    it("should not write embedding field on put in auto mode", async () => {
      const storeAuto = new MongoDBStore({
        client: mockClient as any,
        dbName: "test",
        collectionName: "store",
        indexConfig: { name: "test_index", model: "voyage-4", path: "value.content" },
      });

      await storeAuto.batch([{
        namespace: ["memories", "alice"],
        key: "mem1",
        value: { content: "hello world" },
      } as PutOperation]);

      const calls = mockCollection.bulkWrite.mock.calls[0][0];
      const doc = calls[0].updateOne.update.$set;
      // Auto mode: no embedding field written, MongoDB reads value.content directly
      expect(doc.embedding).toBeUndefined();
      expect(doc.value).toEqual({ content: "hello world" });
      expect(doc.namespacePath).toEqual(["memories", "memories/alice"]);
    });

    it("should skip embedding when op.index is false", async () => {
      const embedDocuments = vi.fn().mockResolvedValue([]);
      const storeWithEmbeddings = new MongoDBStore({
        client: mockClient as any,
        dbName: "test",
        collectionName: "store",
        embeddings: { embedQuery: vi.fn(), embedDocuments } as any,
        indexConfig: { name: "test_index", dims: 2 },
      });

      await storeWithEmbeddings.batch([{
        namespace: ["memories", "alice"],
        key: "mem1",
        value: { text: "hello world" },
        index: false,
      } as PutOperation]);

      expect(embedDocuments).not.toHaveBeenCalled();
      const calls = mockCollection.bulkWrite.mock.calls[0][0];
      const doc = calls[0].updateOne.update.$set;
      expect(doc.embedding).toBeUndefined();
    });

    it("should use queryVector in manual mode search", async () => {
      const embedQuery = vi.fn().mockResolvedValue([0.1, 0.2]);
      const storeWithEmbeddings = new MongoDBStore({
        client: mockClient as any,
        dbName: "test",
        collectionName: "store",
        embeddings: { embedQuery, embedDocuments: vi.fn() } as any,
        indexConfig: { name: "test_index", dims: 2 },
      });

      const capturedPipelines: any[][] = [];
      mockCollection.aggregate = vi.fn((pipeline: any[]) => {
        capturedPipelines.push(pipeline);
        return { toArray: vi.fn().mockResolvedValue([]) };
      });

      await storeWithEmbeddings.batch([{
        namespacePrefix: ["memories"],
        query: "find something",
        limit: 10,
        offset: 0,
      }]);

      expect(embedQuery).toHaveBeenCalledWith("find something");
      const vectorSearchStage = capturedPipelines[0][0].$vectorSearch;
      expect(vectorSearchStage.queryVector).toEqual([0.1, 0.2]);
      expect(vectorSearchStage.query).toBeUndefined();
    });

    it("should use query.text in auto mode search", async () => {
      const storeAuto = new MongoDBStore({
        client: mockClient as any,
        dbName: "test",
        collectionName: "store",
        indexConfig: { name: "test_index", model: "voyage-4" },
      });

      const capturedPipelines: any[][] = [];
      mockCollection.aggregate = vi.fn((pipeline: any[]) => {
        capturedPipelines.push(pipeline);
        return { toArray: vi.fn().mockResolvedValue([]) };
      });

      await storeAuto.batch([{
        namespacePrefix: ["memories"],
        query: "find something",
        limit: 10,
        offset: 0,
      }]);

      const vectorSearchStage = capturedPipelines[0][0].$vectorSearch;
      expect(vectorSearchStage.query).toEqual({ text: "find something" });
      expect(vectorSearchStage.queryVector).toBeUndefined();
    });

    it("should include namespacePath filter in $vectorSearch", async () => {
      const storeAuto = new MongoDBStore({
        client: mockClient as any,
        dbName: "test",
        collectionName: "store",
        indexConfig: { name: "test_index", model: "voyage-4" },
      });

      const capturedPipelines: any[][] = [];
      mockCollection.aggregate = vi.fn((pipeline: any[]) => {
        capturedPipelines.push(pipeline);
        return { toArray: vi.fn().mockResolvedValue([]) };
      });

      await storeAuto.batch([{
        namespacePrefix: ["memories", "alice"],
        query: "find something",
        limit: 10,
        offset: 0,
      }]);

      const vectorSearchStage = capturedPipelines[0][0].$vectorSearch;
      expect(vectorSearchStage.filter).toEqual({ namespacePath: "memories/alice" });
    });

    it("should throw when query is provided without indexConfig", async () => {
      await expect(
        store.batch([{ namespacePrefix: ["docs"], query: "find something", limit: 10, offset: 0 }])
      ).rejects.toThrow(/indexConfig/i);
    });
  });
});
