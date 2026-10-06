import { describe, expect, it, vi } from "vitest";
import {
  BaseStore,
  InvalidNamespaceError,
  type Operation,
  type OperationResults,
} from "../store/base.js";
import { AsyncBatchedStore } from "../store/batch.js";
import { InMemoryStore } from "../store/memory.js";

class RecordingStore extends BaseStore {
  execute = vi.fn(async (_ops: Operation[]) => []);

  async batch<Op extends Operation[]>(ops: Op): Promise<OperationResults<Op>> {
    return (await this.execute(ops)) as OperationResults<Op>;
  }
}

describe("namespace delimiter validation", () => {
  it.each([false, true])(
    "rejects dotted aliases before dispatch (batched: %s)",
    async (batched) => {
      const underlying = new RecordingStore();
      const store = batched ? new AsyncBatchedStore(underlying) : underlying;
      const alias = ["tenant", "alice.files"];
      await expect(store.get(alias, "secret")).rejects.toThrow(InvalidNamespaceError);
      await expect(store.delete(alias, "secret")).rejects.toThrow(InvalidNamespaceError);
      await expect(store.put(alias, "secret", { text: "overwrite" })).rejects.toThrow(
        InvalidNamespaceError,
      );
      await expect(store.search(alias)).rejects.toThrow(InvalidNamespaceError);
      expect(underlying.execute).not.toHaveBeenCalled();
    },
  );

  it("rejects dotted listing filters while retaining wildcards", async () => {
    const store = new RecordingStore();
    await expect(store.listNamespaces({ prefix: ["tenant.alice"] })).rejects.toThrow(
      InvalidNamespaceError,
    );
    await expect(store.listNamespaces({ suffix: ["alice.files"] })).rejects.toThrow(
      InvalidNamespaceError,
    );
    await store.listNamespaces({ prefix: ["tenant", "*"] });
    expect(store.execute).toHaveBeenCalledOnce();
  });

  it("keeps hierarchical searches and protects exact keys through the wrapper", async () => {
    const underlying = new InMemoryStore();
    await underlying.put(["tenant", "alice", "files"], "secret", { text: "original" });
    const store = new AsyncBatchedStore(underlying);
    store.start();
    try {
      await expect(store.get(["tenant:alice", "files"], "secret")).rejects.toThrow(
        InvalidNamespaceError,
      );
      await expect(store.delete(["tenant:alice", "files"], "secret")).rejects.toThrow(
        InvalidNamespaceError,
      );
      await expect(
        store.put(["tenant:alice", "files"], "secret", { text: "overwrite" }),
      ).rejects.toThrow(InvalidNamespaceError);
      expect((await store.search(["tenant", "alice"]))[0].namespace).toEqual([
        "tenant",
        "alice",
        "files",
      ]);
      expect(await store.search([])).toHaveLength(1);
      expect((await store.get(["tenant", "alice", "files"], "secret"))?.value).toEqual({
        text: "original",
      });
      await expect(
        underlying.batch([{ namespace: ["tenant:alice", "files"], key: "secret" }]),
      ).rejects.toThrow(InvalidNamespaceError);
      await expect(
        underlying.batch([{ namespace: ["tenant:alice", "files"], key: "secret", value: null }]),
      ).rejects.toThrow(InvalidNamespaceError);
    } finally {
      await store.stop();
    }
  });

  const invalidLabels: [string, string[]][] = [
    ["an empty label", ["tenant", ""]],
    // `String(1.5)` contains the delimiter, so a type check is part of the label check.
    ["a non-string label", ["tenant", 1.5 as unknown as string]],
    ["a dotted label", ["tenant", "alice.files"]],
  ];

  describe.each([false, true])("shared namespace rules (batched: %s)", (batched) => {
    const setup = () => {
      const underlying = new RecordingStore();
      const store = batched ? new AsyncBatchedStore(underlying) : underlying;
      store.start();
      return { underlying, store };
    };

    it.each(invalidLabels)("rejects %s in reads, deletes and searches", async (_, namespace) => {
      const { underlying, store } = setup();
      try {
        await expect(store.get(namespace, "k")).rejects.toThrow(InvalidNamespaceError);
        await expect(store.delete(namespace, "k")).rejects.toThrow(InvalidNamespaceError);
        await expect(store.search(namespace)).rejects.toThrow(InvalidNamespaceError);
        expect(underlying.execute).not.toHaveBeenCalled();
      } finally {
        await store.stop();
      }
    });

    it("keeps write-only rules off reads, deletes and searches", async () => {
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

    it("applies the BaseStore.put rules to puts", async () => {
      const { underlying, store } = setup();
      try {
        await expect(store.put([], "k", { v: 1 })).rejects.toThrow(InvalidNamespaceError);
        await expect(store.put(["langgraph", "x"], "k", { v: 1 })).rejects.toThrow(
          InvalidNamespaceError,
        );
        for (const [, namespace] of invalidLabels) {
          await expect(store.put(namespace, "k", { v: 1 })).rejects.toThrow(
            InvalidNamespaceError,
          );
        }
        expect(underlying.execute).not.toHaveBeenCalled();
      } finally {
        await store.stop();
      }
    });
  });

  it.each(invalidLabels)("rejects %s in namespace listing filters", async (_, namespace) => {
    const store = new RecordingStore();
    await expect(store.listNamespaces({ prefix: namespace })).rejects.toThrow(
      InvalidNamespaceError,
    );
    await expect(store.listNamespaces({ suffix: namespace })).rejects.toThrow(
      InvalidNamespaceError,
    );
    expect(store.execute).not.toHaveBeenCalled();
  });

  it("keeps empty, reserved-root and wildcard listing filters", async () => {
    const store = new RecordingStore();
    await store.listNamespaces({ prefix: [] });
    await store.listNamespaces({ prefix: ["langgraph", "*"] });
    await store.listNamespaces({ suffix: ["*", "files"] });
    expect(store.execute).toHaveBeenCalledTimes(3);
  });

  it("fails only the invalid caller when operations share a batch", async () => {
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
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(InvalidNamespaceError);
      }
      expect(dispatched).toHaveBeenCalledOnce();
      expect(dispatched.mock.calls[0][0]).toEqual([{ namespace: ["tenant", "alice"], key: "k" }]);
    } finally {
      await store.stop();
    }
  });
});
