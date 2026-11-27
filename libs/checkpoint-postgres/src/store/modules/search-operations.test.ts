import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { DatabaseCore } from "./database-core.js";
import { SearchOperations } from "./search-operations.js";
import type { VectorOperations } from "./vector-operations.js";

const createdAt = new Date("2024-01-01T00:00:00.000Z");

function makeSearch(score: unknown) {
  const query = vi.fn().mockResolvedValue({
    rows: [
      {
        namespace_path: "docs",
        key: "match",
        value: { text: "hello world" },
        created_at: createdAt,
        updated_at: createdAt,
        score,
      },
    ],
  });
  const core = {
    schema: "public",
    textSearchLanguage: "english",
    withClient: (operation: (client: pg.PoolClient) => Promise<unknown>) =>
      operation({ query } as unknown as pg.PoolClient),
  } as unknown as DatabaseCore;
  return {
    search: new SearchOperations(core, {} as VectorOperations),
    query,
  };
}

describe("SearchOperations.textSearch score mapping", () => {
  it("keeps a zero score from an ILIKE-only match", async () => {
    const { search, query } = makeSearch(0);

    const [item] = await search.textSearch(["docs"], { query: "hello" });

    expect(query.mock.calls[0][0]).toContain("ILIKE");
    expect(item?.score).toBe(0);
  });

  it("converts a nonzero score returned by pg to a number", async () => {
    const { search } = makeSearch("0.75");

    const [item] = await search.textSearch(["docs"], { query: "hello" });

    expect(item?.score).toBe(0.75);
  });

  it("leaves a null score undefined", async () => {
    const { search } = makeSearch(null);

    const [item] = await search.textSearch(["docs"], { query: "hello" });

    expect(item?.score).toBeUndefined();
  });
});
