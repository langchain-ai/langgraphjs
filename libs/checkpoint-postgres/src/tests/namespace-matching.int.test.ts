/* eslint-disable no-process-env */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import { PostgresStore } from "../store/index.js";

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString)
  throw new Error("TEST_POSTGRES_URL environment variable is required");
const schema = `namespace_boundary_${Date.now()}`;
const store = new PostgresStore({
  connectionOptions: connectionString,
  schema,
  index: { dims: 2, embed: async (texts) => texts.map(() => [1, 0]) },
});
const memory = new InMemoryStore();
const namespaces = [
  ["literal", "*"],
  ["literal", "*", "leaf"],
  ["literal", "actual"],
  ["wildcards", "one", "v1"],
  ["wildcards", "one", "v1", "child"],
  ["wildcards", "one", "two", "v1"],
  ["wildcards", "v1"],
  ["wildcards", "one", "v10"],
  ["wildcards", "star*", "v1"],
  ["wildcards", "starX", "v1"],
  ["wildcards", "a[b](c)+?$^|", "v1"],
  ["wildcards", "one", "v1\n"],
  ["tenant", "a"],
  ["tenant", "a", "notes"],
  ["tenant", "ab"],
  ["tenant", "z"],
  ["alice"],
  ["users", "alice"],
  ["users", "malice"],
  ["users", "alice2"],
  ["tenant", "langgraph"],
  ["tenant", "mylanggraph"],
  ["tenant", "a", "alice"],
  ["tenant", "ab", "alice"],
];
beforeAll(async () => {
  await store.setup();
  for (const namespace of namespaces) {
    await memory.put(namespace, namespace.join("-"), {});
    await store.put(namespace, namespace.join("-"), {
      text: "hello",
      enabled: true,
    });
  }
});
afterAll(async () => {
  await store.stop();
  const pool = new pg.Pool({ connectionString });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
});
describe("namespace isolation", () => {
  it.each(["basic", "batchVector", "text", "vector", "hybrid"] as const)(
    "excludes overlapping siblings in %s search",
    async (method) => {
      const prefix = ["tenant", "a"];
      const options = { filter: { enabled: true }, limit: 100, offset: 0 };
      const runSearch = async (searchOptions = options) =>
        method === "basic" || method === "batchVector"
          ? (
              await store.batch([
                {
                  namespacePrefix: prefix,
                  ...searchOptions,
                  ...(method === "batchVector" ? { query: "hello" } : {}),
                },
              ])
            )[0]
          : await store.search(prefix, {
              ...searchOptions,
              query: "hello",
              mode: method,
            });
      const result = await runSearch();
      expect(result.map((item) => item.namespace.join(":")).sort()).toEqual([
        "tenant:a",
        "tenant:a:alice",
        "tenant:a:notes",
      ]);
      expect(await store.get(prefix, "tenant-ab")).toBeNull();
      expect(
        await runSearch({ ...options, filter: { enabled: false } })
      ).toEqual([]);
      expect(await runSearch({ ...options, limit: 1, offset: 1 })).toHaveLength(
        1
      );
      expect(await runSearch({ ...options, limit: 1, offset: 3 })).toEqual([]);
    }
  );
  it("anchors prefix, suffix and combined namespace listings", async () => {
    expect(await store.listNamespaces({ prefix: ["tenant", "a"] })).toEqual([
      ["tenant", "a"],
      ["tenant", "a", "alice"],
      ["tenant", "a", "notes"],
    ]);
    expect(await store.listNamespaces({ suffix: ["alice"] })).toEqual([
      ["alice"],
      ["tenant", "a", "alice"],
      ["tenant", "ab", "alice"],
      ["users", "alice"],
    ]);
    expect(
      await store.listNamespaces({ prefix: ["tenant", "a"], suffix: ["alice"] })
    ).toEqual([["tenant", "a", "alice"]]);
    expect(await store.listNamespaces({ prefix: ["missing"] })).toEqual([]);
    expect(await store.listNamespaces({ prefix: [], suffix: [] })).toHaveLength(
      namespaces.length
    );
  });
  it("allows a reserved root label in a suffix, but not a prefix", async () => {
    expect(await store.listNamespaces({ suffix: ["langgraph"] })).toEqual([
      ["tenant", "langgraph"],
    ]);
    await expect(
      store.listNamespaces({ prefix: ["langgraph"] })
    ).rejects.toThrow(/Root label/);
  });
  it("rejects wildcard and separator labels on public read and write paths", async () => {
    for (const label of ["%", "_", "\\", "tenant:a"]) {
      await expect(store.listNamespaces({ prefix: [label] })).rejects.toThrow();
      await expect(store.listNamespaces({ suffix: [label] })).rejects.toThrow();
      await expect(store.search([label])).rejects.toThrow();
      await expect(store.put([label], "key", {})).rejects.toThrow();
      await expect(store.get([label], "key")).rejects.toThrow();
      await expect(store.delete([label], "key")).rejects.toThrow();
    }
  });
});

describe("listing wildcards agree with InMemoryStore", () => {
  it.each([
    { prefix: ["literal", "*"] },
    { prefix: ["wildcards", "*", "v1"] },
    { suffix: ["wildcards", "*", "v1"] },
    { prefix: ["wildcards", "*", "*", "v1"] },
    { suffix: ["*", "v1"] },
    { prefix: ["*"], suffix: ["*", "v1"] },
    { prefix: ["wildcards", "star*"], suffix: ["*", "v1"] },
    { prefix: ["wildcards", "star*", "*"] },
    { prefix: ["wildcards", "a[b](c)+?$^|", "*"] },
    { suffix: ["a[b](c)+?$^|", "*"] },
    { prefix: ["wildcards", "*", "v1\n"] },
    { suffix: ["*", "v1\n"] },
  ])("matches whole segments for %j", async (filter) => {
    const options = { ...filter, limit: 100 };
    const expected = await memory.listNamespaces(options);
    expect(expected.length).toBeGreaterThan(0);
    expect(
      new Set(
        (await store.listNamespaces(options)).map((ns) => JSON.stringify(ns))
      )
    ).toEqual(new Set(expected.map((ns) => JSON.stringify(ns))));
  });
});

describe("mixed listing conditions and literal searches", () => {
  it.each([
    { prefix: ["tenant", "*"], suffix: ["alice"] },
    { prefix: ["tenant"], suffix: ["*", "alice"] },
  ])(
    "binds mixed wildcard/literal filters and pagination for %j",
    async (filter) => {
      expect(
        await store.listNamespaces({ ...filter, limit: 1, offset: 1 })
      ).toEqual([["tenant", "ab", "alice"]]);
    }
  );
  it("keeps stars literal in search prefixes", async () => {
    const result = await store.search(["literal", "*"]);
    expect(new Set(result.map((item) => item.namespace.join(":")))).toEqual(
      new Set(["literal:*", "literal:*:leaf"])
    );
  });
});

describe("search parameter bindings", () => {
  it.each(["cosine", "l2", "inner_product"] as const)(
    "binds vector filters and pagination with %s distance",
    async (distanceMetric) => {
      const result = await store.search(["tenant", "a"], {
        mode: "vector",
        query: "hello",
        distanceMetric,
        similarityThreshold: distanceMetric === "inner_product" ? 0 : 0.5,
        filter: { enabled: true },
        limit: 1,
        offset: 1,
      });
      expect(result).toHaveLength(1);
      expect(result[0].namespace.slice(0, 2)).toEqual(["tenant", "a"]);
      expect(result[0].score).toBeCloseTo(
        distanceMetric === "inner_product" ? -1 : 1
      );
    }
  );
  it.each([0, 1])(
    "binds hybrid weight %s independently of query and threshold",
    async (vectorWeight) => {
      const result = await store.search(["tenant", "a"], {
        mode: "hybrid",
        query: "absentword",
        vectorWeight,
        similarityThreshold: 0.9,
        filter: { enabled: true },
        limit: 1,
        offset: 1,
      });
      expect(result).toHaveLength(1);
      expect(result[0].namespace.slice(0, 2)).toEqual(["tenant", "a"]);
      expect(result[0].score).toBeCloseTo(vectorWeight);
    }
  );
});
