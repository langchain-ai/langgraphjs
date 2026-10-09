import { describe, expect, it } from "vitest";
import { InMemoryCache, MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation } from "../graph/index.js";
import { StateGraph } from "../graph/state.js";
import { START } from "../constants.js";
import { DeltaChannel } from "../channels/delta.js";

const appendReducer = (current: string[], writes: string[][]): string[] => {
  const out = [...current];
  for (const w of writes) out.push(...w);
  return out;
};

const State = Annotation.Root({
  log: new DeltaChannel<string[], string[]>(appendReducer),
  plain: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

const INPUT = { log: [], plain: [] };

class CountsSets extends InMemoryCache {
  sets = 0;

  async set(pairs: Parameters<InMemoryCache["set"]>[0]) {
    this.sets += 1;
    return super.set(pairs);
  }
}

describe("a node served from the node cache", () => {
  it.each(["sync", "async", "exit"] as const)(
    "saves its writes like a node that ran, without caching them again (durability: %s)",
    async (durability) => {
      const runs: string[] = [];
      const node = (name: string) => () => {
        runs.push(name);
        return { log: [name], plain: [name] };
      };
      const cache = new CountsSets();
      const graph = new StateGraph(State)
        .addNode("a", node("a"))
        .addNode("b", node("b"), { cachePolicy: true })
        .addNode("c", node("c"))
        .addEdge(START, "a")
        .addEdge("a", "b")
        .addEdge("b", "c")
        .compile({ checkpointer: new MemorySaver(), cache });
      await graph.invoke(INPUT, {
        configurable: { thread_id: "1" },
        durability,
      });
      const config = { configurable: { thread_id: "2" } };

      await graph.invoke(INPUT, { ...config, durability });

      expect(runs).toEqual(["a", "b", "c", "a", "c"]);
      expect(cache.sets, "the cache hit was written back to the cache").toBe(
        1
      );
      for await (const state of graph.getStateHistory(config)) {
        expect(state.values.log ?? []).toEqual(state.values.plain ?? []);
      }
    }
  );
});
