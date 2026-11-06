import { MongoClient } from "mongodb";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { MongoDBStore } from "../store.js";

describe("MongoDBStore compound comparison filters", () => {
  const client = new MongoClient(
    getEnvironmentVariable("MONGODB_URL") || "mongodb://localhost:27017",
    { auth: { username: "user", password: "password" } }
  );
  const collectionName = "compound_filter_store";
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
    for (const age of [10, 18, 40, 65, 80])
      await store.put(["people"], String(age), { age });
  });
  afterAll(async () => {
    await collection.deleteMany({});
    await client.close();
  });
  it.each([
    { $gte: 18, $lt: 65 },
    { $lt: 65, $gte: 18 },
  ])("applies both bounds regardless of key order: %j", async (age) => {
    const results = await store.search(["people"], { filter: { age } });
    expect(results.map((item) => item.value.age).sort((a, b) => a - b)).toEqual(
      [18, 40]
    );
  });
  it("combines equality and exclusion on the same field", async () => {
    await expect(
      store.search(["people"], { filter: { age: { $eq: 18, $ne: 18 } } })
    ).resolves.toEqual([]);
  });
});
