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
              scores: {},
              id: prefix,
              namespace: [prefix],
              createdAt: new Date(),
              updatedAt: new Date(),
              lastAccessedAt: new Date(),
            },
          ]);
          results.push(items);
        } else if ("id" in op && !("value" in op)) {
          // GetOperation
          results.push({
            value: { value: 1 },
            scores: {},
            id: op.id,
            namespace: op.namespace,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastAccessedAt: new Date(),
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
          scores: {},
          id: "a",
          namespace: ["a"],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
          lastAccessedAt: expect.any(Date),
        },
        {
          value: { value: 1 },
          scores: {},
          id: "b",
          namespace: ["b"],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
          lastAccessedAt: expect.any(Date),
        },
      ],
      [
        {
          value: { value: 1 },
          scores: {},
          id: "c",
          namespace: ["c"],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
          lastAccessedAt: expect.any(Date),
        },
        {
          value: { value: 1 },
          scores: {},
          id: "d",
          namespace: ["d"],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
          lastAccessedAt: expect.any(Date),
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
              scores: {},
              id: op.namespacePrefix[0],
              namespace: op.namespacePrefix,
              createdAt: new Date(),
              updatedAt: new Date(),
              lastAccessedAt: new Date(),
            },
          ]);
        } else if ("id" in op && !("value" in op)) {
          // GetOperation
          results.push({
            value: { value: 1 },
            scores: {},
            id: op.id,
            namespace: op.namespace,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastAccessedAt: new Date(),
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
      scores: {},
      id: "123",
      namespace: ["test"],
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
      lastAccessedAt: expect.any(Date),
    });
  });

  it("should implement search method", async () => {
    const result = await store.search(["test"]);
    expect(result).toEqual([
      {
        value: { value: 1 },
        scores: {},
        id: "test",
        namespace: ["test"],
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        lastAccessedAt: expect.any(Date),
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
});
