/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { BaseStore, Operation, OperationResults, Item } from "../store/base.js";
import { AsyncBatchedStore } from "../store/batch.js";
import { MemoryStore } from "../store/memory.js";

describe("AsyncBatchedStore", () => {
  let store: AsyncBatchedStore;
  const batchMock = jest.fn();

  class MockStore extends BaseStore {
    async batch<Op extends Operation[]>(
      operations: Op
    ): Promise<OperationResults<Op>> {
      batchMock(operations);
      const results: any[] = [];

      for (const op of operations) {
        if ("namespacePrefix" in op) {
          // SearchOperation
          const items: Item[] = op.namespacePrefix.flatMap((prefix) => [
            {
              value: { value: 1 },
              id: prefix,
              namespace: [prefix],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]);
          results.push(items);
        } else if ("id" in op && !("value" in op)) {
          // GetOperation
          results.push({
            value: { value: 1 },
            id: op.id,
            namespace: op.namespace,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        } else {
          // PutOperation
          results.push(undefined);
        }
      }

      return results as OperationResults<Op>;
    }
  }

  beforeEach(() => {
    store = new AsyncBatchedStore(new MockStore());
    // Start the store
    store.start();
  });

  afterEach(async () => {
    if (store) {
      await store.stop();
    }
    batchMock.mockClear();
  });

  it("should batch concurrent calls", async () => {
    // Concurrent calls are batched
    const results = await Promise.all([
      store.search(["a", "b"]),
      store.search(["c", "d"]),
    ]);

    expect(results).toEqual([
      [
        {
          value: { value: 1 },
          id: "a",
          namespace: ["a"],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
        {
          value: { value: 1 },
          id: "b",
          namespace: ["b"],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      ],
      [
        {
          value: { value: 1 },
          id: "c",
          namespace: ["c"],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
        {
          value: { value: 1 },
          id: "d",
          namespace: ["d"],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      ],
    ]);

    expect(batchMock.mock.calls).toEqual([
      [
        [
          { namespacePrefix: ["a", "b"], limit: 10, offset: 0 },
          { namespacePrefix: ["c", "d"], limit: 10, offset: 0 },
        ],
      ],
    ]);
  });
});

describe("BaseStore", () => {
  class TestStore extends BaseStore {
    async batch<Op extends Operation[]>(
      operations: Op
    ): Promise<OperationResults<Op>> {
      const results: any[] = [];

      for (const op of operations) {
        if ("namespacePrefix" in op) {
          // SearchOperation
          results.push([
            {
              value: { value: 1 },
              id: op.namespacePrefix[0],
              namespace: op.namespacePrefix,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]);
        } else if ("id" in op && !("value" in op)) {
          // GetOperation
          results.push({
            value: { value: 1 },
            id: op.id,
            namespace: op.namespace,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        } else if ("value" in op) {
          // PutOperation
          results.push(undefined);
        }
      }

      return results as OperationResults<Op>;
    }
  }

  let store: TestStore;

  beforeEach(() => {
    store = new TestStore();
  });

  it("should implement get method", async () => {
    const result = await store.get(["test"], "123");
    expect(result).toEqual({
      value: { value: 1 },
      id: "123",
      namespace: ["test"],
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it("should implement search method", async () => {
    const result = await store.search(["test"]);
    expect(result).toEqual([
      {
        value: { value: 1 },
        id: "test",
        namespace: ["test"],
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    ]);
  });

  it("should implement put method", async () => {
    await expect(
      store.put(["test"], "123", { value: 2 })
    ).resolves.toBeUndefined();
  });

  it("should implement delete method", async () => {
    await expect(store.delete(["test"], "123")).resolves.toBeUndefined();
  });

  it("should pass correct options to search method", async () => {
    const batchSpy = jest.spyOn(store, "batch");
    await store.search(["test"], {
      limit: 20,
      offset: 5,
      filter: { key: "value" },
    });
    expect(batchSpy).toHaveBeenCalledWith([
      {
        namespacePrefix: ["test"],
        limit: 20,
        offset: 5,
        filter: { key: "value" },
      },
    ]);
  });

  it("should use default options in search method", async () => {
    const batchSpy = jest.spyOn(store, "batch");
    await store.search(["test"]);
    expect(batchSpy).toHaveBeenCalledWith([
      { namespacePrefix: ["test"], limit: 10, offset: 0 },
    ]);
  });

  describe("listNamespaces", () => {
    class TestStoreWithListNamespaces extends TestStore {
      async batch<Op extends Operation[]>(
        operations: Op
      ): Promise<OperationResults<Op>> {
        const results: any[] = await super.batch(operations);

        for (const op of operations) {
          if ("matchConditions" in op) {
            // ListNamespacesOperation
            const namespaces = [
              ["a", "b", "c"],
              ["a", "b", "d"],
              ["a", "c", "e"],
              ["x", "y", "z"],
            ];

            let filteredNamespaces = namespaces;

            if (op.matchConditions) {
              for (const condition of op.matchConditions) {
                if (condition.matchType === "prefix") {
                  filteredNamespaces = filteredNamespaces.filter((ns) =>
                    ns
                      .slice(0, condition.path.length)
                      .every((part, i) =>
                        condition.path[i] === "*"
                          ? true
                          : part === condition.path[i]
                      )
                  );
                } else if (condition.matchType === "suffix") {
                  filteredNamespaces = filteredNamespaces.filter((ns) =>
                    ns
                      .slice(-condition.path.length)
                      .every((part, i) =>
                        condition.path[i] === "*"
                          ? true
                          : part === condition.path[i]
                      )
                  );
                }
              }
            }

            if (op.maxDepth !== undefined) {
              filteredNamespaces = filteredNamespaces.map((ns) =>
                ns.slice(0, op.maxDepth)
              );
            }

            results.push(
              filteredNamespaces.slice(op.offset, op.offset + op.limit)
            );
          }
        }

        return results as OperationResults<Op>;
      }
    }

    let store: TestStoreWithListNamespaces;

    beforeEach(() => {
      store = new TestStoreWithListNamespaces();
    });

    it("should list all namespaces with default options", async () => {
      const result = await store.listNamespaces({});
      expect(result).toEqual([
        ["a", "b", "c"],
        ["a", "b", "d"],
        ["a", "c", "e"],
        ["x", "y", "z"],
      ]);
    });

    it("should filter namespaces by prefix", async () => {
      const result = await store.listNamespaces({ prefix: ["a"] });
      expect(result).toEqual([
        ["a", "b", "c"],
        ["a", "b", "d"],
        ["a", "c", "e"],
      ]);
    });

    it("should filter namespaces by suffix", async () => {
      const result = await store.listNamespaces({ suffix: ["d"] });
      expect(result).toEqual([["a", "b", "d"]]);
    });

    it("should apply maxDepth to results", async () => {
      const result = await store.listNamespaces({ maxDepth: 2 });
      expect(result).toEqual([
        ["a", "b"],
        ["a", "b"],
        ["a", "c"],
        ["x", "y"],
      ]);
    });

    it("should apply limit and offset", async () => {
      const result = await store.listNamespaces({ limit: 2, offset: 1 });
      expect(result).toEqual([
        ["a", "b", "d"],
        ["a", "c", "e"],
      ]);
    });

    it("should combine prefix, suffix, and maxDepth filters", async () => {
      const result = await store.listNamespaces({
        prefix: ["a"],
        suffix: ["c"],
        maxDepth: 2,
      });
      expect(result).toEqual([["a", "b"]]);
    });

    it("should handle wildcard in prefix", async () => {
      const result = await store.listNamespaces({ prefix: ["a", "*", "c"] });
      expect(result).toEqual([["a", "b", "c"]]);
    });

    it("should handle wildcard in suffix", async () => {
      const result = await store.listNamespaces({ suffix: ["*", "z"] });
      expect(result).toEqual([["x", "y", "z"]]);
    });

    it("should return an empty array when no namespaces match", async () => {
      const result = await store.listNamespaces({
        prefix: ["non", "existent"],
      });
      expect(result).toEqual([]);
    });

    it("should pass correct options to batch method", async () => {
      const batchSpy = jest.spyOn(store, "batch");
      await store.listNamespaces({
        prefix: ["a"],
        suffix: ["c"],
        maxDepth: 2,
        limit: 5,
        offset: 1,
      });
      expect(batchSpy).toHaveBeenCalledWith([
        {
          matchConditions: [
            { matchType: "prefix", path: ["a"] },
            { matchType: "suffix", path: ["c"] },
          ],
          maxDepth: 2,
          limit: 5,
          offset: 1,
        },
      ]);
    });
  });
});

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it("should implement get method", async () => {
    await store.put(["test"], "123", { value: 1 });
    const result = await store.get(["test"], "123");
    expect(result).toEqual({
      value: { value: 1 },
      id: "123",
      namespace: ["test"],
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it("should implement search method", async () => {
    await store.put(["test"], "123", { value: 1 });
    await store.put(["test"], "456", { value: 2 });
    const result = await store.search(["test"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      value: { value: 1 },
      id: "123",
      namespace: ["test"],
    });
    expect(result[1]).toMatchObject({
      value: { value: 2 },
      id: "456",
      namespace: ["test"],
    });
  });

  it("should implement put method", async () => {
    await store.put(["test"], "123", { value: 1 });
    const result = await store.get(["test"], "123");
    expect(result).toMatchObject({
      value: { value: 1 },
      id: "123",
      namespace: ["test"],
    });
  });

  it("should implement delete method", async () => {
    await store.put(["test"], "123", { value: 1 });
    await store.delete(["test"], "123");
    const result = await store.get(["test"], "123");
    expect(result).toBeNull();
  });

  it("should implement listNamespaces method", async () => {
    await store.put(["a", "b", "c"], "1", { value: 1 });
    await store.put(["a", "b", "d"], "2", { value: 2 });
    await store.put(["x", "y", "z"], "3", { value: 3 });

    const result = await store.listNamespaces({});
    expect(result).toEqual([
      ["a", "b", "c"],
      ["a", "b", "d"],
      ["x", "y", "z"],
    ]);
  });

  it("should filter namespaces by prefix", async () => {
    await store.put(["a", "b", "c"], "1", { value: 1 });
    await store.put(["a", "b", "d"], "2", { value: 2 });
    await store.put(["x", "y", "z"], "3", { value: 3 });

    const result = await store.listNamespaces({ prefix: ["a"] });
    expect(result).toEqual([
      ["a", "b", "c"],
      ["a", "b", "d"],
    ]);
  });

  it("should apply maxDepth to listNamespaces results", async () => {
    await store.put(["a", "b", "c"], "1", { value: 1 });
    await store.put(["a", "b", "d"], "2", { value: 2 });
    await store.put(["x", "y", "z"], "3", { value: 3 });

    const result = await store.listNamespaces({ maxDepth: 2 });
    expect(result).toEqual([
      ["a", "b"],
      ["x", "y"],
    ]);
  });
});
