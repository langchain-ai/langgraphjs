import { describe, expect, it } from "vitest";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation } from "../graph/index.js";
import { messagesDeltaReducer } from "../graph/messages_reducer.js";
import { StateGraph } from "../graph/state.js";
import { Overwrite, START } from "../constants.js";
import { DeltaChannel } from "../channels/delta.js";
import { LastValue } from "../channels/last_value.js";
import { Channel, Pregel } from "../pregel/index.js";
import type { StateSnapshot } from "../pregel/types.js";

async function messageIds(
  graph: { getState(config: RunnableConfig): Promise<StateSnapshot> },
  config: RunnableConfig
) {
  const { values } = await graph.getState(config);
  return (values as { messages: BaseMessage[] }).messages.map((m) => m.id);
}

const MessagesState = Annotation.Root({
  messages: new DeltaChannel(messagesDeltaReducer),
});

function messagesGraph(
  model: () => typeof MessagesState.Update = () => ({})
) {
  return new StateGraph(MessagesState)
    .addNode("model", model)
    .addEdge(START, "model")
    .compile({ checkpointer: new MemorySaver() });
}

describe.each([
  ["a message", () => [new HumanMessage("b")]],
  ["a plain message object", () => [{ role: "user", content: "b" }]],
  [
    "a message inside an Overwrite",
    () => new Overwrite([new HumanMessage("b")]),
  ],
])("%s written to a DeltaChannel", (_, write) => {
  it("gets an id from a node that every read keeps", async () => {
    const graph = messagesGraph(() => ({ messages: write() }));
    const config = { configurable: { thread_id: "t" } };
    await graph.invoke({ messages: [] }, config);

    const first = await messageIds(graph, config);
    const second = await messageIds(graph, config);
    expect(first.at(-1)).toEqual(expect.any(String));
    expect(first).toEqual(second);
  });

  it("gets an id from updateState that every read keeps", async () => {
    const graph = messagesGraph();
    const config = { configurable: { thread_id: "t" } };
    await graph.invoke(
      { messages: [new HumanMessage({ content: "a", id: "a" })] },
      config
    );

    await graph.updateState(config, { messages: write() }, "model");

    const first = await messageIds(graph, config);
    const second = await messageIds(graph, config);
    expect(first.at(-1)).toEqual(expect.any(String));
    expect(first).toEqual(second);
  });
});

describe("a message saved through updateState", () => {
  it("gets an id on a checkpoint the thread moved past", async () => {
    const graph = messagesGraph();
    const config = { configurable: { thread_id: "t" } };
    await graph.invoke(
      { messages: [new HumanMessage({ content: "a", id: "a" })] },
      config
    );
    const older = (await graph.getState(config)).config;
    await graph.invoke(
      { messages: [new HumanMessage({ content: "c", id: "c" })] },
      config
    );

    const branch = await graph.updateState(
      older,
      { messages: [new HumanMessage("b")] },
      "model"
    );

    const ids = await messageIds(graph, branch);
    expect(ids.at(-1)).toEqual(expect.any(String));
  });

  it("gets an id that every read keeps when the update is the input", async () => {
    const graph = new Pregel({
      nodes: {
        n: Channel.subscribeTo("go")
          .pipe(() => [new HumanMessage({ content: "n", id: "n" })])
          .pipe(Channel.writeTo(["messages"])),
      },
      channels: {
        messages: new DeltaChannel(messagesDeltaReducer),
        go: new LastValue<number>(),
      },
      inputChannels: ["messages", "go"],
      outputChannels: ["messages"],
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "t" } };
    await graph.invoke(
      { messages: [new HumanMessage({ content: "a", id: "a" })], go: 1 },
      config
    );

    await graph.updateState(
      config,
      { messages: [new HumanMessage("b")] },
      "__input__"
    );

    const first = await messageIds(graph, config);
    const second = await messageIds(graph, config);
    expect(first.at(-1)).toEqual(expect.any(String));
    expect(first).toEqual(second);
  });
});
