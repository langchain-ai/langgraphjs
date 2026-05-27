import { config } from "dotenv";
import oracledb from "oracledb";
import { describe, expect, test } from "vitest";

import {
  InvalidNamespaceError,
  type IndexConfig,
} from "@langchain/langgraph-checkpoint";

import { OracleStore } from "../store.js";

config();

const { ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING } = process.env;
const hasOracleCredentials =
  ORACLE_USER && ORACLE_PASSWORD && ORACLE_CONNECT_STRING;

const oracleConnection = {
  user: ORACLE_USER,
  password: ORACLE_PASSWORD,
  connectString: ORACLE_CONNECT_STRING,
};

const describeIfOracle = hasOracleCredentials ? describe : describe.skip;

const uniquePrefix = (): string =>
  `LG_STORE_${Date.now().toString(36).toUpperCase()}_${Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase()}_`;

const tableNames = (prefix: string): string[] => [
  `${prefix}STORE_VECTORS`,
  `${prefix}STORE`,
  `${prefix}STORE_MIGRATIONS`,
].map((name) => name.toUpperCase());

async function dropStoreTables(prefix: string): Promise<void> {
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    for (const tableName of tableNames(prefix)) {
      try {
        await connection.execute(`DROP TABLE ${tableName} PURGE`);
      } catch (error) {
        const code = (error as { errorNum?: number }).errorNum;
        if (code !== 942) throw error;
      }
    }
    await connection.commit();
  } finally {
    await connection.close();
  }
}

async function withStore<T>(
  callback: (store: OracleStore, prefix: string) => Promise<T>,
  options: Omit<ConstructorParameters<typeof OracleStore>[0], "connection" | "tablePrefix"> = {}
): Promise<T> {
  const prefix = uniquePrefix();
  const store = new OracleStore({
    connection: oracleConnection,
    tablePrefix: prefix,
    ...options,
  });
  try {
    return await callback(store, prefix);
  } finally {
    await store.stop();
    await dropStoreTables(prefix);
  }
}

const testEmbeddings = {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embedText(text));
  },
  async embedQuery(text: string): Promise<number[]> {
    return embedText(text);
  },
};

function embedText(text: string): number[] {
  const normalized = text.toLowerCase();
  if (normalized.includes("apple") || normalized.includes("fruit")) {
    return [1, 0, 0];
  }
  if (normalized.includes("car") || normalized.includes("vehicle")) {
    return [0, 1, 0];
  }
  return [0, 0, 1];
}

const indexConfig: IndexConfig = {
  dims: 3,
  embeddings: testEmbeddings as IndexConfig["embeddings"],
  fields: ["text"],
};

describeIfOracle("OracleStore BaseStore contract", () => {
  test("put/get/delete stores and removes items", async () => {
    await withStore(async (store) => {
      const namespace = ["users", "alice"];
      await store.put(namespace, "profile", { name: "Ada", score: 1 });

      await expect(store.get(namespace, "profile")).resolves.toMatchObject({
        namespace,
        key: "profile",
        value: { name: "Ada", score: 1 },
      });

      await store.delete(namespace, "profile");
      await expect(store.get(namespace, "profile")).resolves.toBeNull();
    });
  });

  test("round-trips empty and encoded-looking store keys", async () => {
    await withStore(async (store) => {
      const namespace = ["keys"];
      await store.put(namespace, "", { value: "empty" });
      await store.put(namespace, "b64:literal", { value: "literal" });

      await expect(store.get(namespace, "")).resolves.toMatchObject({
        key: "",
        value: { value: "empty" },
      });
      await expect(store.get(namespace, "b64:literal")).resolves.toMatchObject({
        key: "b64:literal",
        value: { value: "literal" },
      });

      await expect(store.search(namespace, { limit: 10 })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "" }),
          expect.objectContaining({ key: "b64:literal" }),
        ])
      );

      await store.delete(namespace, "");
      await expect(store.get(namespace, "")).resolves.toBeNull();
    });
  });

  test("repeated put updates value and updatedAt while preserving createdAt", async () => {
    await withStore(async (store) => {
      const namespace = ["users", "updates"];
      await store.put(namespace, "profile", { version: 1 });
      const before = await store.get(namespace, "profile");
      expect(before).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.put(namespace, "profile", { version: 2 });
      const after = await store.get(namespace, "profile");

      expect(after?.value).toEqual({ version: 2 });
      expect(after?.createdAt.getTime()).toBe(before!.createdAt.getTime());
      expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        before!.updatedAt.getTime()
      );
    });
  });

  test("batch preserves result ordering and last consecutive put wins", async () => {
    await withStore(async (store) => {
      const namespace = ["batch", "ordering"];
      const results = await store.batch([
        { namespace, key: "item", value: { version: 1 } },
        { namespace, key: "item", value: { version: 2 } },
        { namespace, key: "item" },
        { namespacePrefix: ["batch"], limit: 10, offset: 0 },
        { namespace, key: "item", value: null },
        { namespace, key: "item" },
      ]);

      expect(results[0]).toBeUndefined();
      expect(results[1]).toBeUndefined();
      expect(results[2]).toMatchObject({ value: { version: 2 } });
      expect(results[3]).toEqual([
        expect.objectContaining({ key: "item", value: { version: 2 } }),
      ]);
      expect(results[4]).toBeUndefined();
      expect(results[5]).toBeNull();
    });
  });

  test("searches namespace prefixes with limit and offset", async () => {
    await withStore(async (store) => {
      await store.put(["docs"], "root", { order: 0 });
      await store.put(["docs", "a"], "a", { order: 1 });
      await store.put(["docs", "b"], "b", { order: 2 });
      await store.put(["other"], "other", { order: 3 });

      const allDocs = await store.search(["docs"], { limit: 10 });
      expect(allDocs.map((item) => item.key)).toEqual(["a", "b", "root"]);

      const paged = await store.search(["docs"], { offset: 1, limit: 1 });
      expect(paged.map((item) => item.key)).toEqual(["b"]);
    });
  });

  test("escapes SQL wildcard characters in namespace prefix search", async () => {
    await withStore(async (store) => {
      await store.put(["docs_%", "a"], "literal", { value: "literal" });
      await store.put(["docs", "a"], "docs", { value: "docs" });
      await store.put(["docsX", "a"], "docsX", { value: "docsX" });
      await store.put(["docs\\_%", "a"], "backslash", {
        value: "backslash",
      });

      await expect(store.search(["docs_%"], { limit: 10 })).resolves.toEqual([
        expect.objectContaining({
          key: "literal",
          namespace: ["docs_%", "a"],
        }),
      ]);

      await expect(store.listNamespaces({ prefix: ["docs_%"] })).resolves.toEqual([
        ["docs_%", "a"],
      ]);

      await expect(store.search(["docs\\_%"], { limit: 10 })).resolves.toEqual([
        expect.objectContaining({
          key: "backslash",
          namespace: ["docs\\_%", "a"],
        }),
      ]);
    });
  });

  test("handles concurrent first-use setup calls", async () => {
    await withStore(async (store) => {
      await Promise.all([
        store.start(),
        store.put(["concurrent"], "a", { value: "a" }),
        store.put(["concurrent"], "b", { value: "b" }),
        store.put(["concurrent", "child"], "c", { value: "c" }),
        store.search(["concurrent"]),
      ]);

      await expect(store.search(["concurrent"], { limit: 10 })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "a" }),
          expect.objectContaining({ key: "b" }),
          expect.objectContaining({ key: "c" }),
        ])
      );
    });
  });

  test("can be stopped and reused by the same store instance", async () => {
    await withStore(async (store) => {
      await store.start();
      await store.stop();

      await store.put(["reuse"], "item", { value: "ok" });
      await expect(store.get(["reuse"], "item")).resolves.toMatchObject({
        key: "item",
        value: { value: "ok" },
      });
    });
  });

  test("supports exact, operator, existence, and nested filters", async () => {
    await withStore(async (store) => {
      await store.put(["filters"], "one", {
        color: "red",
        score: 5,
        tag: "a",
        details: { category: "fruit" },
      });
      await store.put(["filters"], "two", {
        color: "blue",
        score: 2,
        tag: "b",
        details: { category: "vehicle" },
      });
      await store.put(["filters"], "three", {
        color: "green",
        score: 8,
        tag: "c",
      });

      await expect(
        store.search(["filters"], { filter: { color: "red" } })
      ).resolves.toHaveLength(1);
      await expect(
        store.search(["filters"], { filter: { color: { $eq: "blue" } } })
      ).resolves.toHaveLength(1);
      await expect(
        store.search(["filters"], { filter: { color: { $ne: "red" } } })
      ).resolves.toHaveLength(2);
      await expect(
        store.search(["filters"], { filter: { score: { $gt: 4 } } })
      ).resolves.toHaveLength(2);
      await expect(
        store.search(["filters"], { filter: { score: { $gte: 5 } } })
      ).resolves.toHaveLength(2);
      await expect(
        store.search(["filters"], { filter: { score: { $lt: 5 } } })
      ).resolves.toHaveLength(1);
      await expect(
        store.search(["filters"], { filter: { score: { $lte: 5 } } })
      ).resolves.toHaveLength(2);
      await expect(
        store.search(["filters"], { filter: { tag: { $in: ["a", "c"] } } })
      ).resolves.toHaveLength(2);
      await expect(
        store.search(["filters"], { filter: { tag: { $in: [] } } })
      ).resolves.toEqual([]);
      await expect(
        store.search(["filters"], { filter: { tag: { $nin: [] } } })
      ).resolves.toHaveLength(3);
      await expect(
        store.search(["filters"], { filter: { tag: { $nin: ["a", "c"] } } })
      ).resolves.toHaveLength(1);
      await expect(
        store.search(["filters"], {
          filter: { details: { $exists: true } },
        })
      ).resolves.toHaveLength(2);
      await expect(
        store.search(["filters"], {
          filter: { details: { $exists: false } },
        })
      ).resolves.toHaveLength(1);
      await expect(
        store.search(["filters"], {
          filter: { "details.category": "fruit" },
        })
      ).resolves.toEqual([
        expect.objectContaining({ key: "one" }),
      ]);
    });
  });

  test("supports empty-string and long-string filters via strict JS fallback", async () => {
    await withStore(async (store) => {
      const longValue = "x".repeat(4001);
      await store.put(["empty-string-filters"], "empty", {
        label: "",
        tag: "",
      });
      await store.put(["empty-string-filters"], "non-empty", {
        label: "value",
        tag: "value",
      });
      await store.put(["long-string-filters"], "other", {
        body: "short",
      });
      await store.put(["long-string-filters"], "long", {
        body: longValue,
      });

      await expect(
        store.search(["empty-string-filters"], { filter: { label: "" } })
      ).resolves.toEqual([expect.objectContaining({ key: "empty" })]);
      await expect(
        store.search(["empty-string-filters"], {
          filter: { label: { $eq: "" } },
        })
      ).resolves.toEqual([expect.objectContaining({ key: "empty" })]);
      await expect(
        store.search(["empty-string-filters"], {
          filter: { tag: { $in: [""] } },
        })
      ).resolves.toEqual([expect.objectContaining({ key: "empty" })]);
      await expect(
        store.search(["long-string-filters"], {
          filter: { body: longValue },
          limit: 1,
        })
      ).resolves.toEqual([expect.objectContaining({ key: "long" })]);
    });
  });

  test("applies pagination after strict JS filter semantics for SQL-prefiltered values", async () => {
    await withStore(async (store) => {
      await store.put(["filter-coercion-string"], "a-number", { score: 5 });
      await store.put(["filter-coercion-string"], "b-string", { score: "5" });

      const stringResults = await store.search(["filter-coercion-string"], {
        filter: { score: "5" },
        limit: 1,
      });
      expect(stringResults.map((item) => item.key)).toEqual(["b-string"]);

      await store.put(["filter-coercion-number"], "a-string", { score: "5" });
      await store.put(["filter-coercion-number"], "b-number", { score: 5 });

      const numberResults = await store.search(["filter-coercion-number"], {
        filter: { score: { $eq: 5 } },
        limit: 1,
      });
      expect(numberResults.map((item) => item.key)).toEqual(["b-number"]);
    });
  });

  test("uses BaseStore numeric coercion semantics for range filters", async () => {
    await withStore(async (store) => {
      await store.put(["range-coercion"], "boolean", { score: true });
      await store.put(["range-coercion"], "number", { score: 10 });
      await store.put(["range-coercion"], "numeric-string", { score: "2" });
      await store.put(["range-coercion"], "zero", { score: 0 });

      const gtString = await store.search(["range-coercion"], {
        filter: { score: { $gt: "4" } },
        limit: 10,
      });
      expect(gtString.map((item) => item.key)).toEqual(["number"]);

      const gteNumber = await store.search(["range-coercion"], {
        filter: { score: { $gte: 1 } },
        limit: 10,
      });
      expect(gteNumber.map((item) => item.key)).toEqual([
        "boolean",
        "number",
        "numeric-string",
      ]);

      const ltString = await store.search(["range-coercion"], {
        filter: { score: { $lt: "10" } },
        limit: 10,
      });
      expect(ltString.map((item) => item.key)).toEqual([
        "boolean",
        "numeric-string",
        "zero",
      ]);
    });
  });

  test("lists namespaces with prefix, suffix, wildcards, maxDepth, and pagination", async () => {
    await withStore(async (store) => {
      await store.put(["a", "b", "c"], "1", { value: 1 });
      await store.put(["a", "b", "d", "e"], "2", { value: 2 });
      await store.put(["a", "b", "d", "i"], "3", { value: 3 });
      await store.put(["x", "b", "c"], "4", { value: 4 });

      await expect(store.listNamespaces({ prefix: ["a", "b"] })).resolves.toEqual([
        ["a", "b", "c"],
        ["a", "b", "d", "e"],
        ["a", "b", "d", "i"],
      ]);

      await expect(store.listNamespaces({ suffix: ["b", "c"] })).resolves.toEqual([
        ["a", "b", "c"],
        ["x", "b", "c"],
      ]);

      await expect(
        store.listNamespaces({ prefix: ["*", "b"], suffix: ["c"] })
      ).resolves.toEqual([
        ["a", "b", "c"],
        ["x", "b", "c"],
      ]);

      await expect(
        store.listNamespaces({ prefix: ["a", "b"], maxDepth: 3 })
      ).resolves.toEqual([
        ["a", "b", "c"],
        ["a", "b", "d"],
      ]);

      await expect(
        store.listNamespaces({ prefix: ["a"], offset: 1, limit: 1 })
      ).resolves.toEqual([["a", "b", "d", "e"]]);
    });
  });

  test("rejects invalid namespaces for put and batched delete", async () => {
    await withStore(async (store) => {
      await expect(store.put([], "bad", { ok: true })).rejects.toBeInstanceOf(
        InvalidNamespaceError
      );
      await expect(
        store.put(["bad.label"], "bad", { ok: true })
      ).rejects.toBeInstanceOf(InvalidNamespaceError);
      await expect(
        store.put([""], "bad", { ok: true })
      ).rejects.toBeInstanceOf(InvalidNamespaceError);
      await expect(
        store.put(["langgraph"], "bad", { ok: true })
      ).rejects.toBeInstanceOf(InvalidNamespaceError);
      await expect(
        store.put(["ok", "langgraph"], "good", { ok: true })
      ).resolves.toBeUndefined();

      await expect(
        store.batch([{ namespace: [], key: "bad", value: null }])
      ).rejects.toBeInstanceOf(InvalidNamespaceError);
    });
  });

  test("throws a clear error for query search without index config", async () => {
    await withStore(async (store) => {
      await store.put(["query"], "item", { text: "apple fruit" });
      await expect(
        store.search(["query"], { query: "apple" })
      ).rejects.toThrow("OracleStore vector search requires an index configuration.");
    });
  });
});

describeIfOracle("OracleStore vector search", () => {
  test("validates index dimensions before setup", async () => {
    for (const dims of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(
        () =>
          new OracleStore({
            connection: oracleConnection,
            tablePrefix: uniquePrefix(),
            index: {
              dims,
              embeddings: testEmbeddings as IndexConfig["embeddings"],
            },
          })
      ).toThrow("OracleStore index dims must be a positive integer");
    }
  });

  test("indexes the whole value by default when index fields are omitted", async () => {
    await withStore(
      async (store) => {
        await store.put(["vectors"], "whole", {
          nested: { text: "apple fruit" },
        });

        await expect(
          store.search(["vectors"], { query: "apple", limit: 1 })
        ).resolves.toEqual([
          expect.objectContaining({ key: "whole", score: expect.any(Number) }),
        ]);
      },
      {
        index: {
          dims: 3,
          embeddings: testEmbeddings as IndexConfig["embeddings"],
        },
      }
    );
  });

  test("returns ranked scored results and supports filters", async () => {
    await withStore(
      async (store) => {
        await store.put(["vectors"], "apple", {
          text: "apple fruit",
          color: "red",
        });
        await store.put(["vectors"], "car", {
          text: "fast car",
          color: "red",
        });
        await store.put(["vectors"], "other", {
          text: "unrelated",
          color: "blue",
        });

        const results = await store.search(["vectors"], {
          query: "apple",
          filter: { color: "red" },
          limit: 2,
        });

        expect(results.map((item) => item.key)).toEqual(["apple", "car"]);
        expect(results[0].score).toBeGreaterThan(results[1].score ?? -Infinity);
      },
      { index: indexConfig }
    );
  });

  test("extracts configured vector fields from nested objects and arrays", async () => {
    await withStore(
      async (store) => {
        await store.put(["paths"], "chapters", {
          chapters: [{ content: "fast car" }, { content: "apple fruit" }],
        });
        await store.put(["paths"], "author", {
          authors: [{ name: "apple author" }, { name: "vehicle writer" }],
        });
        await store.put(["paths"], "last", {
          items: [{ text: "fast car" }, { text: "apple ending" }],
        });
        await store.put(["paths"], "nested", {
          metadata: { summary: "apple summary" },
        });

        const results = await store.search(["paths"], {
          query: "apple",
          limit: 10,
        });

        expect(results.map((item) => item.key).sort()).toEqual([
          "author",
          "chapters",
          "last",
          "nested",
        ]);
      },
      {
        index: {
          dims: 3,
          embeddings: testEmbeddings as IndexConfig["embeddings"],
          fields: [
            "chapters[*].content",
            "authors[0].name",
            "items[-1].text",
            "metadata.summary",
          ],
        },
      }
    );
  });

  test("supports vector query offset and namespace prefix", async () => {
    await withStore(
      async (store) => {
        await store.put(["vector-prefix"], "apple", { text: "apple fruit" });
        await store.put(["vector-prefix", "child"], "car", { text: "fast car" });
        await store.put(["elsewhere"], "elsewhere", { text: "apple fruit" });

        const prefixed = await store.search(["vector-prefix"], {
          query: "apple",
          limit: 10,
        });
        expect(prefixed.map((item) => item.key)).toEqual(["apple", "car"]);

        const offset = await store.search(["vector-prefix"], {
          query: "apple",
          offset: 1,
          limit: 1,
        });
        expect(offset.map((item) => item.key)).toEqual(["car"]);
      },
      { index: indexConfig }
    );
  });

  test("returns no vector results when filters match nothing", async () => {
    await withStore(
      async (store) => {
        await store.put(["vectors"], "apple", {
          text: "apple fruit",
          color: "red",
        });

        await expect(
          store.search(["vectors"], {
            query: "apple",
            filter: { color: "blue" },
          })
        ).resolves.toEqual([]);
      },
      { index: indexConfig }
    );
  });

  test("supports per-put index false and removes stale vector rows on delete", async () => {
    await withStore(
      async (store) => {
        await store.put(["vectors"], "indexed", {
          text: "apple fruit",
          color: "red",
        });
        await store.put(
          ["vectors"],
          "not-indexed",
          { text: "apple fruit", color: "red" },
          false
        );
        await store.put(
          ["vectors"],
          "filtered-out",
          { text: "apple fruit", color: "blue" },
          false
        );

        const initial = await store.search(["vectors"], {
          query: "apple",
          filter: { color: "red" },
          limit: 10,
        });
        expect(initial.map((item) => item.key)).toEqual([
          "indexed",
          "not-indexed",
        ]);
        expect(initial[0].score).toEqual(expect.any(Number));
        expect(initial[1].score).toBeUndefined();

        const paged = await store.search(["vectors"], {
          query: "apple",
          filter: { color: "red" },
          offset: 1,
          limit: 1,
        });
        expect(paged.map((item) => item.key)).toEqual(["not-indexed"]);
        expect(paged[0].score).toBeUndefined();

        await store.delete(["vectors"], "indexed");
        const afterDelete = await store.search(["vectors"], {
          query: "apple",
          filter: { color: "red" },
          limit: 10,
        });
        expect(afterDelete.map((item) => item.key)).toEqual(["not-indexed"]);
        expect(afterDelete[0].score).toBeUndefined();
      },
      { index: indexConfig }
    );
  });

  test("clears stale vectors when updating an indexed item with index false", async () => {
    await withStore(
      async (store) => {
        await store.put(["vectors"], "doc", { text: "apple fruit" });
        await expect(
          store.search(["vectors"], { query: "apple", limit: 10 })
        ).resolves.toEqual([
          expect.objectContaining({ key: "doc" }),
        ]);

        await store.put(["vectors"], "doc", { text: "apple fruit" }, false);
        const results = await store.search(["vectors"], {
          query: "apple",
          limit: 10,
        });
        expect(results.map((item) => item.key)).toEqual(["doc"]);
        expect(results[0].score).toBeUndefined();
      },
      { index: indexConfig }
    );
  });

  test("supports per-put field overrides and update re-indexing", async () => {
    await withStore(
      async (store) => {
        await store.put(
          ["vectors"],
          "doc",
          { title: "apple fruit", body: "fast car" },
          ["title"]
        );
        await expect(
          store.search(["vectors"], { query: "apple", limit: 1 })
        ).resolves.toEqual([
          expect.objectContaining({ key: "doc", score: expect.any(Number) }),
        ]);

        await store.put(
          ["vectors"],
          "doc",
          { title: "unrelated", body: "fast car" },
          ["body"]
        );
        const carResults = await store.search(["vectors"], {
          query: "car",
          limit: 1,
        });
        expect(carResults[0]).toMatchObject({ key: "doc" });
        expect(carResults[0].value).toEqual({
          title: "unrelated",
          body: "fast car",
        });
      },
      { index: indexConfig }
    );
  });

  test("creates vector schema when index config is added after JSON-only setup", async () => {
    const prefix = uniquePrefix();
    const jsonStore = new OracleStore({
      connection: oracleConnection,
      tablePrefix: prefix,
    });
    const vectorStore = new OracleStore({
      connection: oracleConnection,
      tablePrefix: prefix,
      index: indexConfig,
    });

    try {
      await jsonStore.start();
      await jsonStore.stop();

      await vectorStore.put(["vectors"], "doc", { text: "apple fruit" });
      const results = await vectorStore.search(["vectors"], {
        query: "apple",
      });
      expect(results.map((item) => item.key)).toEqual(["doc"]);
    } finally {
      await jsonStore.stop();
      await vectorStore.stop();
      await dropStoreTables(prefix);
    }
  });

  test("supports concurrent vector setup from separate store instances", async () => {
    const prefix = uniquePrefix();
    const storeA = new OracleStore({
      connection: oracleConnection,
      tablePrefix: prefix,
      index: indexConfig,
    });
    const storeB = new OracleStore({
      connection: oracleConnection,
      tablePrefix: prefix,
      index: indexConfig,
    });

    try {
      await Promise.all([storeA.start(), storeB.start()]);
      await storeA.put(["vectors"], "doc", { text: "apple fruit" });
      const results = await storeB.search(["vectors"], {
        query: "apple",
        limit: 1,
      });
      expect(results.map((item) => item.key)).toEqual(["doc"]);
    } finally {
      await storeA.stop();
      await storeB.stop();
      await dropStoreTables(prefix);
    }
  });

  test("supports realistic compact 1536-dimensional vectors", async () => {
    const dims = 1536;
    const vector = Array.from({ length: dims }, (_, index) =>
      index === 0 ? 1 : 0
    );
    const largeEmbeddings = {
      async embedDocuments(texts: string[]): Promise<number[][]> {
        return texts.map(() => vector);
      },
      async embedQuery(): Promise<number[]> {
        return vector;
      },
    };

    await withStore(
      async (store) => {
        await store.put(["large-vectors"], "doc", { text: "apple fruit" });
        await expect(
          store.search(["large-vectors"], { query: "apple", limit: 1 })
        ).resolves.toEqual([
          expect.objectContaining({ key: "doc", score: expect.any(Number) }),
        ]);
      },
      {
        index: {
          dims,
          embeddings: largeEmbeddings as unknown as IndexConfig["embeddings"],
          fields: ["text"],
        },
      }
    );
  });

  test("rejects vector literals that exceed Oracle string bind limits", async () => {
    const dims = 3072;
    const longVector = Array.from({ length: dims }, () => Math.PI);
    const oversizedDocumentEmbeddings = {
      async embedDocuments(texts: string[]): Promise<number[][]> {
        return texts.map(() => longVector);
      },
      async embedQuery(): Promise<number[]> {
        return new Array(dims).fill(0);
      },
    };

    await withStore(
      async (store) => {
        await expect(
          store.put(["oversized-vectors"], "doc", { text: "apple fruit" })
        ).rejects.toThrow("OracleStore vector literal exceeds 32767 bytes");
      },
      {
        index: {
          dims,
          embeddings:
            oversizedDocumentEmbeddings as unknown as IndexConfig["embeddings"],
          fields: ["text"],
        },
      }
    );

    const oversizedQueryEmbeddings = {
      async embedDocuments(): Promise<number[][]> {
        return [new Array(dims).fill(0)];
      },
      async embedQuery(): Promise<number[]> {
        return longVector;
      },
    };

    await withStore(
      async (store) => {
        await store.put(["oversized-query"], "doc", { text: "apple fruit" }, false);
        await expect(
          store.search(["oversized-query"], { query: "apple", limit: 1 })
        ).rejects.toThrow("OracleStore vector literal exceeds 32767 bytes");
      },
      {
        index: {
          dims,
          embeddings:
            oversizedQueryEmbeddings as unknown as IndexConfig["embeddings"],
          fields: ["text"],
        },
      }
    );
  });

  test("validates embedding dimensions", async () => {
    await withStore(
      async (store) => {
        await expect(
          store.put(["vectors"], "bad", { text: "apple fruit" })
        ).rejects.toThrow("embedding dimension mismatch");
      },
      {
        index: {
          dims: 4,
          embeddings: testEmbeddings as IndexConfig["embeddings"],
          fields: ["text"],
        },
      }
    );
  });

  test("validates embedding values before writing vectors", async () => {
    const invalidEmbeddings = {
      async embedDocuments(): Promise<number[][]> {
        return [[1, Number.NaN, 0]];
      },
      async embedQuery(): Promise<number[]> {
        return [1, 0, 0];
      },
    };

    await withStore(
      async (store) => {
        await expect(
          store.put(["vectors"], "bad", { text: "apple fruit" })
        ).rejects.toThrow("OracleStore embedding values must be finite numbers");
      },
      {
        index: {
          dims: 3,
          embeddings: invalidEmbeddings as unknown as IndexConfig["embeddings"],
          fields: ["text"],
        },
      }
    );
  });

  test("validates query embedding values before vector search", async () => {
    const invalidQueryEmbeddings = {
      async embedDocuments(): Promise<number[][]> {
        return [[1, 0, 0]];
      },
      async embedQuery(): Promise<number[]> {
        return [1, Number.POSITIVE_INFINITY, 0];
      },
    };

    await withStore(
      async (store) => {
        await store.put(["vectors"], "ok", { text: "apple fruit" });
        await expect(
          store.search(["vectors"], { query: "apple" })
        ).rejects.toThrow("OracleStore embedding values must be finite numbers");
      },
      {
        index: {
          dims: 3,
          embeddings:
            invalidQueryEmbeddings as unknown as IndexConfig["embeddings"],
          fields: ["text"],
        },
      }
    );
  });

  test("detects existing vector table dimension mismatch", async () => {
    const prefix = uniquePrefix();
    const store = new OracleStore({
      connection: oracleConnection,
      tablePrefix: prefix,
      index: indexConfig,
    });
    const mismatchedStore = new OracleStore({
      connection: oracleConnection,
      tablePrefix: prefix,
      index: {
        dims: 4,
        embeddings: testEmbeddings as IndexConfig["embeddings"],
        fields: ["text"],
      },
    });

    try {
      await store.start();
      await store.stop();

      await expect(mismatchedStore.start()).rejects.toThrow(
        "OracleStore vector table is incompatible with index dims 4"
      );
    } finally {
      await store.stop();
      await mismatchedStore.stop();
      await dropStoreTables(prefix);
    }
  });
});
