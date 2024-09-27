import { describe, it, expect, jest } from "@jest/globals";
import { BaseStore, Operation, OperationResults, Item } from "../store/base.js";
import { AsyncBatchedStore } from "../store/batch.js";

describe("AsyncBatchedStore", () => {
  it("should batch concurrent calls", async () => {
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

    const store = new AsyncBatchedStore(new MockStore());

    // Start the store
    store.start();

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
        { namespacePrefix: ["a", "b"], limit: 10, offset: 0 },
        { namespacePrefix: ["c", "d"], limit: 10, offset: 0 },
      ],
    ]);

    await store.stop();
  });
});
