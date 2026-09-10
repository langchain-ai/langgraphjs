import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { DatabaseCore } from "./database-core.js";
import { VectorOperations } from "./vector-operations.js";
import { SearchOperations } from "./search-operations.js";
import { namespaceMatchCondition } from "./utils.js";
import { PostgresStore } from "../index.js";

const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
  rows: [],
}));
const client = { query, release: vi.fn() } as unknown as pg.PoolClient;

afterEach(() => {
  vi.restoreAllMocks();
  query.mockClear();
});

describe("namespace query boundaries", () => {
  it.each([
    "executeSearch",
    "executeVectorSearch",
    "textSearch",
    "vectorSearch",
    "hybridSearch",
  ] as const)("anchors %s and preserves parameter bindings", async (method) => {
    const core = new DatabaseCore(new pg.Pool(), "public", undefined, {
      dims: 2,
      embed: async (texts) => texts.map(() => [1, 0]),
    });
    vi.spyOn(core.pool, "connect").mockImplementation(async () => client);
    const search = new SearchOperations(core, new VectorOperations(core));
    const namespacePrefix = ["tenant", "a"];
    const options = { filter: { enabled: true }, limit: 7, offset: 2 };
    if (method === "executeSearch" || method === "executeVectorSearch") {
      await search[method](client, {
        namespacePrefix,
        ...options,
        ...(method === "executeVectorSearch" ? { query: "hello" } : {}),
      });
    } else if (method === "textSearch") {
      await search.textSearch(namespacePrefix, { ...options, query: "hello" });
    } else {
      await search[method](namespacePrefix, "hello", options);
    }
    const [sql, params] = query.mock.calls[0];
    const column =
      method === "executeSearch" || method === "textSearch"
        ? "namespace_path"
        : "s.namespace_path";
    expect(sql).toContain(
      `WHERE (${column} = $1 OR ${column} LIKE $2 ESCAPE E'\\\\')`
    );
    expect(params?.slice(0, 2)).toEqual(["tenant:a", "tenant:a:%"]);
    expect(params?.slice(-2)).toEqual([7, 2]);
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) =>
      Number(match[1])
    );
    expect([...new Set(placeholders)].sort((a, b) => a - b)).toEqual(
      params?.map((_, i) => i + 1)
    );
    if (method !== "executeSearch" && method !== "textSearch") {
      expect(sql).toContain("v.embedding <=> $3");
      expect(params?.[2]).toBe("[1,0]");
    }
    await core.pool.end();
  });

  it("escapes LIKE metacharacters even without boundary validation", () => {
    for (const matchType of ["prefix", "suffix"] as const) {
      const params: unknown[] = [];
      namespaceMatchCondition(["a%_\\b"], matchType, params);
      expect(params).toEqual([
        "a%_\\b",
        matchType === "prefix" ? "a\\%\\_\\\\b:%" : "%:a\\%\\_\\\\b",
      ]);
    }
  });

  it("anchors combined list prefix and suffix conditions", async () => {
    vi.spyOn(pg.Pool.prototype, "connect").mockImplementation(
      async () => client
    );
    const store = new PostgresStore({
      connectionOptions: {},
      ensureTables: false,
    });
    await store.listNamespaces({
      prefix: ["tenant", "a"],
      suffix: ["alice"],
      limit: 7,
      offset: 2,
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(
      "(namespace_path = $1 OR namespace_path LIKE $2 ESCAPE E'\\\\') AND (namespace_path = $3 OR namespace_path LIKE $4 ESCAPE E'\\\\')"
    );
    expect(sql).toContain("LIMIT $5 OFFSET $6");
    expect(params).toEqual([
      "tenant:a",
      "tenant:a:%",
      "alice",
      "%:alice",
      7,
      2,
    ]);
    await store.stop();
  });

  it("allows a reserved root label only in suffix filters", async () => {
    vi.spyOn(pg.Pool.prototype, "connect").mockImplementation(
      async () => client
    );
    const store = new PostgresStore({
      connectionOptions: {},
      ensureTables: false,
    });
    await store.listNamespaces({ suffix: ["langgraph"] });
    expect(query.mock.calls[0][1]).toEqual([
      "langgraph",
      "%:langgraph",
      100,
      0,
    ]);
    await expect(
      store.listNamespaces({ prefix: ["langgraph"] })
    ).rejects.toThrow(/Root label/);
    await store.stop();
  });

  it.each(["prefix", "suffix"] as const)(
    "validates list %s labels",
    async (arm) => {
      vi.spyOn(pg.Pool.prototype, "connect").mockImplementation(
        async () => client
      );
      const store = new PostgresStore({
        connectionOptions: {},
        ensureTables: false,
      });
      for (const label of ["%", "_", "\\", "tenant:a", "", "a.b"]) {
        await expect(
          store.listNamespaces({ [arm]: [label] })
        ).rejects.toThrow();
      }
      expect(query).not.toHaveBeenCalled();
      await store.listNamespaces({ [arm]: [] });
      expect(query.mock.calls[0][0]).not.toContain("WHERE");
      await store.stop();
    }
  );
});
