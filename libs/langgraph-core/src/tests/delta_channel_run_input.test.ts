import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Channel, Pregel } from "../pregel/index.js";
import { BinaryOperatorAggregate } from "../channels/binop.js";
import { DeltaChannel } from "../channels/delta.js";
import { LastValue } from "../channels/last_value.js";

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);

const deltaInputGraph = () =>
  new Pregel({
    nodes: {
      n: Channel.subscribeTo("go")
        .pipe(() => [2])
        .pipe(Channel.writeTo(["log", "plain"])),
    },
    channels: {
      log: new DeltaChannel<number[], number[]>((state, writes) =>
        sorted([...state, ...writes.flat()])
      ),
      plain: new BinaryOperatorAggregate<number[]>(
        (a, b) => sorted([...a, ...b]),
        () => []
      ),
      go: new LastValue<number>(),
    },
    inputChannels: ["log", "plain", "go"],
    outputChannels: ["log", "plain"],
    checkpointer: new MemorySaver(),
  });

const expectLogToReadLikePlainEverywhere = async (
  graph: ReturnType<typeof deltaInputGraph>,
  config: RunnableConfig
) => {
  for await (const state of graph.getStateHistory(config)) {
    const values = state.values as Record<string, number[] | undefined>;
    expect(values.log ?? []).toEqual(values.plain ?? []);
  }
};

describe.each(["sync", "async", "exit"] as const)(
  "a run's input to a DeltaChannel input channel (durability: %s)",
  (durability) => {
    it("reads back on its own checkpoints", async () => {
      const graph = deltaInputGraph();
      const config = { configurable: { thread_id: "t" } };

      await graph.invoke({ log: [0], plain: [0], go: 1 }, { ...config, durability });
      await graph.invoke({ log: [5], plain: [5], go: 1 }, { ...config, durability });

      await expectLogToReadLikePlainEverywhere(graph, config);
    });

    it.each([
      ["without", { go: 1 }],
      ["with", { log: [5], plain: [5], go: 1 }],
    ])(
      "from an older checkpoint stays out of its other branch, %s delta input",
      async (_, otherBranchInput) => {
        const graph = deltaInputGraph();
        const config = { configurable: { thread_id: "t" } };
        await graph.invoke({ go: 1 }, { ...config, durability });
        const older = (await graph.getState(config)).config;
        await graph.invoke(otherBranchInput, { ...config, durability });

        await graph.invoke({ log: [7], plain: [7], go: 1 }, { ...older, durability });

        await expectLogToReadLikePlainEverywhere(graph, config);
      }
    );
  }
);
