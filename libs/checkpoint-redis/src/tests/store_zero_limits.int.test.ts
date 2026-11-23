import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisStore } from "../store.js";
import { createRedisContainer } from "./redis-container.js";

describe("RedisStore zero limits", () => {
  let container: Awaited<ReturnType<typeof createRedisContainer>>;
  let store: RedisStore;

  beforeAll(async () => {
    container = await createRedisContainer();
    store = new RedisStore(container.client, {
      index: {
        dims: 2,
        embed: { embedDocuments: async (texts: string[]) => texts.map(() => [1, 1]) },
      },
    });
    await store.setup();
    await store.put(["docs", "a"], "first", { text: "hello" });
    await store.put(["docs", "b"], "second", { text: "world" });
  }, 120_000);

  afterAll(async () => container?.cleanup());

  it.each([undefined, "query"])("returns no search results with query %s", async (query) => {
    expect(await store.search(["docs"], { query, limit: 0 })).toEqual([]);
    expect(await store.search(["docs"], { query, limit: 1 })).toHaveLength(1);
  });

  it.each([0, 1])("returns no namespaces with offset %s", async (offset) => {
    expect(await store.listNamespaces({ limit: 0, offset })).toEqual([]);
    expect(await store.listNamespaces({ limit: 1, offset })).toHaveLength(1);
  });

  it("honors zero limits through batch operations", async () => {
    expect(await store.batch([
      { namespacePrefix: ["docs"], limit: 0 },
      { matchConditions: [], limit: 0 },
    ])).toEqual([[], []]);
  });
});
