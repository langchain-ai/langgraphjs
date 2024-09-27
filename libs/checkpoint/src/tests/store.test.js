"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const base_js_1 = require("../store/base.js");
const batch_js_1 = require("../store/batch.js");
(0, globals_1.describe)("AsyncBatchedStore", () => {
  (0, globals_1.it)("should batch concurrent calls", async () => {
    const batchMock = globals_1.jest.fn();
    class MockStore extends base_js_1.BaseStore {
      async batch(operations) {
        batchMock(operations);
        const results = [];
        for (const op of operations) {
          if ("namespacePrefix" in op) {
            // SearchOperation
            const items = op.namespacePrefix.flatMap((prefix) => [
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
        return results;
      }
    }
    const store = new batch_js_1.AsyncBatchedStore(new MockStore());
    // Start the store
    store.start();
    // Concurrent calls are batched
    const results = await Promise.all([
      store.search(["a", "b"]),
      store.search(["c", "d"]),
    ]);
    (0, globals_1.expect)(results).toEqual([
      [
        {
          value: { value: 1 },
          scores: {},
          id: "a",
          namespace: ["a"],
          createdAt: globals_1.expect.any(Date),
          updatedAt: globals_1.expect.any(Date),
          lastAccessedAt: globals_1.expect.any(Date),
        },
        {
          value: { value: 1 },
          scores: {},
          id: "b",
          namespace: ["b"],
          createdAt: globals_1.expect.any(Date),
          updatedAt: globals_1.expect.any(Date),
          lastAccessedAt: globals_1.expect.any(Date),
        },
      ],
      [
        {
          value: { value: 1 },
          scores: {},
          id: "c",
          namespace: ["c"],
          createdAt: globals_1.expect.any(Date),
          updatedAt: globals_1.expect.any(Date),
          lastAccessedAt: globals_1.expect.any(Date),
        },
        {
          value: { value: 1 },
          scores: {},
          id: "d",
          namespace: ["d"],
          createdAt: globals_1.expect.any(Date),
          updatedAt: globals_1.expect.any(Date),
          lastAccessedAt: globals_1.expect.any(Date),
        },
      ],
    ]);
    (0, globals_1.expect)(batchMock.mock.calls).toEqual([
      [
        { namespacePrefix: ["a", "b"], limit: 10, offset: 0 },
        { namespacePrefix: ["c", "d"], limit: 10, offset: 0 },
      ],
    ]);
    await store.stop();
  });
});
