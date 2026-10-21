import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Embeddings } from "@langchain/core/embeddings";
import { BaseStore } from "../store/base.js";
import { AsyncBatchedStore } from "../store/batch.js";
import { InMemoryStore } from "../store/memory.js";

class TestEmbeddings extends Embeddings {
  async embedQuery(text: string): Promise<number[]> {
    return text === "target" ? [1, 0] : [0, 1];
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embedQuery(text)));
  }
}

describe("AsyncBatchedStore indexing options", () => {
  let embeddings: TestEmbeddings;
  let underlying: InMemoryStore;
  let queue: AsyncBatchedStore;
  let store: BaseStore;

  beforeEach(() => {
    embeddings = new TestEmbeddings({});
    underlying = new InMemoryStore({
      index: { dims: 2, embeddings, fields: ["text"] },
    });
    queue = new AsyncBatchedStore(underlying);
    store = queue;
    queue.start();
  });

  afterEach(async () => {
    await queue.stop();
  });

  it.each<{
    name: string;
    index: false | string[] | undefined;
    texts: string[];
    score: number | undefined;
  }>([
    { name: "disabled", index: false, texts: [], score: undefined },
    { name: "no fields", index: [], texts: [], score: undefined },
    { name: "default fields", index: undefined, texts: ["default"], score: 0 },
    { name: "selected field", index: ["alternate"], texts: ["target"], score: 1 },
    {
      name: "wildcard fields",
      index: ["chapters[*].content"],
      texts: ["target", "other"],
      score: 1,
    },
    { name: "missing field", index: ["missing"], texts: [], score: undefined },
  ])("preserves $name through the queue", async ({ index, texts, score }) => {
    const embedDocuments = vi.spyOn(embeddings, "embedDocuments");
    const value = {
      text: "default",
      alternate: "target",
      chapters: [{ content: "target" }, { content: "other" }],
    };

    await store.put(["docs"], "item", value, index);

    expect((await store.get(["docs"], "item"))?.value).toEqual(value);
    if (texts.length) {
      expect(embedDocuments).toHaveBeenCalledExactlyOnceWith(texts);
    } else {
      expect(embedDocuments).not.toHaveBeenCalled();
    }
    const results = await store.search(["docs"], { query: "target" });
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(score);
  });

  it("keeps concurrent puts batched with independent indexing options", async () => {
    const batch = vi.spyOn(underlying, "batch");
    const embedDocuments = vi.spyOn(embeddings, "embedDocuments");
    const value = { text: "default", alternate: "target" };

    await Promise.all([
      store.put(["docs"], "disabled", value, false),
      store.put(["docs"], "selected", value, ["alternate"]),
      store.put(["docs"], "default", value),
    ]);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(3);
    expect(embedDocuments).toHaveBeenCalledTimes(1);
    expect(embedDocuments.mock.calls[0][0].slice().sort()).toEqual([
      "default",
      "target",
    ]);
    const results = await store.search(["docs"], { query: "target" });
    expect(Object.fromEntries(results.map(({ key, score }) => [key, score]))).toEqual({
      selected: 1,
      default: 0,
      disabled: undefined,
    });
  });

  it("does not call a failing embedding provider for an unindexed put", async () => {
    const embedDocuments = vi
      .spyOn(embeddings, "embedDocuments")
      .mockRejectedValue(new Error("Embedding unavailable"));

    await store.put(["docs"], "item", { text: "local only" }, false);
    expect((await store.get(["docs"], "item"))?.value).toEqual({
      text: "local only",
    });
    expect(embedDocuments).not.toHaveBeenCalled();
  });
});
