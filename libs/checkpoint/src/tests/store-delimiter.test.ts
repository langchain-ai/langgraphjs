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
});
