import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { DeltaChannel } from "../channels/delta.js";
import { START } from "../constants.js";
import { Annotation } from "../graph/index.js";
import { StateGraph } from "../graph/state.js";
import type { Durability } from "../pregel/types.js";

const appendAll = (state: string[], writes: string[][]): string[] => [
  ...state,
  ...writes.flat(),
];

class FailsTheWriteOfBOnce extends MemorySaver {
  failed = false;

  async putWrites(...args: Parameters<MemorySaver["putWrites"]>) {
    const [, writes] = args;
    if (
      !this.failed &&
      writes.some(
        ([channel, value]) =>
          channel === "log" && JSON.stringify(value) === '["b"]'
      )
    ) {
      this.failed = true;
      throw new Error("b's write was not saved");
    }
    return super.putWrites(...args);
  }
}

function aThenBThenC() {
  const State = Annotation.Root({
    log: new DeltaChannel<string[], string[]>(appendAll),
    plain: Annotation<string[]>({
      reducer: (a, b) => [...a, ...b],
      default: () => [],
    }),
  });
  return new StateGraph(State)
    .addNode("a", () => ({ log: ["a"], plain: ["a"] }))
    .addNode("b", () => ({ log: ["b"], plain: ["b"] }))
    .addNode("c", () => ({ log: ["c"], plain: ["c"] }))
    .addEdge(START, "a")
    .addEdge("a", "b")
    .addEdge("b", "c")
    .compile({ checkpointer: new FailsTheWriteOfBOnce() });
}

const INPUT = { log: [], plain: [] };
const ABC = ["a", "b", "c"];

async function failOnBsWrite(
  graph: ReturnType<typeof aThenBThenC>,
  config: { configurable: { thread_id: string }; durability: Durability }
) {
  await expect(graph.invoke(INPUT, config)).rejects.toThrow(
    "b's write was not saved"
  );
}

describe("a failed DeltaChannel write", () => {
  it.each(["sync", "async", "exit"] as const)(
    "leaves no checkpoint that reads differently from a plain channel, with durability %s",
    async (durability) => {
      const graph = aThenBThenC();
      const config = { configurable: { thread_id: "t" }, durability };

      await failOnBsWrite(graph, config);

      for await (const snapshot of graph.getStateHistory(config)) {
        expect(snapshot.values.log ?? []).toEqual(snapshot.values.plain ?? []);
      }
    }
  );

  it.each(["sync", "async"] as const)(
    "is rerun on resume, with durability %s",
    async (durability) => {
      const graph = aThenBThenC();
      const config = { configurable: { thread_id: "t" }, durability };
      await failOnBsWrite(graph, config);

      await graph.invoke(null, config);

      expect((await graph.getState(config)).values).toEqual({
        log: ["a", "b", "c"],
        plain: ["a", "b", "c"],
      });
    }
  );

  it.each([
    { thread: "a new thread", savedBefore: false },
    { thread: "a thread with a saved checkpoint", savedBefore: true },
  ])(
    "with durability exit, leaves nothing the next run on $thread replays",
    async ({ savedBefore }) => {
      const graph = aThenBThenC();
      const saver = graph.checkpointer as FailsTheWriteOfBOnce;
      const config = {
        configurable: { thread_id: "t" },
        durability: "exit" as const,
      };
      if (savedBefore) {
        saver.failed = true;
        await graph.invoke(INPUT, config);
        saver.failed = false;
      }
      await failOnBsWrite(graph, config);

      await graph.invoke(INPUT, config);

      const expected = savedBefore ? [...ABC, ...ABC] : ABC;
      expect((await graph.getState(config)).values).toEqual({
        log: expected,
        plain: expected,
      });
    }
  );
});
