import { MongoDBStore } from "../store";
import type {
  PutOperation,
  SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import { beforeEach, describe, it, expect, vi } from "vitest";

// Mock serde
const createMockSerde = (): SerializerProtocol => {
  return {
    dumpsTyped: vi.fn(async (obj: any) => {
      const buffer = Buffer.from(JSON.stringify(obj));
      return [
        "application/json",
        buffer as unknown as Uint8Array,
      ] as const as [string, Uint8Array];
    }),
    loadsTyped: vi.fn(async (_type: string, data: any) => {
      if (typeof data === "string") {
        return JSON.parse(data);
      }
      return JSON.parse(data.toString());
    }),
  } as SerializerProtocol;
};

describe("MongoDBStore", () => {
  let store: MongoDBStore;
  let mockClient: any;
  let mockDb: any;
  let mockCollection: any;
  let mockSerde: SerializerProtocol;

  beforeEach(() => {
    // Create mocks and link them so they're consistent
    const createFindCursor = () => ({
      project: vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      })),
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
    mockSerde = createMockSerde();

    store = new MongoDBStore(
      {
        client: mockClient as any,
        dbName: "test",
        collectionName: "store",
        enableTimestamps: false,
      },
      mockSerde
    );
  });

  describe("Put operation", () => {
    it("should upsert a document with serialized value", async () => {
      const operation: PutOperation = {
        namespace: ["documents", "user123"],
        key: "doc1",
        value: { title: "Test", content: "Hello" },
      };

      await store.batch([operation]);

      expect(mockCollection.bulkWrite).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            updateOne: expect.objectContaining({
              filter: { namespace: ["documents", "user123"], key: "doc1" },
              update: expect.objectContaining({
                $set: expect.objectContaining({
                  namespace: ["documents", "user123"],
                  key: "doc1",
                  type: "application/json",
                }),
              }),
              upsert: true,
            }),
          }),
        ])
      );
    });

    it("should throw InvalidNamespaceError for empty namespace", async () => {
      const operation: PutOperation = {
        namespace: [],
        key: "doc1",
        value: { title: "Test" },
      };

      await expect(store.batch([operation])).rejects.toThrow(
        "Namespace cannot be empty"
      );
    });

    it("should throw InvalidNamespaceError for namespace with periods", async () => {
      const operation: PutOperation = {
        namespace: ["documents.invalid"],
        key: "doc1",
        value: { title: "Test" },
      };

      await expect(store.batch([operation])).rejects.toThrow(
        "Namespace labels cannot contain periods"
      );
    });

    it("should throw InvalidNamespaceError for 'langgraph' root label", async () => {
      const operation: PutOperation = {
        namespace: ["langgraph", "data"],
        key: "doc1",
        value: { title: "Test" },
      };

      await expect(store.batch([operation])).rejects.toThrow(
        'Root label for namespace cannot be "langgraph"'
      );
    });

    it("should delete document when value is null", async () => {
      const operation: PutOperation = {
        namespace: ["documents", "user123"],
        key: "doc1",
        value: null,
      };

      await store.batch([operation]);

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

    it("should skip embedding when index is false", async () => {
      const operation: PutOperation = {
        namespace: ["documents"],
        key: "doc1",
        value: { title: "Test" },
        index: false,
      };

      await store.batch([operation]);

      // The bulk write should be called, and embedding should not be present
      expect(mockCollection.bulkWrite).toHaveBeenCalled();
      // Verify no embedDocuments was called (embeddings not configured in this test anyway)
    });

    it("should embed only specified fields when index is array", async () => {
      // Create a store with embeddings
      const storeWithEmbeddings = new MongoDBStore(
        {
          client: mockClient,
          dbName: "test",
          collectionName: "store",
          enableTimestamps: false,
          embeddings: {
            embedQuery: vi
              .fn()
              .mockResolvedValue([0.1, 0.2, 0.3]),
            embedDocuments: vi
              .fn()
              .mockResolvedValue([[0.1, 0.2, 0.3]]),
          } as any,
        },
        mockSerde
      );

      const operation: PutOperation = {
        namespace: ["documents"],
        key: "doc1",
        value: { title: "Test", secret: "hidden", content: "body" },
        index: ["title", "content"], // Only embed title and content
      };

      await storeWithEmbeddings.batch([operation]);

      // Should have called embedDocuments with only the indexed fields
      expect(mockCollection.bulkWrite).toHaveBeenCalled();
    });
  });

  describe("Get operation", () => {
    it("should return null if document not found", async () => {
      const operation = {
        namespace: ["documents"],
        key: "nonexistent",
      };

      mockCollection.findOne.mockResolvedValueOnce(null);
      const results = await store.batch([operation]);

      expect(results[0]).toBeNull();
    });

    it("should deserialize and return item", async () => {
      const operation = {
        namespace: ["documents"],
        key: "doc1",
      };

      const now = new Date();
      mockCollection.findOne.mockResolvedValueOnce({
        namespace: ["documents"],
        key: "doc1",
        value: Buffer.from(JSON.stringify({ title: "Test" })),
        type: "application/json",
        createdAt: now,
        updatedAt: now,
      });

      const results = await store.batch([operation]);
      const item = results[0];

      expect(item).toEqual({
        namespace: ["documents"],
        key: "doc1",
        value: { title: "Test" },
        createdAt: now,
        updatedAt: now,
      });
    });
  });

  describe("ListNamespaces operation", () => {
    it("should return empty array if no documents exist", async () => {
      const operation = {
        limit: 100,
        offset: 0,
      };

      // Set up the aggregate chain properly
      const aggregateMock = vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      }));
      mockCollection.aggregate = aggregateMock;

      const results = await store.batch([operation]);

      expect(results[0]).toEqual([]);
    });

    it("should return unique namespaces from documents", async () => {
      const operation = {
        limit: 100,
        offset: 0,
      };

      // Set up the aggregate chain to return test data
      const aggregateMock = vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([
          { _id: ["documents"] },
          { _id: ["users"] },
          { _id: ["documents", "v1"] },
        ]),
      }));
      mockCollection.aggregate = aggregateMock;

      const results = await store.batch([operation]);

      expect(results[0]).toEqual([
        ["documents"],
        ["users"],
        ["documents", "v1"],
      ]);
    });

    it("should apply limit and offset", async () => {
      const operation = {
        limit: 2,
        offset: 1,
      };

      // Set up the aggregate chain to return test data
      const aggregateMock = vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([
          { _id: ["b"] },
          { _id: ["c"] },
        ]),
      }));
      mockCollection.aggregate = aggregateMock;

      const results = await store.batch([operation]);

      expect(results[0]).toEqual([["b"], ["c"]]);
    });
  });

  describe("Search operation", () => {
    it("should return empty array if no documents match filter", async () => {
      const operation = {
        namespacePrefix: ["users"],
        filter: { status: "inactive" },
        limit: 100,
        offset: 0,
      };

      const findMock = vi.fn(() => ({
        skip: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue([]),
          })),
        })),
      }));
      mockCollection.find = findMock;

      const results = await store.batch([operation]);

      expect(results[0]).toEqual([]);
    });

    it("should search with exact match filter", async () => {
      const operation = {
        namespacePrefix: ["users"],
        filter: { status: "active" },
        limit: 100,
        offset: 0,
      };

      const now = new Date();
      const mockDoc = {
        namespace: ["users"],
        key: "user1",
        value: Buffer.from(JSON.stringify({ status: "active", name: "Alice" })),
        type: "application/json",
        createdAt: now,
        updatedAt: now,
      };

      const findMock = vi.fn(() => ({
        skip: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue([mockDoc]),
          })),
        })),
      }));
      mockCollection.find = findMock;

      const results = await store.batch([operation]);
      const items = results[0] as any[];

      expect(items).toHaveLength(1);
      expect(items[0].value).toEqual({ status: "active", name: "Alice" });
    });

    it("should search with comparison operators", async () => {
      const operation = {
        namespacePrefix: ["products"],
        filter: { price: { $gt: 100 } },
        limit: 100,
        offset: 0,
      };

      const now = new Date();
      const mockDocs = [
        {
          namespace: ["products"],
          key: "product1",
          value: Buffer.from(JSON.stringify({ price: 150, name: "Premium" })),
          type: "application/json",
          createdAt: now,
          updatedAt: now,
        },
        {
          namespace: ["products"],
          key: "product2",
          value: Buffer.from(JSON.stringify({ price: 200, name: "Luxury" })),
          type: "application/json",
          createdAt: now,
          updatedAt: now,
        },
      ];

      const findMock = vi.fn(() => ({
        skip: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue(mockDocs),
          })),
        })),
      }));
      mockCollection.find = findMock;

      const results = await store.batch([operation]);
      const items = results[0] as any[];

      expect(items).toHaveLength(2);
      expect(items[0].value.price).toBeGreaterThan(100);
    });

    it("should filter by namespace prefix", async () => {
      const operation = {
        namespacePrefix: ["users", "profiles"],
        filter: {},
        limit: 100,
        offset: 0,
      };

      const now = new Date();
      const mockDoc = {
        namespace: ["users", "profiles"],
        key: "profile1",
        value: Buffer.from(JSON.stringify({ bio: "Engineer" })),
        type: "application/json",
        createdAt: now,
        updatedAt: now,
      };

      const findMock = vi.fn(() => ({
        skip: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue([mockDoc]),
          })),
        })),
      }));
      mockCollection.find = findMock;

      const results = await store.batch([operation]);
      const items = results[0] as any[];

      expect(items).toHaveLength(1);
      expect(items[0].namespace).toEqual(["users", "profiles"]);
    });

    it("should apply limit and offset to search results", async () => {
      const operation = {
        namespacePrefix: [],
        filter: { active: true },
        limit: 2,
        offset: 1,
      };

      const now = new Date();
      const mockItems = [
        {
          namespace: ["docs"],
          key: "doc2",
          value: Buffer.from(JSON.stringify({ active: true })),
          type: "application/json",
          createdAt: now,
          updatedAt: now,
        },
        {
          namespace: ["docs"],
          key: "doc3",
          value: Buffer.from(JSON.stringify({ active: true })),
          type: "application/json",
          createdAt: now,
          updatedAt: now,
        },
      ];

      const findMock = vi.fn(() => ({
        skip: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue(mockItems),
          })),
        })),
      }));
      mockCollection.find = findMock;

      const results = await store.batch([operation]);
      const items = results[0] as any[];

      expect(items).toHaveLength(2);
      expect(items[0].key).toBe("doc2");
    });

    it("should combine namespace prefix and filter", async () => {
      const operation = {
        namespacePrefix: ["articles"],
        filter: { category: "tech", published: true },
        limit: 100,
        offset: 0,
      };

      const now = new Date();
      const mockDoc = {
        namespace: ["articles"],
        key: "article1",
        value: Buffer.from(JSON.stringify({ category: "tech", published: true })),
        type: "application/json",
        createdAt: now,
        updatedAt: now,
      };

      const findMock = vi.fn(() => ({
        skip: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue([mockDoc]),
          })),
        })),
      }));
      mockCollection.find = findMock;

      const results = await store.batch([operation]);
      const items = results[0] as any[];

      expect(items).toHaveLength(1);
      expect(items[0].value).toEqual({ category: "tech", published: true });
    });

    it("should support multiple comparison operators", async () => {
      const operation = {
        namespacePrefix: ["events"],
        filter: {
          date: { $gte: "2024-01-01" },
          count: { $lte: 100 }
        },
        limit: 100,
        offset: 0,
      };

      const now = new Date();
      const mockDoc = {
        namespace: ["events"],
        key: "event1",
        value: Buffer.from(JSON.stringify({ date: "2024-06-01", count: 50 })),
        type: "application/json",
        createdAt: now,
        updatedAt: now,
      };

      const findMock = vi.fn(() => ({
        skip: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue([mockDoc]),
          })),
        })),
      }));
      mockCollection.find = findMock;

      const results = await store.batch([operation]);
      const items = results[0] as any[];

      expect(items).toHaveLength(1);
    });
  });
});