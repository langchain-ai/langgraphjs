import { describe, expect, it } from "vitest";
import { isDeltaSnapshot, MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation } from "../graph/index.js";
import { StateGraph } from "../graph/state.js";
import { Overwrite, START } from "../constants.js";
import { DeltaChannel } from "../channels/delta.js";
import { LastValue } from "../channels/last_value.js";
import { Channel, Pregel } from "../pregel/index.js";

const extend = (current: number[], writes: number[][]): number[] => [
  ...current,
  ...writes.flat(),
];

describe("an Overwrite through updateState", () => {
  it("snapshots its DeltaChannel on the checkpoint it saves, as a node's does", async () => {
    const saver = new MemorySaver();
    const graph = new StateGraph(
      Annotation.Root({ log: new DeltaChannel<number[], number[]>(extend) })
    )
      .addNode("model", () => ({}))
      .addEdge(START, "model")
      .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: "t" } };
    await graph.invoke({ log: [0] }, config);

    await graph.updateState(config, { log: new Overwrite([1]) }, "model");

    const head = await saver.getTuple(config);
    expect(isDeltaSnapshot(head?.checkpoint.channel_values.log)).toBe(true);
    expect((await graph.getState(config)).values.log).toEqual([1]);
  });

  it("snapshots its DeltaChannel when the update is the input", async () => {
    const saver = new MemorySaver();
    const graph = new Pregel({
      nodes: {
        n: Channel.subscribeTo("go")
          .pipe(() => [2])
          .pipe(Channel.writeTo(["log"])),
      },
      channels: {
        log: new DeltaChannel<number[], number[]>(extend),
        go: new LastValue<number>(),
      },
      inputChannels: ["log", "go"],
      outputChannels: ["log"],
      checkpointer: saver,
    });
    const config = { configurable: { thread_id: "t" } };
    await graph.invoke({ log: [0], go: 1 }, config);

    await graph.updateState(config, { log: new Overwrite([1]) }, "__input__");

    const head = await saver.getTuple(config);
    expect(isDeltaSnapshot(head?.checkpoint.channel_values.log)).toBe(true);
    expect((await graph.getState(config)).values.log).toEqual([1]);
  });
});
