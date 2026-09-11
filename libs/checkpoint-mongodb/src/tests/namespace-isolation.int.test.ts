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
  ["tenant", "a", "b"],
  ["tenant", "a", "b", "notes"],
  ["tenant", "a", "bc"],
  ["a", "tenant", "b"],
  ["tenant", "日本語"],
  ["tenant", "a:b"],
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

it("keeps vector and ordinary search within namespace segment boundaries", async () => {
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

it("rejects slash-containing writes before embedding or storing them", async () => {
  await expect(store.put(["tenant", "a/b"], "shared", {})).rejects.toThrow(/slashes/);
  await expect(store.batch([
    { namespace: ["tenant", "a/b"], key: "shared", value: {} },
  ])).rejects.toThrow(/slashes/);
  expect(await store.get(["tenant", "a/b"], "shared")).toBeNull();
  await store.put(["tenant", "a", "b"], "shared", {});
  await store.put(["tenant", "ab"], "shared", {});
  expect((await store.get(["tenant", "a", "b"], "shared"))?.namespace)
    .toEqual(["tenant", "a", "b"]);
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

it("excludes legacy vector aliases without migrating documents or indexes", async () => {
  const collection = client.db(dbName).collection("store");
  const namespace = ["legacy", "a/b"];
  await collection.insertMany([
    {
      namespace,
      namespaceStr: "legacy/a/b",
      namespacePath: ["legacy", "legacy/a/b"],
      key: "flat",
      value: { preserved: true },
      embedding: [1, 0],
    },
    {
      namespace: ["legacy", "a", "b"],
      namespaceStr: "legacy/a/b",
      namespacePath: ["legacy", "legacy/a", "legacy/a/b"],
      key: "segments",
      value: {},
      embedding: [1, 0],
    },
  ]);
  const before = await collection.findOne({ namespace, key: "flat" });
  await store.start();
  expect(await collection.indexExists("namespaceStr_1_key_1")).toBe(true);
  expect(await collection.findOne({ namespace, key: "flat" })).toEqual(before);
  await expect.poll(
    async () => (await store.search(["legacy"], { query: "hello", limit: 100 })).length,
    { timeout: 120000, interval: 1000 }
  ).toBe(2);

  for (const prefix of [namespace, ["legacy", "a", "b"]]) {
    for (const query of [undefined, "hello"]) {
      expect((await store.search(prefix, { query, limit: 100 })).map(item => item.namespace))
        .toEqual([prefix]);
    }
  }

  expect((await store.get(namespace, "flat"))?.value).toEqual({ preserved: true });
  await expect(store.put(namespace, "flat", {})).rejects.toThrow(/slashes/);
  await store.delete(namespace, "flat");
  expect(await store.get(namespace, "flat")).toBeNull();
});
