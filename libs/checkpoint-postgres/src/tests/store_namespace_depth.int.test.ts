/* eslint-disable no-process-env */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../store/index.js";

const { TEST_POSTGRES_URL } = process.env;
if (!TEST_POSTGRES_URL)
  throw new Error("TEST_POSTGRES_URL environment variable is required");

describe("PostgresStore namespace depth", () => {
  const store = PostgresStore.fromConnString(TEST_POSTGRES_URL);
  const root = `namespace-depth-${Date.now()}`;
  const namespaces = [
    [root, "a", "one"],
    [root, "a", "two"],
    [root, "b", "one"],
    [root, "c"],
  ];
  beforeAll(async () => {
    await store.setup();
    for (const namespace of namespaces)
      await store.put(namespace, "item", { value: 1 });
  });
  afterAll(async () => {
    for (const namespace of namespaces) await store.delete(namespace, "item");
    await store.stop();
  });
  it("truncates and deduplicates matching namespaces before pagination", async () => {
    await expect(
      store.listNamespaces({ prefix: [root], maxDepth: 2 })
    ).resolves.toEqual([
      [root, "a"],
      [root, "b"],
      [root, "c"],
    ]);
    await expect(
      store.listNamespaces({ prefix: [root], maxDepth: 2, offset: 1, limit: 1 })
    ).resolves.toEqual([[root, "b"]]);
    await expect(
      store.listNamespaces({ prefix: [root], suffix: ["one"], maxDepth: 1 })
    ).resolves.toEqual([[root]]);
    await expect(
      store.listNamespaces({ prefix: [root], maxDepth: 0 })
    ).resolves.toEqual([[]]);
  });
});
