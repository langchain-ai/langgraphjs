/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BaseStore,
  Operation,
  OperationResults,
  Item,
  InvalidNamespaceError,
} from "../store/base.js";
import { AsyncBatchedStore } from "../store/batch.js";
import { InMemoryStore } from "../store/memory.js";

describe("AsyncBatchedStore", () => {
  let store: AsyncBatchedStore;
  const batchMock = vi.fn();

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
              key: prefix,
              namespace: [prefix],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]);
          results.push(items);
        } else if ("key" in op && !("value" in op)) {
          // GetOperation
          results.push({
            value: { value: 1 },
            key: op.key,
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

  beforeEach(async () => {
    store = new AsyncBatchedStore(new MockStore());
    // Start the store
    await store.start();
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
          key: "a",
          namespace: ["a"],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
        {
          value: { value: 1 },
          key: "b",
          namespace: ["b"],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      ],
      [
        {
          value: { value: 1 },
          key: "c",
          namespace: ["c"],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
        {
          value: { value: 1 },
          key: "d",
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
              key: op.namespacePrefix[0],
              namespace: op.namespacePrefix,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]);
        } else if ("key" in op && !("value" in op)) {
          // GetOperation
          results.push({
            value: { value: 1 },
            key: op.key,
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
      key: "123",
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
        key: "test",
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
    const batchSpy = vi.spyOn(store, "batch");
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
    const batchSpy = vi.spyOn(store, "batch");
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
      const batchSpy = vi.spyOn(store, "batch");
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

describe("InMemoryStore", () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it("should implement get method", async () => {
    await store.put(["test"], "123", { value: 1 });
    const result = await store.get(["test"], "123");
    expect(result).toEqual({
      value: { value: 1 },
      key: "123",
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
      key: "123",
      namespace: ["test"],
    });
    expect(result[1]).toMatchObject({
      value: { value: 2 },
      key: "456",
      namespace: ["test"],
    });
  });

  it("should implement put method", async () => {
    await store.put(["test"], "123", { value: 1 });
    const result = await store.get(["test"], "123");
    expect(result).toMatchObject({
      value: { value: 1 },
      key: "123",
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

  it("Should block invalid namespaces in put", async () => {
    const doc = { foo: "bar" };

    // Test invalid namespaces
    await expect(store.put([], "foo", doc)).rejects.toThrow(
      InvalidNamespaceError
    );
    await expect(store.put(["the", "thing.about"], "foo", doc)).rejects.toThrow(
      InvalidNamespaceError
    );
    await expect(store.put(["some", "fun", ""], "foo", doc)).rejects.toThrow(
      InvalidNamespaceError
    );
    await expect(store.put(["langgraph", "foo"], "bar", doc)).rejects.toThrow(
      InvalidNamespaceError
    );

    await store.put(["foo", "langgraph", "foo"], "bar", doc);
    const result = await store.get(["foo", "langgraph", "foo"], "bar");
    expect(result?.value).toEqual(doc);

    const searchResult = await store.search(["foo", "langgraph", "foo"]);
    expect(searchResult[0].value).toEqual(doc);

    await store.delete(["foo", "langgraph", "foo"], "bar");
    const deletedResult = await store.get(["foo", "langgraph", "foo"], "bar");
    expect(deletedResult).toBeNull();

    await store.batch([
      { namespace: ["langgraph", "foo"], key: "bar", value: doc },
    ]);
    const batchResult = await store.get(["langgraph", "foo"], "bar");
    expect(batchResult?.value).toEqual(doc);

    const batchSearchResult = await store.search(["langgraph", "foo"]);
    expect(batchSearchResult[0].value).toEqual(doc);

    await store.delete(["langgraph", "foo"], "bar");
    const batchDeletedResult = await store.get(["langgraph", "foo"], "bar");
    expect(batchDeletedResult).toBeNull();
  });
});

describe("Namespace validation", () => {
  class RecordingStore extends BaseStore {
    execute = vi.fn(async (_ops: Operation[]) => []);

    async batch<Op extends Operation[]>(
      ops: Op
    ): Promise<OperationResults<Op>> {
      return (await this.execute(ops)) as OperationResults<Op>;
    }
  }

  it("should keep hierarchical and empty-prefix search through the wrapper", async () => {
    const underlying = new InMemoryStore();
    await underlying.put(["tenant", "alice", "files"], "secret", {
      text: "original",
    });
    const store = new AsyncBatchedStore(underlying);
    store.start();
    try {
      expect((await store.search(["tenant", "alice"]))[0].namespace).toEqual([
        "tenant",
        "alice",
        "files",
      ]);
      expect(await store.search([])).toHaveLength(1);
      expect(
        (await store.get(["tenant", "alice", "files"], "secret"))?.value
      ).toEqual({ text: "original" });
    } finally {
      await store.stop();
    }
  });

  const invalidLabels: [string, string[]][] = [
    ["an empty label", ["tenant", ""]],
    // `String(1.5)` contains the delimiter, so a type check is part of the
    // label check.
    ["a non-string label", ["tenant", 1.5 as unknown as string]],
    ["a dotted label", ["tenant", "alice.files"]],
  ];

  describe.each([false, true])(
    "shared namespace rules (batched: %s)",
    (batched) => {
      const setup = () => {
        const underlying = new RecordingStore();
        const store = batched ? new AsyncBatchedStore(underlying) : underlying;
        store.start();
        return { underlying, store };
      };

      it.each(invalidLabels)(
        "should reject %s in gets, deletes and searches",
        async (_, namespace) => {
          const { underlying, store } = setup();
          try {
            await expect(store.get(namespace, "k")).rejects.toThrow(
              InvalidNamespaceError
            );
            await expect(store.delete(namespace, "k")).rejects.toThrow(
              InvalidNamespaceError
            );
            await expect(store.search(namespace)).rejects.toThrow(
              InvalidNamespaceError
            );
            expect(underlying.execute).not.toHaveBeenCalled();
          } finally {
            await store.stop();
          }
        }
      );

      it("should not apply put-only rules to gets, deletes and searches", async () => {
        const { underlying, store } = setup();
        try {
          await store.get([], "k");
          await store.get(["langgraph", "x"], "k");
          await store.delete(["langgraph", "x"], "k");
          await store.search([]);
          await store.search(["langgraph"]);
          expect(underlying.execute).toHaveBeenCalledTimes(5);
        } finally {
          await store.stop();
        }
      });

      it("should apply the BaseStore.put rules to puts", async () => {
        const { underlying, store } = setup();
        try {
          await expect(store.put([], "k", { v: 1 })).rejects.toThrow(
            InvalidNamespaceError
          );
          await expect(
            store.put(["langgraph", "x"], "k", { v: 1 })
          ).rejects.toThrow(InvalidNamespaceError);
          for (const [, namespace] of invalidLabels) {
            await expect(store.put(namespace, "k", { v: 1 })).rejects.toThrow(
              InvalidNamespaceError
            );
          }
          expect(underlying.execute).not.toHaveBeenCalled();
        } finally {
          await store.stop();
        }
      });
    }
  );

  it.each(invalidLabels)(
    "should reject %s in namespace listing filters",
    async (_, namespace) => {
      const store = new RecordingStore();
      await expect(store.listNamespaces({ prefix: namespace })).rejects.toThrow(
        InvalidNamespaceError
      );
      await expect(store.listNamespaces({ suffix: namespace })).rejects.toThrow(
        InvalidNamespaceError
      );
      expect(store.execute).not.toHaveBeenCalled();
    }
  );

  it("should allow empty, reserved-root and wildcard listing filters", async () => {
    const store = new RecordingStore();
    await store.listNamespaces({ prefix: [] });
    await store.listNamespaces({ prefix: ["langgraph", "*"] });
    await store.listNamespaces({ suffix: ["*", "files"] });
    expect(store.execute).toHaveBeenCalledTimes(3);
  });

  it("should fail only the invalid caller when operations share a batch", async () => {
    const underlying = new InMemoryStore();
    await underlying.put(["tenant", "alice"], "k", { text: "original" });
    const dispatched = vi.spyOn(underlying, "batch");
    const store = new AsyncBatchedStore(underlying);
    store.start();
    try {
      const [valid, ...invalid] = await Promise.allSettled([
        store.get(["tenant", "alice"], "k"),
        store.get(["tenant", ""], "k"),
        store.delete(["tenant", 1.5 as unknown as string], "k"),
        store.search(["tenant", ""]),
        store.put(["tenant.alice"], "k", { text: "overwrite" }),
      ]);
      expect(valid).toMatchObject({
        status: "fulfilled",
        value: { value: { text: "original" } },
      });
      for (const result of invalid) {
        expect(result.status).toBe("rejected");
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
          InvalidNamespaceError
        );
      }
      expect(dispatched).toHaveBeenCalledOnce();
      expect(dispatched.mock.calls[0][0]).toEqual([
        { namespace: ["tenant", "alice"], key: "k" },
      ]);
    } finally {
      await store.stop();
    }
  });
});
