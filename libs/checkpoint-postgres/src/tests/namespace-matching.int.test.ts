/* eslint-disable no-process-env */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
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
const namespaces = [
  ["tenant", "a"],
  ["tenant", "a", "notes"],
  ["tenant", "ab"],
  ["tenant", "z"],
  ["alice"],
  ["users", "alice"],
  ["users", "malice"],
  ["users", "alice2"],
  ["tenant", "a", "alice"],
  ["tenant", "ab", "alice"],
];
beforeAll(async () => {
  await store.setup();
  for (const namespace of namespaces) {
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
      const options = { filter: { enabled: true }, limit: 100 };
      const result =
        method === "basic" || method === "batchVector"
          ? (
              await store.batch([
                {
                  namespacePrefix: prefix,
                  ...options,
                  ...(method === "batchVector" ? { query: "hello" } : {}),
                },
              ])
            )[0]
          : await store.search(prefix, {
              ...options,
              query: "hello",
              mode: method,
            });
      expect(result.map((item) => item.namespace.join(":")).sort()).toEqual([
        "tenant:a",
        "tenant:a:alice",
        "tenant:a:notes",
      ]);
      expect(await store.get(prefix, "tenant-ab")).toBeNull();
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
