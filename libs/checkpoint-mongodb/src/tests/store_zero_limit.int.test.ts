import { MongoClient } from "mongodb";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { MongoDBStore } from "../store.js";

describe("MongoDBStore zero limits", () => {
  const client = new MongoClient(
    getEnvironmentVariable("MONGODB_URL") || "mongodb://localhost:27017",
    { auth: { username: "user", password: "password" } }
  );
  const collectionName = "zero_limit_store";
  const collection = client.db("langgraph_test").collection(collectionName);
  const store = new MongoDBStore({
    client,
    dbName: "langgraph_test",
    collectionName,
  });

  beforeAll(async () => {
    await client.connect();
    await collection.deleteMany({});
    await store.start();
  });

  afterAll(async () => {
    await collection.deleteMany({});
    await client.close();
  });

  it("returns no items for a structured search with limit zero", async () => {
    await store.put(["zero_limit"], "one", { value: 1 });
    await expect(store.search(["zero_limit"], { limit: 0 })).resolves.toEqual(
      []
    );
    await expect(
      store.search(["zero_limit"], { limit: 1 })
    ).resolves.toHaveLength(1);
  });

  it("returns no namespaces with limit zero", async () => {
    await store.put(["zero_limit", "nested"], "two", { value: 2 });
    await expect(
      store.listNamespaces({ prefix: ["zero_limit"], limit: 0 })
    ).resolves.toEqual([]);
    await expect(
      store.listNamespaces({ prefix: ["zero_limit"], limit: 1 })
    ).resolves.toHaveLength(1);
  });
});
