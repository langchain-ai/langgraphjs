import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { DeltaChannel } from "../channels/delta.js";
import { LastValue } from "../channels/last_value.js";
import { Channel, Pregel } from "../pregel/index.js";

const extend = (current: number[], writes: number[][]): number[] => [
  ...current,
  ...writes.flat(),
];

const config = { configurable: { thread_id: "t" } };

async function runOnce(reads: number[][]) {
  const graph = new Pregel({
    nodes: {
      writer: Channel.subscribeTo("a")
        .pipe(() => [1])
        .pipe(Channel.writeTo(["d"])),
      reader: Channel.subscribeTo("d").pipe((d: number[]) => {
        reads.push(d);
        return null;
      }),
    },
    channels: {
      a: new LastValue<string>(),
      d: new DeltaChannel<number[], number[]>(extend),
    },
    inputChannels: "a",
    outputChannels: ["d"],
    checkpointer: new MemorySaver(),
  });
  await graph.invoke("go", config);
  let input;
  for await (const state of graph.getStateHistory(config)) {
    if (state.metadata?.step === -1) input = state.config;
  }
  return { graph, input: input! };
}

describe("a fork from before a DeltaChannel's first write", () => {
  it.each([
    ["an update as input", { a: "go" }, "__input__"],
    ["an empty update", undefined, undefined],
  ])(
    "doesn't start the channel's subscriber that never ran (%s)",
    async (_, values, asNode) => {
      const reads: number[][] = [];
      const { graph, input } = await runOnce(reads);

      const fork = await graph.updateState(input, values, asNode);

      expect((await graph.getState(fork)).next).toEqual(["writer"]);
      await graph.invoke(null, fork);
      expect(reads).toEqual([[1], [1]]);
    }
  );

  it("doesn't start the channel's subscriber that never ran on a replay", async () => {
    const reads: number[][] = [];
    const { graph, input } = await runOnce(reads);

    await graph.invoke(null, { ...input, durability: "sync" });

    expect(reads).toEqual([[1], [1]]);
  });
});
