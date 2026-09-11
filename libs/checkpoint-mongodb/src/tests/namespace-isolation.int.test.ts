import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MongoDBStore } from "../store.js";
// Use a dedicated local Atlas deployment; each suite owns a unique database.
const client = new MongoClient(
  getEnvironmentVariable("MONGODB_URL") ??
    "mongodb://127.0.0.1:57017/?directConnection=true"
);
const namespaces = [
  ["tenant", "a/b"],
  ["tenant", "a", "b"],
  ["tenant", "a", "b", "notes"],
  ["tenant", "a", "bc"],
  ["a", "tenant", "b"],
  ["tenant", "a/b\n"],
  ["tenant", "日本語"],
];
const dbName = `namespace_regression_${Date.now()}`;
const store = new MongoDBStore({
  client,
  dbName,
  embeddings: {
    embedDocuments: async (texts) => texts.map(() => [1, 0]),
    embedQuery: async () => [1, 0],
  },
  indexConfig: {
    name: "namespace_test",
    dims: 2,
    similarityFunction: "cosine",
  },
});
beforeAll(async () => {
  await client.connect();
  await store.start();
  for (let i = 0; i < namespaces.length; i++) {
    await store.put(namespaces[i], `key${i}`, { text: "hello" });
  }
}, 150000);
afterAll(async () => {
  await client.db(dbName).dropDatabase();
  await client.close();
});
it("keeps vector namespaces distinct when labels contain slashes", async () => {
  await expect
    .poll(
      async () =>
        (
          await client
            .db(dbName)
            .collection("store")
            .listSearchIndexes()
            .toArray()
        ).every((index) => "status" in index && index.status === "READY"),
      { timeout: 120000, interval: 1000 }
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await store.search([], { query: "hello", limit: 100 })).length,
      { timeout: 120000, interval: 1000 }
    )
    .toBe(namespaces.length);
  for (const namespace of namespaces) {
    const expected = namespaces.filter((candidate) =>
      namespace.every((part, i) => candidate[i] === part)
    );
    for (const query of [undefined, "hello"]) {
      const results = await store.search(namespace, { query, limit: 100 });
      expect(
        results.map((item) => JSON.stringify(item.namespace)).sort()
      ).toEqual(expected.map((value) => JSON.stringify(value)).sort());
    }
  }
});
it("permits the same key in distinct namespace arrays", async () => {
  await store.put(["tenant", "a/b"], "shared", {});
  await store.put(["tenant", "a", "b"], "shared", {});
  expect((await store.get(["tenant", "a/b"], "shared"))?.namespace).toEqual([
    "tenant",
    "a/b",
  ]);
});
it("treats aggregation expression-looking labels literally", async () => {
  await store.put(["$namespace"], "dollar", {});
  expect(await store.listNamespaces({ prefix: ["$namespace"] })).toEqual([
    ["$namespace"],
  ]);
  expect(await store.listNamespaces({ suffix: ["$namespace"] })).toEqual([
    ["$namespace"],
  ]);
});

it("migrates legacy documents and indexes before starting, and can be rerun", async () => {
  const collectionName = "legacy";
  const collection = client.db(dbName).collection(collectionName);
  await collection.createIndex({ namespaceStr: 1, key: 1 }, { unique: true });
  await collection.insertMany([
    {
      namespace: ["tenant", "a/b"],
      namespaceStr: "tenant/a/b",
      namespacePath: ["tenant", "tenant/a/b"],
      key: "flat",
      value: {},
      embedding: [1, 0],
    },
    {
      namespace: ["tenant", "a", "b"],
      namespaceStr: "tenant/a/b",
      namespacePath: ["tenant", "tenant/a", "tenant/a/b"],
      key: "segments",
      value: {},
      embedding: [1, 0],
    },
  ]);
  const legacy = new MongoDBStore({
    client,
    dbName,
    collectionName,
    embeddings: {
      embedDocuments: async (texts) => texts.map(() => [1, 0]),
      embedQuery: async () => [1, 0],
    },
    indexConfig: { name: "legacy_test", dims: 2 },
  });
  await expect(legacy.start()).rejects.toThrow(/migrateNamespaceEncoding/);
  await legacy.migrateNamespaceEncoding();
  await legacy.migrateNamespaceEncoding();
  await legacy.start();
  expect(await collection.indexExists("namespaceStr_1_key_1")).toBe(false);
  expect(await collection.indexExists("namespaceKey_1_key_1")).toBe(true);
  await expect
    .poll(
      async () =>
        (await collection.listSearchIndexes().toArray()).every(
          (index) => "status" in index && index.status === "READY"
        ),
      { timeout: 120000, interval: 1000 }
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await legacy.search([], { query: "hello", limit: 100 })).length,
      { timeout: 120000, interval: 1000 }
    )
    .toBe(2);
  expect(
    (await legacy.search(["tenant", "a/b"], { query: "hello" })).map(
      (item) => item.namespace
    )
  ).toEqual([["tenant", "a/b"]]);
  await legacy.put(["tenant", "a/b"], "shared", {});
  await legacy.put(["tenant", "a", "b"], "shared", {});
});

it("requires migration for an empty collection with the legacy unique index", async () => {
  const collectionName = "empty_legacy";
  await client
    .db(dbName)
    .collection(collectionName)
    .createIndex({ namespaceStr: 1, key: 1 }, { unique: true });
  const legacy = new MongoDBStore({ client, dbName, collectionName });
  await expect(legacy.start()).rejects.toThrow(/migrateNamespaceEncoding/);
  await legacy.migrateNamespaceEncoding();
  await legacy.start();
  await legacy.put(["tenant", "a/b"], "same", {});
  await legacy.put(["tenant", "a", "b"], "same", {});
});
