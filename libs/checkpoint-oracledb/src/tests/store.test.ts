// Copyright (c) 2026, Oracle and/or its affiliates.
import { describe, expect, test } from "vitest";

import { OracleStore } from "../store/index.js";
import { ORACLE_VECTOR_MAX_DIMENSIONS } from "../store/constants.js";

const unusedPool = {
  async getConnection() {
    throw new Error("Oracle should not be called for validation failures.");
  },
};

class FakeSetupConnection {
  committed = false;

  rolledBack = false;

  constructor(
    private readonly options: {
      currentVersion: number;
      existingTables: Set<string>;
    }
  ) {}

  async execute<RowT = Record<string, unknown>>(
    sql: string,
    binds: Record<string, unknown> = {}
  ): Promise<{ rows?: RowT[] }> {
    if (/^\s*CREATE TABLE\b/i.test(sql)) {
      return {};
    }
    if (/SELECT v FROM/i.test(sql)) {
      return { rows: [{ V: this.options.currentVersion } as RowT] };
    }
    if (/FROM user_tables/i.test(sql)) {
      const tableName = String(binds.tableName ?? "").toUpperCase();
      return {
        rows: [
          {
            TABLE_EXISTS: this.options.existingTables.has(tableName) ? 1 : 0,
          } as RowT,
        ],
      };
    }
    throw new Error(`Unexpected setup SQL: ${sql}`);
  }

  async commit(): Promise<void> {
    this.committed = true;
  }

  async rollback(): Promise<void> {
    this.rolledBack = true;
  }

  async close(): Promise<void> {}
}

function fakePool(connection: FakeSetupConnection) {
  return {
    async getConnection() {
      return connection;
    },
    async close() {},
  };
}

interface StoreStateProbe {
  setup(): Promise<void>;
  isSetup: boolean;
  setupPromise?: Promise<void>;
  vectorBindStrategy?: "native" | "string";
  nativeVectorDmlProbed: boolean;
  pool?: unknown;
  ownsPool: boolean;
}

describe("OracleStore runtime validation", () => {
  test("rejects incomplete vector index configs at construction", () => {
    expect(
      () =>
        new OracleStore({
          index: { dims: 2 } as never,
        })
    ).toThrow(
      "OracleStore index embeddings must provide embedDocuments and embedQuery methods."
    );

    expect(
      () =>
        new OracleStore({
          index: {
            dims: 2,
            embeddings: { async embedDocuments() {} },
          } as never,
        })
    ).toThrow(
      "OracleStore index embeddings must provide embedDocuments and embedQuery methods."
    );

    expect(
      () =>
        new OracleStore({
          index: {
            dims: 2,
            embeddings: {
              async embedDocuments() {
                return [];
              },
              async embedQuery() {
                return [];
              },
            },
            fields: ["text", 1],
          } as never,
        })
    ).toThrow("OracleStore index fields must be an array of strings.");
  });

  test("rejects invalid and oversized vector dimensions at construction", () => {
    const embeddings = {
      async embedDocuments() {
        return [];
      },
      async embedQuery() {
        return [];
      },
    };

    for (const dims of [
      0,
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      ORACLE_VECTOR_MAX_DIMENSIONS + 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(
        () =>
          new OracleStore({
            index: {
              dims,
              embeddings: embeddings as never,
            },
          })
      ).toThrow(
        `OracleStore index dims must be an integer between 1 and ${ORACLE_VECTOR_MAX_DIMENSIONS}`
      );
    }
  });

  test("rejects non-JSON-serializable store values before Oracle writes", async () => {
    const store = new OracleStore({
      pool: unusedPool as never,
      ensureTable: false,
      tablePrefix: "VALIDATION_",
    });

    await expect(
      store.put(["bad-values"], "undefined-root", undefined as never)
    ).rejects.toThrow("OracleStore values must be JSON-serializable");

    await expect(
      store.put(["bad-values"], "function-property", {
        kept: true,
        dropped: () => "gone",
      } as never)
    ).rejects.toThrow("contains unsupported function value");

    await expect(
      store.put(["bad-values"], "nan", { score: Number.NaN })
    ).rejects.toThrow("contains a non-finite number");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      store.put(["bad-values"], "circular", circular)
    ).rejects.toThrow("contains circular references");
  });

  test("fails setup when store table is missing but migration is recorded", async () => {
    const prefix = "MISSING_STORE_";
    const connection = new FakeSetupConnection({
      currentVersion: 0,
      existingTables: new Set(),
    });
    const store = new OracleStore({
      pool: fakePool(connection) as never,
      tablePrefix: prefix,
    });

    await expect(
      store.search(["schema-missing"], { limit: 1 })
    ).rejects.toThrow(`${prefix}STORE is missing`);
    expect(connection.rolledBack).toBe(true);
    expect(connection.committed).toBe(false);
  });

  test("fails setup when vector table is missing but vector migration is recorded", async () => {
    const prefix = "MISSING_VECTOR_";
    const connection = new FakeSetupConnection({
      currentVersion: 1,
      existingTables: new Set([`${prefix}STORE`]),
    });
    const store = new OracleStore({
      pool: fakePool(connection) as never,
      tablePrefix: prefix,
      index: {
        dims: 2,
        embeddings: {
          async embedDocuments() {
            return [];
          },
          async embedQuery() {
            return [0, 0];
          },
        } as never,
      },
    });

    await expect(
      store.search(["schema-missing"], { query: "x" })
    ).rejects.toThrow(`${prefix}STORE_VECTORS is missing`);
    expect(connection.rolledBack).toBe(true);
    expect(connection.committed).toBe(false);
  });

  test("stop resets setup and vector probe state for caller supplied pools", async () => {
    const prefix = "EXTERNAL_POOL_";
    const connection = new FakeSetupConnection({
      currentVersion: 0,
      existingTables: new Set([`${prefix}STORE`]),
    });
    let closeCalls = 0;
    const pool = {
      async getConnection() {
        return connection;
      },
      async close() {
        closeCalls += 1;
      },
    };
    const store = new OracleStore({
      pool: pool as never,
      tablePrefix: prefix,
    });
    const probe = store as unknown as StoreStateProbe;

    await probe.setup();
    expect(probe.isSetup).toBe(true);
    expect(probe.setupPromise).toBeDefined();

    probe.vectorBindStrategy = "string";
    probe.nativeVectorDmlProbed = true;

    await store.stop();

    expect(closeCalls).toBe(0);
    expect(probe.pool).toBe(pool);
    expect(probe.isSetup).toBe(false);
    expect(probe.setupPromise).toBeUndefined();
    expect(probe.vectorBindStrategy).toBeUndefined();
    expect(probe.nativeVectorDmlProbed).toBe(false);
  });

  test("stop resets setup and vector probe state when owned pool close fails", async () => {
    let closeCalls = 0;
    const pool = {
      async getConnection() {
        throw new Error("should not request a connection");
      },
      async close() {
        closeCalls += 1;
        throw new Error("close failed");
      },
    };
    const store = new OracleStore({
      pool: pool as never,
      tablePrefix: "OWNED_CLOSE_FAIL_",
    });
    const probe = store as unknown as StoreStateProbe;
    probe.ownsPool = true;
    probe.isSetup = true;
    probe.setupPromise = Promise.resolve();
    probe.vectorBindStrategy = "native";
    probe.nativeVectorDmlProbed = true;

    await expect(store.stop()).rejects.toThrow("close failed");

    expect(closeCalls).toBe(1);
    expect(probe.pool).toBe(pool);
    expect(probe.isSetup).toBe(false);
    expect(probe.setupPromise).toBeUndefined();
    expect(probe.vectorBindStrategy).toBeUndefined();
    expect(probe.nativeVectorDmlProbed).toBe(false);
  });
});
