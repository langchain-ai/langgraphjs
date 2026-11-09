import { describe, expect, it, vi } from "vitest";
import { Embeddings } from "@langchain/core/embeddings";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import { Annotation } from "../graph/annotation.js";
import { StateGraph } from "../graph/state.js";
import { END, START } from "../constants.js";
import { getStore } from "../pregel/utils/config.js";

class TestEmbeddings extends Embeddings {
  async embedQuery(text: string): Promise<number[]> {
    return text === "target" ? [1, 0] : [0, 1];
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embedQuery(text)));
  }
}

describe("Store indexing inside graph nodes", () => {
  it.each<{ index: false | string[] }>([
    { index: false },
    { index: ["alternate"] },
  ])(
    "preserves the put index option $index",
    async ({ index }) => {
      const embeddings = new TestEmbeddings({});
      const embedDocuments = vi.spyOn(embeddings, "embedDocuments");
      const store = new InMemoryStore({
        index: { dims: 2, embeddings, fields: ["text"] },
      });
      const State = Annotation.Root({ done: Annotation<boolean>() });
      const graph = new StateGraph(State)
        .addNode("write", async () => {
          const activeStore = getStore();
          if (!activeStore) throw new Error("Expected graph store");
          await activeStore.put(
            ["docs"],
            "item",
            { text: "default", alternate: "target" },
            index === false ? false : [...index]
          );
          return { done: true };
        })
        .addEdge(START, "write")
        .addEdge("write", END)
        .compile({ store });

      expect(await graph.invoke({ done: false })).toEqual({ done: true });
      expect((await store.get(["docs"], "item"))?.value).toEqual({
        text: "default",
        alternate: "target",
      });
      const results = await store.search(["docs"], { query: "target" });
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(index === false ? undefined : 1);
      if (index === false) {
        expect(embedDocuments).not.toHaveBeenCalled();
      } else {
        expect(embedDocuments).toHaveBeenCalledExactlyOnceWith(["target"]);
      }
    }
  );
});
