import { afterAll, beforeAll, expect, it } from "vitest";
import { createRedisContainer } from "./redis-container.js";
import { SchemaFieldTypes } from "redis";
import { RedisStore } from "../store.js";

let container: Awaited<ReturnType<typeof createRedisContainer>>;

let store: RedisStore;

const namespaces = [
  ["tenant", "a"],
  ["tenant", "a", "notes"],
  ["tenant", "ab"],
  ["a", "tenant"],
  ["tenant", "A"],
  ["tenant", "a-b"],
  ["tenant", "a,b"],
  ["tenant", "a) | @prefix:(victim"],
  ["tenant", "*"],
];

beforeAll(async () => {
  container = await createRedisContainer();
  store = new RedisStore(container.client, {
    index: {
      dims: 2,
      embed: {
        embedDocuments: async (texts: string[]) => texts.map(() => [1, 0]),
        embedQuery: async () => [1, 0],
      },
    },
  });
  // Simulate an existing index and document written by the old release.
  await container.client.ft.create(
    "store",
    {
      "$.prefix": { type: SchemaFieldTypes.TEXT, AS: "prefix" },
      "$.key": { type: SchemaFieldTypes.TAG, AS: "key" },
      "$.created_at": { type: SchemaFieldTypes.NUMERIC, AS: "created_at" },
      "$.updated_at": { type: SchemaFieldTypes.NUMERIC, AS: "updated_at" },
    },
    { ON: "JSON", PREFIX: "store:" }
  );
  await container.client.json.set("store:legacy", "$", {
    prefix: "upgrade.legacy",
    key: "legacy",
    value: {},
    created_at: 1,
    updated_at: 1,
  });
  await store.setup();
  await store.setup();

  for (let i = 0; i < namespaces.length; i++)
    await store.put(namespaces[i], `key${i}`, { text: "hello" });
});

afterAll(async () => {
  await container?.cleanup();
});

it.each([false, true])("isolates segments with vector=%s", async (vector) => {
  for (const namespace of namespaces) {
    const items = await store.search(namespace, {
      limit: 100,
      query: vector ? "hello" : undefined,
    });

    expect(items.length).toBeGreaterThan(0);
    expect(
      items.every((item) =>
        namespace.every((part, i) => item.namespace[i] === part)
      )
    ).toBe(true);
  }

  expect(
    (
      await store.search(["tenant", "a"], {
        limit: 100,
        query: vector ? "hello" : undefined,
      })
    ).length
  ).toBe(2);
});

it("isolates exact reads, updates and deletes with identical keys", async () => {
  for (const namespace of [
    ["scope", "one"],
    ["one", "scope"],
    ["scope", "one", "child"],
  ])
    await store.put(namespace, "same", { namespace });
  expect((await store.get(["scope", "one"], "same"))?.namespace).toEqual([
    "scope",
    "one",
  ]);
  await store.put(["scope", "one"], "same", { updated: true });
  expect((await store.get(["one", "scope"], "same"))?.value).toEqual({
    namespace: ["one", "scope"],
  });
  await store.delete(["scope", "one"], "same");
  expect(await store.get(["scope", "one"], "same")).toBeNull();
  expect(await store.get(["one", "scope"], "same")).not.toBeNull();
  expect(await store.get(["scope", "one", "child"], "same")).not.toBeNull();
});

it("indexes existing documents without rewriting them", async () => {
  await expect
    .poll(
      async () => (await store.get(["upgrade", "legacy"], "legacy"))?.namespace
    )
    .toEqual(["upgrade", "legacy"]);
});

it("keeps search pagination within the namespace and supports an empty prefix", async () => {
  expect(await store.search(["tenant", "a"], { limit: 1, offset: 2 })).toEqual(
    []
  );
  const page = await store.search(["tenant", "a"], { limit: 1, offset: 1 });
  expect(page).toHaveLength(1);
  expect(page[0].namespace.slice(0, 2)).toEqual(["tenant", "a"]);
  expect((await store.search([], { limit: 100 })).length).toBeGreaterThan(
    namespaces.length
  );
});

it("lists whole segments with prefix, suffix and standalone wildcards", async () => {
  expect(await store.listNamespaces({ prefix: ["tenant", "a"] })).toEqual([
    ["tenant", "a"],
    ["tenant", "a", "notes"],
  ]);
  expect(
    await store.listNamespaces({ prefix: ["tenant", "*", "notes"] })
  ).toEqual([["tenant", "a", "notes"]]);
  expect(await store.listNamespaces({ suffix: ["a", "*"] })).toEqual([
    ["a", "tenant"],
    ["tenant", "a", "notes"],
  ]);
  expect(await store.listNamespaces({ suffix: ["a"] })).toEqual([
    ["tenant", "a"],
  ]);
});

it.each([undefined, "hello"])(
  "rejects delimiter aliases with query=%s while preserving empty-prefix search",
  async (query) => {
    await expect(store.search(["tenant.a"], { query })).rejects.toThrow(/periods/);
    await expect(
      store.batch([{ namespacePrefix: ["tenant.a"], query }])
    ).rejects.toThrow(/periods/);
    expect((await store.search([], { query, limit: 100 })).length).toBeGreaterThan(0);
    expect(
      (await store.search(["tenant", "a"], { query, limit: 100 })).map(
        (item) => item.namespace
      ).sort()
    ).toEqual([["tenant", "a"], ["tenant", "a", "notes"]]);
  }
);
