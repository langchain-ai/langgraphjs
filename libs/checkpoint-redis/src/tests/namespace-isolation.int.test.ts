import { afterAll, beforeAll, expect, it } from "vitest";
import { createRedisContainer } from "./redis-container.js";
import { SchemaFieldTypes, VectorAlgorithms } from "redis";
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
        embedDocuments: async (texts: string[]) =>
          texts.map((text) => [1, Number(text) / 1000 || 0]),
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
  await container.client.ft.create(
    "store_vectors",
    {
      "$.prefix": { type: SchemaFieldTypes.TEXT, AS: "prefix" },
      "$.key": { type: SchemaFieldTypes.TAG, AS: "key" },
      "$.embedding": {
        type: SchemaFieldTypes.VECTOR,
        AS: "embedding",
        ALGORITHM: VectorAlgorithms.FLAT,
        TYPE: "FLOAT32",
        DIM: 2,
        DISTANCE_METRIC: "COSINE",
      },
    },
    { ON: "JSON", PREFIX: "store_vectors:" }
  );
  await container.client.json.set("store:legacy", "$", {
    prefix: "upgrade.legacy",
    key: "legacy",
    value: {},
    created_at: 1,
    updated_at: 1,
  });

  for (let i = 0; i < 300; i++) {
    const doc = {
      prefix: `wide.legacy.child${i}`,
      key: `child${i}`,
      created_at: i + 1,
      updated_at: i + 1,
    };

    await container.client.json.set(`store:legacy${i}`, "$", {
      ...doc,
      value: { text: "hello" },
    });
    await container.client.json.set(`store_vectors:legacy${i}`, "$", {
      ...doc,
      field_name: "text",
      embedding: [1, i / 1000],
    });
  }

  await container.client.json.set("store:punctuation", "$", {
    prefix: "upgrade.a/b\né",
    key: "literal",
    value: {},
    created_at: 1,
    updated_at: 1,
  });
  await container.client.expire("store:legacy", 600);
  await container.client.expire("store_vectors:legacy0", 600);
  await store.setup();
  await store.setup();

  for (let i = 0; i < 300; i++) {
    await store.put(["wide", "fresh", `child${i}`], `child${i}`, {
      text: String(i),
    });
  }

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

it("reads existing documents without modifying their payload or expiration", async () => {
  await expect
    .poll(
      async () => (await store.get(["upgrade", "legacy"], "legacy"))?.namespace
    )
    .toEqual(["upgrade", "legacy"]);
  expect(await container.client.json.get("store:legacy")).toEqual({
    prefix: "upgrade.legacy",
    key: "legacy",
    value: {},
    created_at: 1,
    updated_at: 1,
  });
  expect(await store.search(["upgrade", "a/b\né"])).toHaveLength(1);

  for (const key of ["store:legacy", "store_vectors:legacy0"]) {
    expect(await container.client.ttl(key)).toBeGreaterThan(0);
    expect(await container.client.ttl(key)).toBeLessThanOrEqual(600);
  }
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

it("lists whole segments with literal prefix and suffix labels", async () => {
  expect(await store.listNamespaces({ prefix: ["tenant", "a"] })).toEqual([
    ["tenant", "a"],
    ["tenant", "a", "notes"],
  ]);
  expect(
    await store.listNamespaces({ prefix: ["tenant", "*", "notes"] })
  ).toEqual([]);
  expect(await store.listNamespaces({ prefix: ["tenant", "*"] })).toEqual([
    ["tenant", "*"],
  ]);
  expect(await store.listNamespaces({ suffix: ["*"] })).toEqual([
    ["tenant", "*"],
  ]);
  expect(await store.listNamespaces({ suffix: ["a", "*"] })).toEqual([]);
  expect(await store.listNamespaces({ suffix: ["a"] })).toEqual([
    ["tenant", "a"],
  ]);
});

it.each([undefined, "hello"])(
  "rejects delimiter aliases with query=%s while preserving empty-prefix search",
  async (query) => {
    await expect(store.search(["tenant.a"], { query })).rejects.toThrow(
      /periods/
    );
    await expect(
      store.batch([{ namespacePrefix: ["tenant.a"], query }])
    ).rejects.toThrow(/periods/);
    expect(
      (await store.search([], { query, limit: 100 })).length
    ).toBeGreaterThan(0);
    expect(
      (await store.search(["tenant", "a"], { query, limit: 100 }))
        .map((item) => item.namespace)
        .sort()
    ).toEqual([
      ["tenant", "a"],
      ["tenant", "a", "notes"],
    ]);
  }
);

it.each([undefined, "hello"])(
  "returns every descendant beyond the expansion limit with query=%s",
  async (query) => {
    const all = await store.search(["wide", "legacy"], { query, limit: 400 });
    expect(all).toHaveLength(300);
    expect(
      await store.search(["wide", "fresh"], { query, limit: 400 })
    ).toHaveLength(300);
    const keys = new Set<string>();

    for (const offset of [0, 100, 200]) {
      const page = await store.search(["wide", "legacy"], {
        query,
        limit: 100,
        offset,
      });

      expect(page).toHaveLength(100);

      for (const item of page) keys.add(item.key);
    }

    expect(keys.size).toBe(300);
  }
);

it("finds exact keys beyond a page of siblings without overwriting them", async () => {
  for (let i = 0; i < 105; i++) {
    await container.client.json.set(`store:same-key-${i}`, "$", {
      prefix: `keyscope.sibling${i}`,
      key: "shared",
      value: { sibling: i },
      created_at: i + 1,
      updated_at: i + 1,
    });
  }
  await store.put(["keyscope", "own"], "shared", { own: 1 });
  expect((await store.get(["keyscope", "own"], "shared"))?.value).toEqual({
    own: 1,
  });
  await store.put(["keyscope", "own"], "shared", { own: 2 });
  expect(await store.search(["keyscope", "own"])).toHaveLength(1);
  await store.delete(["keyscope", "own"], "shared");
  expect(await store.get(["keyscope", "own"], "shared")).toBeNull();
  expect(
    (await store.get(["keyscope", "sibling104"], "shared"))?.value
  ).toEqual({ sibling: 104 });
});

it("isolates empty and case-sensitive keys", async () => {
  for (const namespace of [
    ["keys", "own"],
    ["keys", "other"],
  ]) {
    for (const key of ["", "Key", "key"])
      await store.put(namespace, key, { key });
  }
  for (const key of ["", "Key", "key"]) {
    expect((await store.get(["keys", "own"], key))?.value).toEqual({ key });
    await store.delete(["keys", "own"], key);
    expect(await store.get(["keys", "own"], key)).toBeNull();
    expect((await store.get(["keys", "other"], key))?.value).toEqual({ key });
  }
});

it.each([undefined, "hello"])(
  "refreshes expiration only inside the requested namespace with query=%s",
  async (query) => {
    const ttlStore = new RedisStore(container.client, {
      ttl: { defaultTTL: 1 },
      index: {
        dims: 2,
        embed: {
          embedDocuments: async (texts: string[]) => texts.map(() => [1, 0]),
          embedQuery: async () => [1, 0],
        },
      },
    });
    for (const [id, prefix] of [
      ["ttl-own", "expiry.a"],
      ["ttl-sibling", "expiry.ab"],
    ]) {
      const doc = { prefix, key: id, created_at: 1, updated_at: 1 };
      await container.client.json.set(`store:${id}`, "$", {
        ...doc,
        value: { text: "hello" },
      });
      await container.client.json.set(`store_vectors:${id}`, "$", {
        ...doc,
        field_name: "text",
        embedding: [1, 0],
      });
      await container.client.expire(`store:${id}`, 600);
      await container.client.expire(`store_vectors:${id}`, 600);
    }
    expect(
      await ttlStore.get(["expiry", "a"], "ttl-sibling", { refreshTTL: true })
    ).toBeNull();
    const results = await ttlStore.search(["expiry", "a"], {
      query,
      refreshTTL: true,
    });
    expect(results.map((item) => item.key)).toEqual(["ttl-own"]);
    for (const prefix of ["store", "store_vectors"]) {
      expect(await container.client.ttl(`${prefix}:ttl-own`)).toBeGreaterThan(
        0
      );
      expect(
        await container.client.ttl(`${prefix}:ttl-own`)
      ).toBeLessThanOrEqual(60);
      expect(
        await container.client.ttl(`${prefix}:ttl-sibling`)
      ).toBeGreaterThan(590);
    }
  }
);
