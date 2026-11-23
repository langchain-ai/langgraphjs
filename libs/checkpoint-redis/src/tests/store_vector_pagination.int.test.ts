import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisStore } from "../store.js";
import { createRedisContainer } from "./redis-container.js";

describe("RedisStore vector pagination", () => {
  let container: Awaited<ReturnType<typeof createRedisContainer>>;
  let store: RedisStore;

  beforeAll(async () => {
    container = await createRedisContainer();
    store = new RedisStore(container.client, {
      index: {
        dims: 2,
        distanceType: "l2",
        embed: {
          embedDocuments: async (texts: string[]) => texts.map((text) => [1, Number(text)]),
        },
      },
    });
    await store.setup();
    // Insert out of relevance order, so pages must follow vector distance.
    for (const distance of [4, 2, 5, 1, 3]) {
      await store.put(["docs", "inner"], `doc${distance}`, { text: String(distance) });
    }
    for (const distance of [0.1, 0.2]) {
      await store.put(["docs", "outer"], `other${distance}`, { text: String(distance) });
    }
  }, 120_000);

  afterAll(async () => container?.cleanup());

  it.each([
    { offset: 0, expected: ["doc1", "doc2"] },
    { offset: 2, expected: ["doc3", "doc4"] },
    { offset: 4, expected: ["doc5"] },
    { offset: 5, expected: [] },
  ])("returns ranked results at offset $offset", async ({ offset, expected }) => {
    const items = await store.search(["docs", "inner"], { query: "0", limit: 2, offset });
    expect(items.map((item) => item.key)).toEqual(expected);
  });

  it("uses the same pages through batch search", async () => {
    const [items] = await store.batch([
      { namespacePrefix: ["docs", "inner"], query: "0", limit: 2, offset: 2 },
    ]);
    expect(items.map((item: { key: string }) => item.key)).toEqual(["doc3", "doc4"]);
  });
});
