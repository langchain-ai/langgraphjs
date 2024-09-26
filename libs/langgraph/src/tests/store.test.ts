import { describe, it, expect, jest } from "@jest/globals";
import { AsyncBatchedStore, BaseStore } from "@langchain/langgraph-checkpoint";

describe("AsyncBatchedStore", () => {
  it("should batch concurrent calls", async () => {
    const listMock = jest.fn();

    class MockStore extends BaseStore {
      async list(
        prefixes: string[]
      ): Promise<Record<string, Record<string, Record<string, any>>>> {
        listMock(prefixes);
        return Object.fromEntries(
          prefixes.map((prefix) => [prefix, { [prefix]: { value: 1 } }])
        );
      }

      async put(
        _writes: Array<[string, string, Record<string, any> | null]>
      ): Promise<void> {
        // Not used in this test
      }
    }

    const store = new AsyncBatchedStore(new MockStore());

    // Start the store
    store.start();

    // Concurrent calls are batched
    const results = await Promise.all([
      store.list(["a", "b"]),
      store.list(["c", "d"]),
    ]);

    expect(results).toEqual([
      { a: { a: { value: 1 } }, b: { b: { value: 1 } } },
      { c: { c: { value: 1 } }, d: { d: { value: 1 } } },
    ]);

    expect(listMock.mock.calls).toEqual([[["a", "b", "c", "d"]]]);

    store.stop();
  });
});
