/* eslint-disable no-process-env */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { Item } from "@langchain/langgraph-checkpoint";
import { PostgresStore } from "../store/index.js";

const { TEST_POSTGRES_URL } = process.env;
if (!TEST_POSTGRES_URL) {
  throw new Error("TEST_POSTGRES_URL environment variable is required");
}

const pool = new pg.Pool({ connectionString: TEST_POSTGRES_URL });

describe("PostgresStore search pagination", () => {
  let store: PostgresStore;
  let schema: string;

  beforeEach(async () => {
    schema = `pagination_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    store = PostgresStore.fromConnString(TEST_POSTGRES_URL, {
      schema,
      index: {
        dims: 3,
        fields: ["content"],
        embed: async (texts) => texts.map(() => [1, 0, 0]),
      },
    });
    await store.setup();
  });

  afterEach(async () => {
    await store.stop();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it.each([
    "batch",
    "batch-vector",
    "metadata",
    "text",
    "vector",
    "hybrid",
  ] as const)("does not repeat or skip tied rows in %s searches", async (mode) => {
    // Duplicate keys in different namespaces require both primary-key columns.
    const operations = ["b", "a"].flatMap((suffix) =>
      Array.from({ length: 300 }, (_, i) => ({
        namespace: ["docs", suffix],
        key: `file-${String(299 - i).padStart(3, "0")}`,
        value: { content: "needle" },
      }))
    );
    await store.batch(operations);
    await pool.query(
      `UPDATE "${schema}".store SET value = value WHERE hashtext(key) % 3 = 0`
    );

    const seen: Item[] = [];
    for (let offset = 0; ; offset += 100) {
      const pagination = { limit: 100, offset };
      const page =
        mode === "batch" || mode === "batch-vector"
          ? (
              await store.batch([
                {
                  namespacePrefix: ["docs"],
                  ...pagination,
                  ...(mode === "batch-vector" ? { query: "needle" } : {}),
                },
              ])
            )[0]
          : await store.search(["docs"], {
              ...pagination,
              ...(mode === "metadata" ? {} : { query: "needle", mode }),
            });
      if (!Array.isArray(page)) throw new Error("Expected search results");
      seen.push(...page);
      if (page.length < 100) break;
    }

    const identity = (item: { namespace: string[]; key: string }) =>
      `${item.namespace.join(":")}/${item.key}`;
    expect(seen).toHaveLength(600);
    expect(new Set(seen.map(identity))).toEqual(
      new Set(operations.map(identity))
    );

    const sorted = [...seen].sort((a, b) => {
      const timeOrder =
        mode === "batch"
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : mode === "metadata" || mode === "text"
          ? b.updatedAt.getTime() - a.updatedAt.getTime()
          : 0;
      return timeOrder || identity(a).localeCompare(identity(b));
    });
    expect(seen.map(identity)).toEqual(sorted.map(identity));
  });
});
