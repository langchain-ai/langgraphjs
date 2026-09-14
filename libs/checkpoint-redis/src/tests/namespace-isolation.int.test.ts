import { afterAll, beforeAll, expect, it, vi } from "vitest";
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
  // Resume after only the exact namespace field was added.
  await container.client.ft.alter("store", {
    "$.prefix": {
      type: SchemaFieldTypes.TAG,
      AS: "namespace",
      CASESENSITIVE: true,
    },
  });
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

it("backfills existing documents while preserving values and expiration", async () => {
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
    namespacePrefixes: ["upgrade", "upgrade.legacy"],
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

it("does not recreate a document removed during setup", async () => {
  await container.client.json.set("store:removed", "$", {
    prefix: "upgrade.removed",
    key: "removed",
    value: {},
    created_at: 1,
    updated_at: 1,
  });

  const aggregate = container.client.ft.aggregateWithCursor.bind(
    container.client.ft
  );

  const spy = vi
    .spyOn(container.client.ft, "aggregateWithCursor")
    .mockImplementationOnce(async (...args) => {
      const page = await aggregate(...args);
      await container.client.del("store:removed");

      return page;
    });

  try {
    await store.setup();
    expect(await container.client.exists("store:removed")).toBe(0);
  } finally {
    spy.mockRestore();
  }
});
