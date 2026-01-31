import { describe, it, expect, vi, beforeEach } from "vitest";
import { type MongoClient } from "mongodb";
import { MongoDBSaver } from "../index.js";

const createMockClient = () => ({
  appendMetadata: vi.fn(),
  db: vi.fn(() => ({
    collection: vi.fn(() => ({
      createIndex: vi.fn().mockResolvedValue("upserted_at_1"),
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

    it("setup() should create TTL indexes when ttl is configured", async () => {
      const mockCreateIndex = vi.fn().mockResolvedValue("upserted_at_1");
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
      expect(mockCreateIndex).toHaveBeenCalledTimes(2);
      expect(mockCreateIndex).toHaveBeenCalledWith(
        { upserted_at: 1 },
        { expireAfterSeconds: 3600 }
      );
    });

    it("setup() should not create indexes when ttl is not configured", async () => {
      const mockCreateIndex = vi.fn().mockResolvedValue("upserted_at_1");
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

      expect(mockCreateIndex).not.toHaveBeenCalled();
    });

    it("setup() should return empty array on success", async () => {
      const mockCreateIndex = vi.fn().mockResolvedValue("upserted_at_1");
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

    it("setup() should return errors for caller to handle", async () => {
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
      expect(errors).toHaveLength(2);
      expect(errors[0].message).toBe("Index creation failed");
    });
  });
});
