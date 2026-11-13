import { MongoClient } from "mongodb";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { MongoDBStore } from "../store.js";

describe("MongoDBStore factory cleanup", () => {
  const url = new URL(
    getEnvironmentVariable("MONGODB_URL") || "mongodb://localhost:27017"
  );
  url.username = "user";
  url.password = "password";
  const client = new MongoClient(url.toString());
  const collectionName = "factory_cleanup_store";
  const collection = client.db("langgraph_test").collection(collectionName);
  beforeAll(async () => {
    await client.connect();
    await collection.deleteMany({});
    // Duplicates make initialization's unique index fail after connecting.
    await collection.insertMany([
      { namespaceStr: "same", key: "same" },
      { namespaceStr: "same", key: "same" },
    ]);
  });
  afterAll(async () => {
    await collection.drop();
    await client.close();
  });
  it.each([false, true])(
    "closes the owned client if index creation fails (cleanup fails: %s)",
    async (cleanupFails) => {
      const connect = vi.spyOn(MongoClient.prototype, "connect");
      const originalClose = MongoClient.prototype.close;
      const close = vi
        .spyOn(MongoClient.prototype, "close")
        .mockImplementationOnce(async function (this: MongoClient) {
          await originalClose.call(this);
          if (cleanupFails) throw new Error("cleanup failed");
        });
      let owned: MongoClient | undefined;
      try {
        await expect(
          MongoDBStore.fromConnString(url.toString(), {
            dbName: "langgraph_test",
            collectionName,
          })
        ).rejects.toMatchObject({ code: 11000 });
        owned = connect.mock.contexts[0] as MongoClient;
        expect(owned).toBeDefined();
        expect(close.mock.contexts).toContain(owned);
        expect(close.mock.contexts).not.toContain(client);
      } finally {
        connect.mockRestore();
        close.mockRestore();
        await owned?.close();
      }
    }
  );
});
