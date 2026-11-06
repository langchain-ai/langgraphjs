import { MongoClient } from "mongodb";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { MongoDBStore } from "../store.js";

describe("MongoDBStore namespace depth", () => {
  const client = new MongoClient(
    getEnvironmentVariable("MONGODB_URL") || "mongodb://localhost:27017",
    { auth: { username: "user", password: "password" } }
  );
  const collectionName = "namespace_depth_store";
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

  it("truncates and deduplicates matching namespaces before pagination", async () => {
    for (const namespace of [
      ["depth", "a", "one"],
      ["depth", "a", "two"],
      ["depth", "b", "one"],
      ["depth", "c"],
    ]) {
      await store.put(namespace, "item", { value: 1 });
    }
    await expect(
      store.listNamespaces({ prefix: ["depth"], maxDepth: 2 })
    ).resolves.toEqual([
      ["depth", "a"],
      ["depth", "b"],
      ["depth", "c"],
    ]);
    await expect(
      store.listNamespaces({
        prefix: ["depth"],
        maxDepth: 2,
        offset: 1,
        limit: 1,
      })
    ).resolves.toEqual([["depth", "b"]]);
    await expect(
      store.listNamespaces({ prefix: ["depth"], suffix: ["one"], maxDepth: 1 })
    ).resolves.toEqual([["depth"]]);
    await expect(
      store.listNamespaces({ prefix: ["depth"], maxDepth: 0 })
    ).resolves.toEqual([[]]);
  });
});
