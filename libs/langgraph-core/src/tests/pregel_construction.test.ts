import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { START } from "../constants.js";
import { entrypoint } from "../func/index.js";
import { Annotation, StateGraph } from "../graph/index.js";
import * as pregelEntrypoint from "../pregel/index.js";
import { Pregel } from "../pregel/index.js";
import { PregelNode } from "../pregel/read.js";

// `Pregel` is the type of compiled graphs, built only by `StateGraph` and
// `entrypoint`.
describe("Pregel construction", () => {
  it("cannot be constructed directly", () => {
    expect(
      () =>
        new Pregel({
          nodes: { node: new PregelNode({ channels: ["a"], triggers: ["a"] }) },
          channels: { a: new EphemeralValue<string>() },
          inputChannels: "a",
          outputChannels: "a",
        })
    ).toThrowError(
      new TypeError(
        "`Pregel` cannot be constructed directly. Build graphs with `StateGraph` or `entrypoint`."
      )
    );
  });

  it("does not export Channel from @langchain/langgraph/pregel", () => {
    expect("Channel" in pregelEntrypoint).toBe(false);
  });

  it("returns Pregel instances from StateGraph and entrypoint", async () => {
    const State = Annotation.Root({ value: Annotation<number> });
    const graph = new StateGraph(State)
      .addNode("increment", (state) => ({ value: state.value + 1 }))
      .addEdge(START, "increment")
      .compile({ checkpointer: new MemorySaver() });

    const workflow = entrypoint(
      { name: "workflow", checkpointer: new MemorySaver() },
      async (value: number) => value + 1
    );

    expect(graph).toBeInstanceOf(Pregel);
    expect(workflow).toBeInstanceOf(Pregel);

    // `withConfig` copies the graph by calling its constructor again.
    const config = { configurable: { thread_id: "1" } };
    expect(
      await graph.withConfig({ recursionLimit: 5 }).invoke({ value: 1 }, config)
    ).toEqual({ value: 2 });
    expect(
      await workflow.withConfig({ recursionLimit: 5 }).invoke(1, config)
    ).toBe(2);
  });
});
