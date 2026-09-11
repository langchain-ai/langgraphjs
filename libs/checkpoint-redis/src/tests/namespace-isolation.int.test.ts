import { afterAll, beforeAll, expect, it } from "vitest";
import { createRedisContainer } from "./redis-container.js";
import { RedisStore } from "../store.js";

let container: Awaited<ReturnType<typeof createRedisContainer>>;
let store: RedisStore;

const namespaces = [
  ["tenant", "a"],
  ["tenant", "a", "notes"],
  ["tenant", "ab"],
  ["a", "tenant"],
  ["tenant", "A"],
  ["tenant", "a-b"],
  ["tenant", "a,b"],
  ["tenant", "a) | @prefix:(victim"],
  ["tenant", "*"],
];
beforeAll(async () => {
  container = await createRedisContainer();
  store = new RedisStore(container.client, {
    index: {
      dims: 2,
      embed: {
        embedDocuments: async (texts: string[]) => texts.map(() => [1, 0]),
        embedQuery: async () => [1, 0],
      },
    },
  });
  await store.setup();
  for (let i = 0; i < namespaces.length; i++)
    await store.put(namespaces[i], `key${i}`, { text: "hello" });
});
afterAll(async () => {
  await container?.cleanup();
});
it.each([false, true])("isolates segments with vector=%s", async (vector) => {
  for (const namespace of namespaces) {
    const items = await store.search(namespace, {
      limit: 100,
      ...(vector ? { query: "hello" } : {}),
    });
    expect(items.length).toBeGreaterThan(0);
    expect(
      items.every((item) =>
        namespace.every((part, i) => item.namespace[i] === part)
      )
    ).toBe(true);
  }
  expect(
    (
      await store.search(["tenant", "a"], {
        limit: 100,
        ...(vector ? { query: "hello" } : {}),
      })
    ).length
  ).toBe(2);
});
it("isolates exact reads, updates and deletes with identical keys", async () => {
  for (const namespace of [
    ["scope", "one"],
    ["one", "scope"],
    ["scope", "one", "child"],
  ])
    await store.put(namespace, "same", { namespace });
  expect((await store.get(["scope", "one"], "same"))?.namespace).toEqual([
    "scope",
    "one",
  ]);
  await store.put(["scope", "one"], "same", { updated: true });
  expect((await store.get(["one", "scope"], "same"))?.value).toEqual({
    namespace: ["one", "scope"],
  });
  await store.delete(["scope", "one"], "same");
  expect(await store.get(["scope", "one"], "same")).toBeNull();
  expect(await store.get(["one", "scope"], "same")).not.toBeNull();
  expect(await store.get(["scope", "one", "child"], "same")).not.toBeNull();
});
