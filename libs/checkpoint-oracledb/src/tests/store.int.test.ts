// Copyright (c) 2026, Oracle and/or its affiliates.
import { config } from "dotenv";
import oracledb from "oracledb";
import { describe, expect, test, type TestContext } from "vitest";

import {
  InvalidNamespaceError,
  type Item,
  type IndexConfig,
  type Operation,
  type SearchItem,
} from "@langchain/langgraph-checkpoint";

import { OracleStore, type OracleStoreOptions } from "../store/index.js";
import type { OracleIndexConfig } from "../store/index-config.js";
import { encodeStoreKey, namespacePath } from "../store/namespace.js";

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

const tableNames = (prefix: string): string[] =>
  [
    `STORE_VECTORS_${prefix}`,
    `VECTOR_MIGRATIONS_${prefix}`,
    `STORE_${prefix}`,
    `STORE_MIGRATIONS_${prefix}`,
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
    try {
      await connection.execute(
        `DELETE FROM STORE_CONFIGS WHERE table_suffix = :tableSuffix`,
        { tableSuffix: prefix }
      );
    } catch (error) {
      const code = (error as { errorNum?: number }).errorNum;
      if (code !== 942) throw error;
    }
    await connection.commit();
  } finally {
    await connection.close();
  }
}

type StoreConfigRecord = {
  detectedDims: number;
  distanceType: string;
  indexParams: unknown;
  embedFields: string;
};

async function readStoreConfig(
  tableSuffix: string
): Promise<StoreConfigRecord | null> {
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    const result = await connection.execute<{
      DETECTED_DIMS: number;
      DISTANCE_TYPE: string;
      INDEX_PARAMS: unknown;
      EMBED_FIELDS: string;
    }>(
      `SELECT detected_dims, distance_type, index_params, embed_fields
FROM STORE_CONFIGS
WHERE table_suffix = :tableSuffix`,
      { tableSuffix },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = result.rows?.[0];
    return row
      ? {
          detectedDims: Number(row.DETECTED_DIMS),
          distanceType: row.DISTANCE_TYPE,
          indexParams:
            typeof row.INDEX_PARAMS === "string"
              ? JSON.parse(row.INDEX_PARAMS)
              : row.INDEX_PARAMS,
          embedFields: row.EMBED_FIELDS,
        }
      : null;
  } finally {
    await connection.close();
  }
}

async function deleteStoreConfig(tableSuffix: string): Promise<void> {
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    await connection.execute(
      `DELETE FROM STORE_CONFIGS WHERE table_suffix = :tableSuffix`,
      { tableSuffix }
    );
    await connection.commit();
  } finally {
    await connection.close();
  }
}

async function readStoreMigrationVersions(
  prefix: string
): Promise<number[]> {
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    const result = await connection.execute<{ V: number }>(
      `SELECT v FROM STORE_MIGRATIONS_${prefix.toUpperCase()} ORDER BY v`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []).map((row) => Number(row.V));
  } finally {
    await connection.close();
  }
}

async function readVectorMigrationVersions(
  prefix: string
): Promise<number[]> {
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    const result = await connection.execute<{ V: number }>(
      `SELECT v FROM VECTOR_MIGRATIONS_${prefix.toUpperCase()} ORDER BY v`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []).map((row) => Number(row.V));
  } finally {
    await connection.close();
  }
}

async function storeVectorIndexNames(prefix: string): Promise<string[]> {
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    const result = await connection.execute<{ INDEX_NAME: string }>(
      `SELECT i.index_name
FROM user_indexes i
JOIN user_ind_columns c
  ON c.index_name = i.index_name
WHERE i.table_name = :tableName
  AND c.column_name = 'EMBEDDING'
ORDER BY i.index_name`,
      { tableName: `STORE_VECTORS_${prefix.toUpperCase()}` },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []).map((row) => row.INDEX_NAME);
  } finally {
    await connection.close();
  }
}

async function userIndexExists(indexName: string): Promise<boolean> {
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    const result = await connection.execute<{
      INDEX_COUNT: number;
      index_count?: number;
    }>(
      `SELECT COUNT(*) AS index_count
FROM user_indexes
WHERE index_name = :indexName`,
      { indexName: indexName.toUpperCase() },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = result.rows?.[0];
    return Number(row?.INDEX_COUNT ?? row?.index_count ?? 0) > 0;
  } finally {
    await connection.close();
  }
}

async function countStoreRows(
  prefix: string,
  tableSuffix: "STORE" | "STORE_VECTORS",
  namespace: string[],
  key: string
): Promise<number> {
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    const result = await connection.execute<{
      ROW_COUNT: number;
      row_count?: number;
    }>(
      `SELECT COUNT(*) AS row_count
FROM ${tableSuffix}_${prefix.toUpperCase()}
WHERE prefix = :namespacePath AND key = :key`,
      {
        namespacePath: namespacePath(namespace),
        key: encodeStoreKey(key),
      },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = result.rows?.[0];
    return Number(row?.ROW_COUNT ?? row?.row_count ?? 0);
  } finally {
    await connection.close();
  }
}

async function setStoreExpiration(
  tableSuffix: string,
  namespace: string[],
  key: string,
  minutesFromNow: number
): Promise<void> {
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    await connection.execute(
      `UPDATE STORE_${tableSuffix.toUpperCase()}
SET expires_at = CURRENT_TIMESTAMP + NUMTODSINTERVAL(:minutesFromNow, 'MINUTE')
WHERE prefix = :namespacePath AND key = :key`,
      {
        minutesFromNow,
        namespacePath: namespacePath(namespace),
        key: encodeStoreKey(key),
      }
    );
    await connection.commit();
  } finally {
    await connection.close();
  }
}

async function readStoreTtl(
  tableSuffix: string,
  namespace: string[],
  key: string,
  minimumMinutesRemaining = 0
): Promise<{ ttlMinutes: number | null; beyondMinimum: boolean } | null> {
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    const result = await connection.execute<{
      TTL_MINUTES: number | null;
      BEYOND_MINIMUM: number;
    }>(
      `SELECT ttl_minutes,
  CASE
    WHEN expires_at > CURRENT_TIMESTAMP + NUMTODSINTERVAL(:minimumMinutesRemaining, 'MINUTE')
    THEN 1 ELSE 0
  END AS beyond_minimum
FROM STORE_${tableSuffix.toUpperCase()}
WHERE prefix = :namespacePath AND key = :key`,
      {
        minimumMinutesRemaining,
        namespacePath: namespacePath(namespace),
        key: encodeStoreKey(key),
      },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = result.rows?.[0];
    return row
      ? {
          ttlMinutes:
            row.TTL_MINUTES === null ? null : Number(row.TTL_MINUTES),
          beyondMinimum: Number(row.BEYOND_MINIMUM) === 1,
        }
      : null;
  } finally {
    await connection.close();
  }
}

function oracleErrorCode(error: unknown): number | string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { errorNum?: number; code?: string | number })
    .errorNum;
  return code ?? (error as { code?: string | number }).code;
}

function isOracleError(error: unknown, code: number): boolean {
  const actual = oracleErrorCode(error);
  return actual === code || actual === `ORA-${String(code).padStart(5, "0")}`;
}

function skipIfHnswMemoryUnavailable(
  context: TestContext,
  error: unknown
): void {
  // Setup wraps this driver error to explain the fix, so check the chain.
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if (isOracleError(current, 51962)) {
      context.skip(
        "Oracle VECTOR memory area is unavailable for HNSW indexes."
      );
    }
  }
}

async function withStore<T>(
  callback: (store: OracleStore, prefix: string) => Promise<T>,
  options: Omit<OracleStoreOptions, "connection" | "tableSuffix"> & {
    context?: TestContext;
  } = {}
): Promise<T> {
  const { context, ...storeOptions } = options;
  const prefix = uniquePrefix();
  const store = new OracleStore({
    connection: oracleConnection,
    tableSuffix: prefix,
    ...storeOptions,
  });
  try {
    return await callback(store, prefix);
  } catch (error) {
    // Setting up a store with an HNSW index now creates that index, which
    // needs a vector memory area, so give the whole test the same skip the
    // explicit index tests use.
    if (context) skipIfHnswMemoryUnavailable(context, error);
    throw error;
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

const indexConfig: OracleIndexConfig = {
  dims: 3,
  embeddings: testEmbeddings as IndexConfig["embeddings"],
  fields: ["text"],
};

type StoreVectorBindStrategyProbe = {
  vectorBindStrategy?: "native" | "string";
};

function vectorBindStrategy(
  store: OracleStore
): "native" | "string" | undefined {
  return (store as unknown as StoreVectorBindStrategyProbe).vectorBindStrategy;
}

function forceStringVectorBinds(store: OracleStore): void {
  (store as unknown as StoreVectorBindStrategyProbe).vectorBindStrategy =
    "string";
}

function derivedTableSuffix(store: OracleStore): string {
  return (store as unknown as { tableSuffix: string }).tableSuffix;
}

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

  test("supports TTL writes, expiration-aware reads, and manual sweeping", async () => {
    await withStore(
      async (store, tableSuffix) => {
        const expiredNamespace = ["ttl", "expired"];
        const activeNamespace = ["ttl", "active"];
        await store.put(expiredNamespace, "default", { state: "expired" });
        await store.put(
          activeNamespace,
          "override",
          { state: "active" },
          undefined,
          { ttl: 5 }
        );

        await expect(
          readStoreTtl(tableSuffix, expiredNamespace, "default")
        ).resolves.toMatchObject({ ttlMinutes: 30 });
        await expect(
          readStoreTtl(tableSuffix, activeNamespace, "override")
        ).resolves.toMatchObject({ ttlMinutes: 5 });

        await setStoreExpiration(
          tableSuffix,
          expiredNamespace,
          "default",
          -1
        );

        await expect(store.get(expiredNamespace, "default")).resolves.toBeNull();
        await expect(store.search(["ttl"], { limit: 10 })).resolves.toEqual([
          expect.objectContaining({ key: "override" }),
        ]);
        await expect(
          store.listNamespaces({ prefix: ["ttl"] })
        ).resolves.toEqual([activeNamespace]);

        await expect(store.sweepExpiredItems()).resolves.toBe(1);
        await expect(
          countStoreRows(tableSuffix, "STORE", expiredNamespace, "default")
        ).resolves.toBe(0);
      },
      { ttl: { defaultTtl: 30 } }
    );
  });

  test("refreshes stored TTL on get and on requested searches", async () => {
    await withStore(
      async (store, tableSuffix) => {
        const namespace = ["ttl", "refresh"];
        await store.put(namespace, "get", { source: "get" });

        await setStoreExpiration(tableSuffix, namespace, "get", 0.1);
        await store.get(namespace, "get");
        await expect(
          readStoreTtl(tableSuffix, namespace, "get", 4)
        ).resolves.toMatchObject({ ttlMinutes: 5, beyondMinimum: true });

      },
      { ttl: { defaultTtl: 5, refreshOnRead: true } }
    );

    await withStore(
      async (store, tableSuffix) => {
        const namespace = ["ttl", "refresh"];
        await store.put(namespace, "search", { source: "search" });
        await setStoreExpiration(tableSuffix, namespace, "search", 0.1);
        await store.search(namespace, {
          filter: { source: "search" },
          refreshTtl: true,
        });
        await expect(
          readStoreTtl(tableSuffix, namespace, "search", 4)
        ).resolves.toMatchObject({ ttlMinutes: 5, beyondMinimum: true });
      },
      { ttl: { defaultTtl: 5 } }
    );
  });

  test("rejects empty keys and round-trips encoded-looking keys", async () => {
    await withStore(async (store) => {
      const namespace = ["keys"];
      await expect(
        store.put(namespace, "", { value: "empty" })
      ).rejects.toThrow("OracleStore keys cannot be empty strings");
      await store.put(namespace, "b64:literal", { value: "literal" });

      await expect(store.get(namespace, "b64:literal")).resolves.toMatchObject({
        key: "b64:literal",
        value: { value: "literal" },
      });

      await expect(store.search(namespace, { limit: 10 })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "b64:literal" }),
        ])
      );
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

  test("handles large mixed batch operations without result reordering", async () => {
    await withStore(async (store) => {
      const namespace = ["batch-stress", "mixed"];
      const putOps = Array.from({ length: 75 }, (_, index) => ({
        namespace,
        key: `item-${index.toString().padStart(3, "0")}`,
        value: {
          index,
          group: index % 2 === 0 ? "even" : "odd",
        },
      }));
      const getIndex = putOps.length;
      const searchIndex = getIndex + 1;
      const namespaceIndex = searchIndex + 1;
      const deleteIndex = namespaceIndex + 1;
      const deletedGetIndex = deleteIndex + 1;
      const updateIndex = deletedGetIndex + 1;
      const updatedGetIndex = updateIndex + 1;
      const operations: Operation[] = [
        ...putOps,
        { namespace, key: "item-010" },
        {
          namespacePrefix: ["batch-stress"],
          filter: { group: "even" },
          limit: 100,
          offset: 0,
        },
        {
          matchConditions: [{ matchType: "prefix", path: ["batch-stress"] }],
          maxDepth: 2,
          limit: 10,
          offset: 0,
        },
        { namespace, key: "item-020", value: null },
        { namespace, key: "item-020" },
        {
          namespace,
          key: "item-010",
          value: { index: 10, group: "even", updated: true },
        },
        { namespace, key: "item-010" },
      ];

      const results = await store.batch(operations);
      expect(results).toHaveLength(operations.length);
      for (let i = 0; i < putOps.length; i += 1) {
        expect(results[i]).toBeUndefined();
      }

      expect(results[getIndex] as Item).toMatchObject({
        key: "item-010",
        value: { index: 10, group: "even" },
      });

      const searchResults = results[searchIndex] as SearchItem[];
      expect(searchResults).toHaveLength(38);
      expect(searchResults[0]).toMatchObject({
        key: "item-000",
        value: { index: 0, group: "even" },
      });
      expect(searchResults[searchResults.length - 1]).toMatchObject({
        key: "item-074",
        value: { index: 74, group: "even" },
      });

      expect(results[namespaceIndex] as string[][]).toEqual([
        ["batch-stress", "mixed"],
      ]);
      expect(results[deleteIndex]).toBeUndefined();
      expect(results[deletedGetIndex]).toBeNull();
      expect(results[updateIndex]).toBeUndefined();
      expect(results[updatedGetIndex] as Item).toMatchObject({
        key: "item-010",
        value: { index: 10, group: "even", updated: true },
      });
    });
  });

  test("searches namespace prefixes with limit and offset", async () => {
    await withStore(async (store) => {
      await store.put(["docs"], "root", { order: 0 });
      await store.put(["docs", "a"], "a", { order: 1 });
      await store.put(["docs", "b"], "b", { order: 2 });
      await store.put(["other"], "other", { order: 3 });

      // Ordering is updated_at DESC (as in Python), which can tie for writes
      // this close together, so assert pagination against the full result.
      const allDocs = await store.search(["docs"], { limit: 10 });
      expect(new Set(allDocs.map((item) => item.key))).toEqual(
        new Set(["a", "b", "root"])
      );

      const paged = await store.search(["docs"], { offset: 1, limit: 1 });
      expect(paged.map((item) => item.key)).toEqual(
        allDocs.map((item) => item.key).slice(1, 2)
      );
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

      await expect(
        store.listNamespaces({ prefix: ["docs_%"] })
      ).resolves.toEqual([["docs_%", "a"]]);

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

      await expect(
        store.search(["concurrent"], { limit: 10 })
      ).resolves.toEqual(
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

  test("persists JSON store data across store instances with the same prefix", async () => {
    const prefix = uniquePrefix();
    let firstStore: OracleStore | undefined;
    let secondStore: OracleStore | undefined;
    const namespace = ["sessions", "json-persist"];

    try {
      firstStore = new OracleStore({
        connection: oracleConnection,
        tableSuffix: prefix,
      });
      await firstStore.put(namespace, "sync_key_1", {
        question: "What is sync persistence?",
        answer: "Data survives between sessions.",
        timestamp: 12345,
      });
      await firstStore.stop();

      secondStore = new OracleStore({
        connection: oracleConnection,
        tableSuffix: prefix,
      });
      await expect(
        secondStore.get(namespace, "sync_key_1")
      ).resolves.toMatchObject({
        key: "sync_key_1",
        namespace,
        value: {
          question: "What is sync persistence?",
          answer: "Data survives between sessions.",
          timestamp: 12345,
        },
      });

      await secondStore.put(namespace, "sync_key_2", {
        source: "second-session",
      });
      await expect(
        secondStore.search(["sessions"], { limit: 10 })
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "sync_key_1", namespace }),
          expect.objectContaining({ key: "sync_key_2", namespace }),
        ])
      );
    } finally {
      await firstStore?.stop();
      await secondStore?.stop();
      await dropStoreTables(prefix);
    }
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
      ).resolves.toEqual([expect.objectContaining({ key: "one" })]);
    });
  });

  test("handles boolean, numeric, and special-character filter combinations", async () => {
    await withStore(async (store) => {
      const namespace = ["filter-key-combos"];
      await store.put(namespace, "boolean-true", {
        enabled: true,
        active: true,
        archived: false,
        visible: true,
      });
      await store.put(namespace, "boolean-false", {
        enabled: false,
        active: false,
        archived: true,
        visible: false,
      });
      await store.put(namespace, "zero", { count: 0 });
      await store.put(namespace, "negative", { count: -42 });
      await store.put(namespace, "single-quote", { text: "Hello 'World'" });
      await store.put(namespace, "double-quote", { text: 'Test "quotes"' });
      await store.put(namespace, "path", { path: "/usr/local/bin" });
      await store.put(namespace, "sql-text", { query: "SELECT * FROM table" });

      await expect(
        store.search(namespace, { filter: { enabled: true } })
      ).resolves.toEqual([expect.objectContaining({ key: "boolean-true" })]);
      await expect(
        store.search(namespace, { filter: { enabled: false } })
      ).resolves.toEqual([expect.objectContaining({ key: "boolean-false" })]);
      await expect(
        store.search(namespace, {
          filter: { active: true, archived: false, visible: true },
        })
      ).resolves.toEqual([expect.objectContaining({ key: "boolean-true" })]);
      await expect(
        store.search(namespace, { filter: { count: 0 } })
      ).resolves.toEqual([expect.objectContaining({ key: "zero" })]);
      await expect(
        store.search(namespace, { filter: { count: { $lt: -1 } } })
      ).resolves.toEqual([expect.objectContaining({ key: "negative" })]);
      await expect(
        store.search(namespace, { filter: { text: "Hello 'World'" } })
      ).resolves.toEqual([expect.objectContaining({ key: "single-quote" })]);
      await expect(
        store.search(namespace, { filter: { text: 'Test "quotes"' } })
      ).resolves.toEqual([expect.objectContaining({ key: "double-quote" })]);
      await expect(
        store.search(namespace, { filter: { path: "/usr/local/bin" } })
      ).resolves.toEqual([expect.objectContaining({ key: "path" })]);
      await expect(
        store.search(namespace, { filter: { query: "SELECT * FROM table" } })
      ).resolves.toEqual([expect.objectContaining({ key: "sql-text" })]);
    });
  });

  test("searches mixed edge filters with pagination across nested prefixes", async () => {
    await withStore(async (store) => {
      const tenantA = ["search-matrix", "tenant-a", "docs"];
      const tenantB = ["search-matrix", "tenant-b", "docs"];
      await store.put(tenantA, "a-zero", {
        status: "published",
        score: 0,
        price: 0.5,
        enabled: true,
        title: "quoted 'SQL'",
        query: "SELECT * FROM memories WHERE owner = 'alice'",
        tenant: "a",
      });
      await store.put(tenantA, "b-negative", {
        status: "draft",
        score: -3,
        price: -1.25,
        enabled: false,
        title: 'double "quote"',
        query: "DROP TABLE memories",
        tenant: "a",
      });
      await store.put(tenantA, "c-float", {
        status: "published",
        score: 3.14,
        price: 9.75,
        enabled: true,
        title: "plain",
        query: "path /tmp/store",
        tenant: "a",
      });
      await store.put(tenantB, "d-beta", {
        status: "published",
        score: 42,
        price: 10.5,
        enabled: true,
        title: "beta",
        query: "tenant b",
        tenant: "b",
      });

      await expect(
        store.search(["search-matrix"], {
          filter: { title: { $eq: "quoted 'SQL'" } },
          limit: 10,
        })
      ).resolves.toEqual([expect.objectContaining({ key: "a-zero" })]);
      await expect(
        store.search(["search-matrix"], {
          filter: { status: { $ne: "published" } },
          limit: 10,
        })
      ).resolves.toEqual([expect.objectContaining({ key: "b-negative" })]);
      await expect(
        store.search(["search-matrix"], {
          filter: { score: { $gt: 0 } },
          limit: 10,
        })
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "c-float" }),
          expect.objectContaining({ key: "d-beta" }),
        ])
      );
      await expect(
        store.search(["search-matrix"], {
          filter: { score: { $gte: 0 } },
          limit: 10,
        })
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "a-zero" }),
          expect.objectContaining({ key: "c-float" }),
          expect.objectContaining({ key: "d-beta" }),
        ])
      );
      await expect(
        store.search(["search-matrix"], {
          filter: { score: { $lt: 0 } },
          limit: 10,
        })
      ).resolves.toEqual([expect.objectContaining({ key: "b-negative" })]);
      await expect(
        store.search(["search-matrix"], {
          filter: { score: { $lte: 0 } },
          limit: 10,
        })
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "a-zero" }),
          expect.objectContaining({ key: "b-negative" }),
        ])
      );
      await expect(
        store.search(["search-matrix"], {
          filter: { enabled: false, query: "DROP TABLE memories" },
          limit: 10,
        })
      ).resolves.toEqual([expect.objectContaining({ key: "b-negative" })]);

      const publishedFilter = { status: "published", enabled: true };
      const allPublished = await store.search(["search-matrix"], {
        filter: publishedFilter,
        limit: 10,
      });
      const paged = await store.search(["search-matrix"], {
        filter: publishedFilter,
        offset: 1,
        limit: 2,
      });
      expect(paged.map((item) => item.key)).toEqual(
        allPublished.map((item) => item.key).slice(1, 3)
      );

      const tenantAResults = await store.search(["search-matrix", "tenant-a"], {
        filter: { tenant: "a" },
        limit: 10,
      });
      expect(new Set(tenantAResults.map((item) => item.key))).toEqual(
        new Set(["a-zero", "b-negative", "c-float"])
      );
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

  test("uses Python OracleStore numeric coercion for range filters", async () => {
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
      expect(new Set(gteNumber.map((item) => item.key))).toEqual(
        new Set(["number", "numeric-string"])
      );

      const ltString = await store.search(["range-coercion"], {
        filter: { score: { $lt: "10" } },
        limit: 10,
      });
      expect(new Set(ltString.map((item) => item.key))).toEqual(
        new Set(["numeric-string", "zero"])
      );
    });
  });

  test("lists namespaces with prefix, suffix, wildcards, maxDepth, and pagination", async () => {
    await withStore(async (store) => {
      await store.put(["a", "b", "c"], "1", { value: 1 });
      await store.put(["a", "b", "d", "e"], "2", { value: 2 });
      await store.put(["a", "b", "d", "i"], "3", { value: 3 });
      await store.put(["x", "b", "c"], "4", { value: 4 });

      await expect(
        store.listNamespaces({ prefix: ["a", "b"] })
      ).resolves.toEqual([
        ["a", "b", "c"],
        ["a", "b", "d", "e"],
        ["a", "b", "d", "i"],
      ]);

      await expect(
        store.listNamespaces({ suffix: ["b", "c"] })
      ).resolves.toEqual([
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
      await expect(store.put([""], "bad", { ok: true })).rejects.toBeInstanceOf(
        InvalidNamespaceError
      );
      await expect(
        store.put(["langgraph"], "bad", { ok: true })
      ).rejects.toBeInstanceOf(InvalidNamespaceError);
      await expect(
        store.put(["ok", "langgraph"], "good", { ok: true })
      ).resolves.toBeUndefined();

      await expect(
        store.put(["ok", 123 as unknown as string], "bad", { ok: true })
      ).rejects.toBeInstanceOf(InvalidNamespaceError);
      await expect(
        store.batch([{ namespace: [], key: "bad", value: null }])
      ).rejects.toBeInstanceOf(InvalidNamespaceError);
    });
  });

  test("ignores a query when no index is configured, as Python does", async () => {
    await withStore(async (store) => {
      await store.put(["query"], "apple", { text: "apple fruit", kind: "a" });
      await store.put(["query"], "car", { text: "car vehicle", kind: "b" });

      // Python drops the query string and returns the filtered listing with a
      // null score rather than raising.
      const results = await store.search(["query"], { query: "apple" });
      expect(new Set(results.map((item) => item.key))).toEqual(
        new Set(["apple", "car"])
      );
      expect(results.every((item) => item.score === undefined)).toBe(true);

      // Filters and pagination still apply to the ignored-query listing.
      const filtered = await store.search(["query"], {
        query: "apple",
        filter: { kind: "b" },
      });
      expect(filtered.map((item) => item.key)).toEqual(["car"]);
    });
  });
});

describeIfOracle("OracleStore configured vector index", () => {
  test("leaves search semantics unchanged with an HNSW index", async (context) => {
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

        const results = await store.search(["vectors"], {
          query: "apple",
          filter: { color: "red" },
          limit: 10,
        });
        // Items written with index=false have no vector row, so a vector
        // search does not return them at all.
        expect(results.map((item) => item.key)).toEqual(["indexed"]);
        expect(results[0].score).toEqual(expect.any(Number));
      },
      {
        index: {
          ...indexConfig,
          accuracy: 90,
          index_type: { type: "hnsw", neighbors: 2, efconstruction: 4 },
        },
        context,
      }
    );
  });

  test("honours a caller supplied index name and parallelism", async () => {
    const indexName = `${uniquePrefix()}NAMED_IVF_IDX`.toUpperCase();
    await withStore(
      async (store, prefix) => {
        await store.put(["vectors"], "doc", { text: "apple fruit" });

        await expect(userIndexExists(indexName)).resolves.toBe(true);
        await expect(storeVectorIndexNames(prefix)).resolves.toEqual([
          indexName,
        ]);
      },
      {
        index: {
          ...indexConfig,
          index_name: indexName,
          parallel: 1,
          index_type: { type: "ivf", neighbor_partitions: 1 },
        },
      }
    );
  });

  test("validates the index name before executing DDL", () => {
    for (const indexName of [
      "1BAD",
      "BAD NAME",
      'BAD"NAME',
      "BAD-NAME",
      "BAD;DROP TABLE X",
    ]) {
      expect(
        () =>
          new OracleStore({
            connection: oracleConnection,
            index: { ...indexConfig, index_name: indexName },
          })
      ).toThrow("Invalid Oracle identifier");
    }
  });

  test("validates parallelism before executing DDL", () => {
    for (const parallel of [0, -1, 1.5, "8) --" as never]) {
      expect(
        () =>
          new OracleStore({
            connection: oracleConnection,
            index: { ...indexConfig, parallel },
          })
      ).toThrow("index parallel must be");
    }
  });
});

describeIfOracle("OracleStore vector search", () => {
  test("validates index dimensions before setup", async () => {
    for (const dims of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(
        () =>
          new OracleStore({
            connection: oracleConnection,
            tableSuffix: uniquePrefix(),
            index: {
              dims,
              embeddings: testEmbeddings as IndexConfig["embeddings"],
            },
          })
      ).toThrow("OracleStore index dims must be an integer between 1 and");
    }
  });

  test("excludes expired items from vector search", async () => {
    await withStore(
      async (store, tableSuffix) => {
        const namespace = ["vectors", "ttl"];
        await store.put(namespace, "apple", { text: "apple fruit" });
        await setStoreExpiration(tableSuffix, namespace, "apple", -1);

        await expect(
          store.search(["vectors"], { query: "apple", limit: 10 })
        ).resolves.toEqual([]);
      },
      { index: indexConfig, ttl: { defaultTtl: 5 } }
    );
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
        await store.put(["vector-prefix", "child"], "car", {
          text: "fast car",
        });
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
        // Only "indexed" has a vector row; index=false items are absent from
        // vector search results entirely.
        expect(initial.map((item) => item.key)).toEqual(["indexed"]);
        expect(initial[0].score).toEqual(expect.any(Number));

        const paged = await store.search(["vectors"], {
          query: "apple",
          filter: { color: "red" },
          offset: 1,
          limit: 1,
        });
        expect(paged).toEqual([]);

        await store.delete(["vectors"], "indexed");
        const afterDelete = await store.search(["vectors"], {
          query: "apple",
          filter: { color: "red" },
          limit: 10,
        });
        expect(afterDelete).toEqual([]);
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
        ).resolves.toEqual([expect.objectContaining({ key: "doc" })]);

        await store.put(["vectors"], "doc", { text: "apple fruit" }, false);
        // The vector rows are gone, so the item drops out of vector search
        // entirely, but the item itself is still stored.
        await expect(
          store.search(["vectors"], { query: "apple", limit: 10 })
        ).resolves.toEqual([]);
        await expect(store.get(["vectors"], "doc")).resolves.toMatchObject({
          value: { text: "apple fruit" },
        });
      },
      { index: indexConfig }
    );
  });

  test("clears stale vectors when JSON-only stores update or delete indexed items", async () => {
    const prefix = uniquePrefix();
    const namespace = ["vectors", "mixed-config"];
    const vectorStore = new OracleStore({
      connection: oracleConnection,
      tableSuffix: prefix,
      index: indexConfig,
    });
    const jsonStore = new OracleStore({
      connection: oracleConnection,
      tableSuffix: prefix,
    });

    try {
      await vectorStore.put(namespace, "doc", { text: "apple fruit" });
      expect(
        await countStoreRows(prefix, "STORE_VECTORS", namespace, "doc")
      ).toBe(1);

      await jsonStore.put(namespace, "doc", { text: "banana fruit" });
      expect(
        await countStoreRows(prefix, "STORE_VECTORS", namespace, "doc")
      ).toBe(0);

      // The JSON-only write cleared the vector rows, so a vector search no
      // longer returns the item, while the updated value is still readable.
      const afterUpdate = await vectorStore.search(namespace, {
        query: "apple",
        limit: 10,
      });
      expect(afterUpdate).toEqual([]);
      await expect(vectorStore.get(namespace, "doc")).resolves.toMatchObject({
        value: { text: "banana fruit" },
      });

      await vectorStore.put(namespace, "deleted", { text: "apple fruit" });
      expect(
        await countStoreRows(prefix, "STORE_VECTORS", namespace, "deleted")
      ).toBe(1);

      await jsonStore.delete(namespace, "deleted");
      expect(await countStoreRows(prefix, "STORE", namespace, "deleted")).toBe(
        0
      );
      expect(
        await countStoreRows(prefix, "STORE_VECTORS", namespace, "deleted")
      ).toBe(0);
    } finally {
      await vectorStore.stop();
      await jsonStore.stop();
      await dropStoreTables(prefix);
    }
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
      tableSuffix: prefix,
    });
    const vectorStore = new OracleStore({
      connection: oracleConnection,
      tableSuffix: prefix,
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

  test("persists vector-indexed store data across store instances", async () => {
    const prefix = uniquePrefix();
    let firstStore: OracleStore | undefined;
    let secondStore: OracleStore | undefined;
    const namespace = ["sessions", "vector-persist"];

    try {
      firstStore = new OracleStore({
        connection: oracleConnection,
        tableSuffix: prefix,
        index: indexConfig,
      });
      await firstStore.put(namespace, "sync_vector_key_1", {
        text: "apple fruit persistence",
        question: "What is vector persistence?",
      });
      await firstStore.stop();

      secondStore = new OracleStore({
        connection: oracleConnection,
        tableSuffix: prefix,
        index: indexConfig,
      });
      await expect(
        secondStore.get(namespace, "sync_vector_key_1")
      ).resolves.toMatchObject({
        key: "sync_vector_key_1",
        namespace,
        value: {
          text: "apple fruit persistence",
          question: "What is vector persistence?",
        },
      });

      const results = await secondStore.search(namespace, {
        query: "fruit",
        limit: 5,
      });
      expect(results.map((item) => item.key)).toContain("sync_vector_key_1");
    } finally {
      await firstStore?.stop();
      await secondStore?.stop();
      await dropStoreTables(prefix);
    }
  });

  test("keeps one store/vector row for concurrent updates to the same key", async () => {
    const prefix = uniquePrefix();
    const store = new OracleStore({
      connection: oracleConnection,
      tableSuffix: prefix,
      index: indexConfig,
    });
    const namespace = ["vectors", "concurrent-key"];
    const key = "doc";

    try {
      await store.start();
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          store.put(namespace, key, {
            text: index % 2 === 0 ? "apple fruit" : "fast car",
            version: index,
          })
        )
      );

      await expect(store.get(namespace, key)).resolves.toMatchObject({
        key,
        namespace,
        value: {
          text: expect.any(String),
          version: expect.any(Number),
        },
      });
      await expect(
        countStoreRows(prefix, "STORE", namespace, key)
      ).resolves.toBe(1);
      await expect(
        countStoreRows(prefix, "STORE_VECTORS", namespace, key)
      ).resolves.toBe(1);

      const results = await store.search(namespace, {
        query: "apple",
        limit: 10,
      });
      expect(results.filter((item) => item.key === key)).toHaveLength(1);
    } finally {
      await store.stop();
      await dropStoreTables(prefix);
    }
  });

  test("supports concurrent vector setup from separate store instances", async () => {
    const prefix = uniquePrefix();
    const storeA = new OracleStore({
      connection: oracleConnection,
      tableSuffix: prefix,
      index: indexConfig,
    });
    const storeB = new OracleStore({
      connection: oracleConnection,
      tableSuffix: prefix,
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

  test("uses native vector binds for oversized dense vectors when available", async () => {
    const dims = 3072;
    const vector = Array.from({ length: dims }, () => Math.PI);
    const oversizedEmbeddings = {
      async embedDocuments(texts: string[]): Promise<number[][]> {
        return texts.map(() => vector);
      },
      async embedQuery(): Promise<number[]> {
        return vector;
      },
    };

    await withStore(
      async (store) => {
        await store.start();
        if (vectorBindStrategy(store) !== "native") return;

        await store.put(["native-vectors"], "doc", { text: "apple fruit" });
        await expect(
          store.search(["native-vectors"], { query: "apple", limit: 1 })
        ).resolves.toEqual([
          expect.objectContaining({ key: "doc", score: expect.any(Number) }),
        ]);
      },
      {
        index: {
          dims,
          embeddings:
            oversizedEmbeddings as unknown as IndexConfig["embeddings"],
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
        forceStringVectorBinds(store);
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
        forceStringVectorBinds(store);
        await store.put(
          ["oversized-query"],
          "doc",
          { text: "apple fruit" },
          false
        );
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
        ).rejects.toThrow(
          "OracleStore embedding values must be finite numbers"
        );
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
        ).rejects.toThrow(
          "OracleStore embedding values must be finite numbers"
        );
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
      tableSuffix: prefix,
      index: indexConfig,
    });
    const mismatchedStore = new OracleStore({
      connection: oracleConnection,
      tableSuffix: prefix,
      index: {
        dims: 4,
        embeddings: testEmbeddings as IndexConfig["embeddings"],
        fields: ["text"],
      },
    });

    try {
      await store.start();
      await store.stop();

      // The registered configuration catches this before the vector table is
      // touched.
      await expect(mismatchedStore.start()).rejects.toThrow(
        `Dimension mismatch for tableSuffix "${prefix}": existing 3 dimensions, provided 4`
      );
    } finally {
      await store.stop();
      await mismatchedStore.stop();
      await dropStoreTables(prefix);
    }
  });

  test("detects a dimension mismatch with no registered configuration", async () => {
    const prefix = uniquePrefix();
    const store = new OracleStore({
      connection: oracleConnection,
      tableSuffix: prefix,
      index: indexConfig,
    });
    const mismatchedStore = new OracleStore({
      connection: oracleConnection,
      tableSuffix: prefix,
      index: {
        dims: 4,
        embeddings: testEmbeddings as IndexConfig["embeddings"],
        fields: ["text"],
      },
    });

    try {
      await store.start();
      await store.stop();
      // Tables written by something that never registered a configuration,
      // so only the physical vector column can reveal the mismatch.
      await deleteStoreConfig(prefix);

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

describeIfOracle("OracleStore vector index configuration", () => {
  const ivfIndexConfig: OracleIndexConfig = {
    ...indexConfig,
    index_type: { type: "ivf", neighbor_partitions: 1 },
  };

  test("creates the configured vector index during setup", async (context) => {
    await withStore(
      async (store, prefix) => {
        await store.put(["vectors"], "doc", { text: "apple fruit" });

        const indexes = await storeVectorIndexNames(prefix);
        expect(indexes).toHaveLength(1);
        const vectorTable = `STORE_VECTORS_${prefix.toUpperCase()}`;
        expect(indexes[0].startsWith(`${vectorTable}_IDX_`)).toBe(true);
        expect(indexes[0].slice(`${vectorTable}_IDX_`.length)).toMatch(
          /^[0-9A-F]{6}$/
        );
        await expect(readVectorMigrationVersions(prefix)).resolves.toEqual([
          0, 1,
        ]);
      },
      { index: indexConfig, context }
    );
  });

  test("creates an IVF index from the store configuration", async () => {
    await withStore(
      async (store, prefix) => {
        await store.put(["vectors"], "doc", { text: "apple fruit" });

        await expect(storeVectorIndexNames(prefix)).resolves.toHaveLength(1);
        await expect(readVectorMigrationVersions(prefix)).resolves.toEqual([
          0, 1,
        ]);
      },
      { index: ivfIndexConfig }
    );
  });

  test("applies target accuracy and tuning parameters", async () => {
    await withStore(
      async (store, prefix) => {
        await store.put(["vectors"], "doc", { text: "apple fruit" });
        await expect(storeVectorIndexNames(prefix)).resolves.toHaveLength(1);
      },
      {
        index: {
          ...indexConfig,
          accuracy: 90,
          index_type: {
            type: "ivf",
            neighbor_partitions: 1,
            samples_per_partition: 2,
            min_vectors_per_partition: 0,
          },
        },
      }
    );
  });

  test("does not recreate the index on a second setup", async () => {
    const prefix = uniquePrefix();
    const options = {
      connection: oracleConnection,
      tableSuffix: prefix,
      index: ivfIndexConfig,
    };
    const first = new OracleStore(options);
    const second = new OracleStore(options);

    try {
      await first.start();
      const afterFirst = await storeVectorIndexNames(prefix);
      await second.start();
      const afterSecond = await storeVectorIndexNames(prefix);

      expect(afterFirst).toHaveLength(1);
      expect(afterSecond).toEqual(afterFirst);
      await expect(readVectorMigrationVersions(prefix)).resolves.toEqual([
        0, 1,
      ]);
    } finally {
      await first.stop();
      await second.stop();
      await dropStoreTables(prefix);
    }
  });

  test("ranks results with EUCLIDEAN distance", async () => {
    await withStore(
      async (store) => {
        await store.put(["vectors"], "fruit", { text: "apple fruit" });
        await store.put(["vectors"], "vehicle", { text: "car vehicle" });

        const results = await store.search(["vectors"], {
          query: "apple",
          limit: 2,
        });

        expect(results.map((item) => item.key)).toEqual(["fruit", "vehicle"]);
        // Euclidean scores are negated distances: identical vectors score 0.
        expect(results[0].score).toBeCloseTo(0, 5);
        expect(results[1].score).toBeLessThan(results[0].score!);
      },
      {
        index: {
          ...indexConfig,
          index_type: {
            type: "ivf",
            neighbor_partitions: 1,
            distance_metric: "EUCLIDEAN",
          },
        },
      }
    );
  });

  test("ranks results with DOT distance", async () => {
    await withStore(
      async (store) => {
        await store.put(["vectors"], "fruit", { text: "apple fruit" });
        await store.put(["vectors"], "vehicle", { text: "car vehicle" });

        const results = await store.search(["vectors"], {
          query: "apple",
          limit: 2,
        });

        expect(results.map((item) => item.key)).toEqual(["fruit", "vehicle"]);
        // DOT scores are inner products: 1 for the identical one-hot vector.
        expect(results[0].score).toBeCloseTo(1, 5);
        expect(results[1].score).toBeCloseTo(0, 5);
      },
      {
        index: {
          ...indexConfig,
          index_type: {
            type: "ivf",
            neighbor_partitions: 1,
            distance_metric: "DOT",
          },
        },
      }
    );
  });

  test("still ranks with COSINE by default", async () => {
    await withStore(
      async (store) => {
        await store.put(["vectors"], "fruit", { text: "apple fruit" });
        await store.put(["vectors"], "vehicle", { text: "car vehicle" });

        const results = await store.search(["vectors"], {
          query: "apple",
          limit: 2,
        });

        expect(results.map((item) => item.key)).toEqual(["fruit", "vehicle"]);
        expect(results[0].score).toBeCloseTo(1, 5);
        expect(results[1].score).toBeCloseTo(0, 5);
      },
      { index: ivfIndexConfig }
    );
  });

  test("registers the configuration Python reads back", async () => {
    await withStore(
      async (store, prefix) => {
        await store.put(["vectors"], "doc", { text: "apple fruit" });

        await expect(readStoreConfig(prefix)).resolves.toEqual({
          detectedDims: 3,
          distanceType: "EUCLIDEAN",
          indexParams: {
            type: "ivf",
            neighbor_partitions: 1,
            distance_metric: "EUCLIDEAN",
            accuracy: 90,
          },
          embedFields: "text",
        });
      },
      {
        index: {
          ...indexConfig,
          accuracy: 90,
          index_type: {
            type: "ivf",
            neighbor_partitions: 1,
            distance_metric: "EUCLIDEAN",
          },
        },
      }
    );
  });

  test("rejects a store whose configuration conflicts with the registered one", async () => {
    const prefix = uniquePrefix();
    const base = {
      connection: oracleConnection,
      tableSuffix: prefix,
    };
    const store = new OracleStore({ ...base, index: ivfIndexConfig });
    const wrongDims = new OracleStore({
      ...base,
      index: { ...ivfIndexConfig, dims: 4 },
    });
    const wrongDistance = new OracleStore({
      ...base,
      index: {
        ...ivfIndexConfig,
        index_type: {
          type: "ivf",
          neighbor_partitions: 1,
          distance_metric: "DOT",
        },
      },
    });
    const wrongParams = new OracleStore({
      ...base,
      index: {
        ...ivfIndexConfig,
        index_type: { type: "ivf", neighbor_partitions: 8 },
      },
    });
    const wrongAccuracy = new OracleStore({
      ...base,
      index: { ...ivfIndexConfig, accuracy: 80 },
    });

    try {
      await store.start();

      await expect(wrongDims.start()).rejects.toThrow(
        `Dimension mismatch for tableSuffix "${prefix}"`
      );
      await expect(wrongDistance.start()).rejects.toThrow(
        `Distance type mismatch for tableSuffix "${prefix}"`
      );
      await expect(wrongParams.start()).rejects.toThrow(
        `Index parameter mismatch for tableSuffix "${prefix}"`
      );
      await expect(wrongAccuracy.start()).rejects.toThrow(
        `Index accuracy mismatch for tableSuffix "${prefix}"`
      );
    } finally {
      for (const instance of [
        store,
        wrongDims,
        wrongDistance,
        wrongParams,
        wrongAccuracy,
      ]) {
        await instance.stop();
      }
      await dropStoreTables(prefix);
    }
  });

  test("accepts a store that repeats the registered configuration", async () => {
    const prefix = uniquePrefix();
    const options = {
      connection: oracleConnection,
      tableSuffix: prefix,
      index: ivfIndexConfig,
    };
    const first = new OracleStore(options);
    const second = new OracleStore(options);

    try {
      await first.start();
      await first.put(["vectors"], "doc", { text: "apple fruit" });
      await expect(second.start()).resolves.toBeUndefined();

      const results = await second.search(["vectors"], { query: "apple" });
      expect(results.map((item) => item.key)).toEqual(["doc"]);
    } finally {
      await first.stop();
      await second.stop();
      await dropStoreTables(prefix);
    }
  });

  test("gives each index configuration its own derived tables", async () => {
    const cosine = new OracleStore({
      connection: oracleConnection,
      index: ivfIndexConfig,
    });
    const dot = new OracleStore({
      connection: oracleConnection,
      index: {
        ...ivfIndexConfig,
        index_type: {
          type: "ivf",
          neighbor_partitions: 1,
          distance_metric: "DOT",
        },
      },
    });
    const cosineSuffix = derivedTableSuffix(cosine);
    const dotSuffix = derivedTableSuffix(dot);

    expect(cosineSuffix).not.toBe(dotSuffix);

    try {
      await cosine.put(["vectors"], "doc", { text: "apple fruit" });
      // The second configuration must not collide with the first, which is
      // what a suffix that ignored index_type would do.
      await dot.put(["vectors"], "doc", { text: "car vehicle" });

      const cosineResults = await cosine.search(["vectors"], {
        query: "apple",
      });
      expect(cosineResults[0].score).toBeCloseTo(1, 5);

      await expect(readStoreConfig(cosineSuffix)).resolves.toMatchObject({
        distanceType: "COSINE",
      });
      await expect(readStoreConfig(dotSuffix)).resolves.toMatchObject({
        distanceType: "DOT",
      });
    } finally {
      await cosine.stop();
      await dot.stop();
      await dropStoreTables(cosineSuffix);
      await dropStoreTables(dotSuffix);
    }
  });

  test("rejects index configurations before touching the database", async () => {
    const invalidConfigs: Array<[Record<string, unknown>, string]> = [
      [
        { index_type: { type: "hnsw", neighbors: 1 } },
        "index_type.neighbors must be between 2 and 2048",
      ],
      [
        { index_type: { type: "hnsw", distance_metric: "MANHATTAN" } },
        "distance_metric must be one of COSINE, EUCLIDEAN, DOT",
      ],
      [
        { index_type: { type: "ivf", efconstruction: 2 } },
        "index_type contains unsupported keys: efconstruction",
      ],
      [
        { index_type: { type: "hnsw", neighbors: "8) --" } },
        "index_type.neighbors must be an integer",
      ],
      [{ accuracy: 0 }, "index accuracy must be between 1 and 100"],
    ];

    for (const [overrides, message] of invalidConfigs) {
      expect(
        () =>
          new OracleStore({
            connection: oracleConnection,
            index: { ...indexConfig, ...overrides },
          })
      ).toThrow(message);
    }
  });
});

describeIfOracle("OracleStore lifecycle", () => {
  const connString = `${ORACLE_USER}/${ORACLE_PASSWORD}@${ORACLE_CONNECT_STRING}`;

  test("round-trips through a Python style connection string", async () => {
    const prefix = uniquePrefix();
    const store = OracleStore.fromConnString(connString, {
      tableSuffix: prefix,
      poolConfig: { minSize: 1, maxSize: 2 },
    });

    try {
      await store.setup();
      await store.put(["conn"], "item", { text: "hello" });
      await expect(store.get(["conn"], "item")).resolves.toMatchObject({
        value: { text: "hello" },
      });
    } finally {
      await store.stop();
      await dropStoreTables(prefix);
    }
  });

  test("setup is public, idempotent, and not required before use", async () => {
    const prefix = uniquePrefix();
    const store = new OracleStore({
      connection: oracleConnection,
      tableSuffix: prefix,
    });

    try {
      await store.setup();
      await store.setup();
      await store.put(["setup"], "item", { text: "hello" });
      await expect(store.get(["setup"], "item")).resolves.toMatchObject({
        value: { text: "hello" },
      });
    } finally {
      await store.stop();
      await dropStoreTables(prefix);
    }
  });
});

describeIfOracle("OracleStore table naming", () => {
  async function tableExists(tableName: string): Promise<boolean> {
    const connection = await oracledb.getConnection(oracleConnection);
    try {
      const result = await connection.execute<{ N: number }>(
        `SELECT COUNT(*) AS n FROM user_tables WHERE table_name = :tableName`,
        { tableName },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return Number(result.rows?.[0]?.N ?? 0) > 0;
    } finally {
      await connection.close();
    }
  }

  test("creates unquoted upper-case tables regardless of suffix casing", async () => {
    const suffix = uniquePrefix().replace(/_+$/, "");
    const lower = new OracleStore({
      connection: oracleConnection,
      tableSuffix: suffix.toLowerCase(),
    });
    const upper = new OracleStore({
      connection: oracleConnection,
      tableSuffix: suffix.toUpperCase(),
    });

    try {
      await lower.setup();
      await expect(tableExists(`STORE_${suffix.toUpperCase()}`)).resolves.toBe(
        true
      );
      await expect(tableExists(`STORE_${suffix.toLowerCase()}`)).resolves.toBe(
        false
      );

      // Both casings address the same table.
      await lower.put(["casing"], "item", { text: "hello" });
      await expect(upper.get(["casing"], "item")).resolves.toMatchObject({
        value: { text: "hello" },
      });
    } finally {
      await lower.stop();
      await upper.stop();
      await dropStoreTables(suffix);
    }
  });

  test("rejects suffixes that would require quoting before connecting", () => {
    for (const tableSuffix of [
      'my"table',
      '"quoted"',
      "my table",
      "my-table",
      "tenant;DROP TABLE STORE_X",
      "1memory",
    ]) {
      expect(
        () =>
          new OracleStore({ connection: oracleConnection, tableSuffix })
      ).toThrow(/must start with a letter/);
    }
  });
});

describeIfOracle("OracleStore suffix isolation", () => {
  test("keeps migrations and data independent across suffixes", async () => {
    const first = uniquePrefix().replace(/_+$/, "");
    const second = uniquePrefix().replace(/_+$/, "");
    const storeA = new OracleStore({
      connection: oracleConnection,
      tableSuffix: first,
    });
    const storeB = new OracleStore({
      connection: oracleConnection,
      tableSuffix: second,
    });

    try {
      await storeA.setup();
      await storeB.setup();

      // Each suffix owns its own migration table and applied versions.
      await expect(readStoreMigrationVersions(first)).resolves.toEqual([
        0, 1, 2, 3, 4,
      ]);
      await expect(readStoreMigrationVersions(second)).resolves.toEqual([
        0, 1, 2, 3, 4,
      ]);

      // Data written under one suffix is invisible to the other.
      await storeA.put(["shared"], "item", { owner: "a" });
      await expect(storeA.get(["shared"], "item")).resolves.toMatchObject({
        value: { owner: "a" },
      });
      await expect(storeB.get(["shared"], "item")).resolves.toBeNull();
      await expect(
        storeB.search(["shared"], { limit: 10 })
      ).resolves.toEqual([]);
    } finally {
      await storeA.stop();
      await storeB.stop();
      await dropStoreTables(first);
      await dropStoreTables(second);
    }
  });

  test("surfaces connection failures from setup", async () => {
    const store = new OracleStore({
      connection: { ...oracleConnection, password: "definitely-not-valid" },
      tableSuffix: uniquePrefix().replace(/_+$/, ""),
    });

    try {
      await expect(store.setup()).rejects.toThrow();
    } finally {
      await store.stop().catch(() => {});
    }
  });
});
