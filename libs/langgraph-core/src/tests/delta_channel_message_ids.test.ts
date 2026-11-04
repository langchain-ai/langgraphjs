import { describe, expect, it } from "vitest";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation } from "../graph/index.js";
import {
  type Messages,
  messagesDeltaReducer,
} from "../graph/messages_reducer.js";
import { StateGraph } from "../graph/state.js";
import { Command, Overwrite, START } from "../constants.js";
import { DeltaChannel } from "../channels/delta.js";
import { LastValue } from "../channels/last_value.js";
import { Channel, RawPregel } from "./raw_pregel.js";
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

const rolePair: [string, string] = ["user", "b"];

describe.each([
  ["a message", () => [new HumanMessage("b")]],
  ["a plain message object", () => [{ role: "user", content: "b" }]],
  ["a bare plain message object", () => ({ role: "user", content: "b" })],
  [
    "a plain message object with an empty id",
    () => [{ role: "user", content: "b", id: "" }],
  ],
  ["a string", () => ["b"]],
  ["a bare string", () => "b"],
  ["a [role, content] pair", () => [rolePair]],
  [
    "a message inside an Overwrite",
    () => new Overwrite([new HumanMessage("b")]),
  ],
  [
    "a message inside an Overwrite object",
    () => ({ __overwrite__: [new HumanMessage("b")] }),
  ],
])("%s written to a DeltaChannel", (_, write) => {
  it("gets an id from a node that every read keeps", async () => {
    const graph = messagesGraph(() => ({ messages: write() }));
    const config = { configurable: { thread_id: "t" } };
    await graph.invoke({ messages: [] }, config);

    const first = await messageIds(graph, config);
    const second = await messageIds(graph, config);
    expect(first.at(-1)).toEqual(expect.stringMatching(/./));
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
    expect(first.at(-1)).toEqual(expect.stringMatching(/./));
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
    const graph = pregelGraph([]);
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
    expect(first.at(-1)).toEqual(expect.stringMatching(/./));
    expect(first).toEqual(second);
  });
});

function pregelGraph(seen: (string | undefined)[][]) {
  return new RawPregel({
    nodes: {
      look: Channel.subscribeTo(["go"])
        .join(["messages"])
        .pipe(({ messages }: { messages: BaseMessage[] }) => {
          seen.push(messages.map((m) => m.id));
          return [];
        })
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
}

describe("a message given as input to a raw Pregel graph", () => {
  it.each(["exit", "async"] as const)(
    "gets an id that every read keeps on a new thread with %s durability",
    async (durability) => {
      const graph = pregelGraph([]);
      const config = { configurable: { thread_id: "t" } };

      await graph.invoke(
        { messages: [new HumanMessage("b")], go: 1 },
        { ...config, durability }
      );

      const first = await messageIds(graph, config);
      const second = await messageIds(graph, config);
      expect(first.at(-1)).toEqual(expect.stringMatching(/./));
      expect(first).toEqual(second);
    }
  );

  it("reads back with the ids the run's nodes saw", async () => {
    const seen: (string | undefined)[][] = [];
    const graph = pregelGraph(seen);
    const config = { configurable: { thread_id: "t" } };
    await graph.invoke(
      { messages: [new HumanMessage({ content: "a", id: "a" })], go: 1 },
      config
    );

    await graph.invoke(
      { messages: [{ role: "user", content: "b" }], go: 1 },
      config
    );

    const saved = await messageIds(graph, config);
    expect(saved).not.toContain(undefined);
    expect(seen.at(-1)).toEqual(saved);
  });
});

describe("a DeltaChannel with messagesDeltaReducer", () => {
  it("adds a reused array's messages each time and leaves the array as it was", async () => {
    const turn = ["b"];
    const graph = messagesGraph();
    const config = { configurable: { thread_id: "t" } };

    await graph.invoke({ messages: turn }, config);
    await graph.invoke({ messages: turn }, config);

    const ids = await messageIds(graph, config);
    expect(new Set(ids).size).toBe(2);
    expect(turn).toEqual(["b"]);
  });

  it("doesn't write into a frozen array", async () => {
    const frozen = [new AIMessage({ content: "a", id: "a" }), "b"];
    Object.freeze(frozen);
    const graph = messagesGraph(() => ({ messages: frozen }));
    const config = { configurable: { thread_id: "t" } };

    await graph.invoke({ messages: [] }, config);

    const ids = await messageIds(graph, config);
    expect(ids).toEqual(["a", expect.stringMatching(/./)]);
  });

  it("gives a Command forked from an older checkpoint an id", async () => {
    const graph = messagesGraph();
    const config = { configurable: { thread_id: "t" } };
    await graph.invoke(
      { messages: [new HumanMessage({ content: "a", id: "a" })] },
      config
    );
    let beforeModel: RunnableConfig | undefined;
    for await (const snapshot of graph.getStateHistory(config)) {
      if (snapshot.next.includes("model")) beforeModel = snapshot.config;
    }

    await graph.invoke(new Command({ update: { messages: "b" } }), beforeModel);

    const first = await messageIds(graph, config);
    const second = await messageIds(graph, config);
    expect(first.at(-1)).toEqual(expect.stringMatching(/./));
    expect(first).toEqual(second);
  });

  it("leaves a Command's own [channel, value] pairs as they were", async () => {
    const pair: [string, unknown] = ["messages", "b"];
    const graph = new StateGraph(MessagesState)
      .addNode("model", () => new Command({ update: [pair] }))
      .addEdge(START, "model")
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "t" } };

    await graph.invoke({ messages: [] }, config);
    await graph.invoke({ messages: [] }, config);

    expect(new Set(await messageIds(graph, config)).size).toBe(2);
    expect(pair).toEqual(["messages", "b"]);
  });

  it("turns the plain objects in an Overwrite into messages", async () => {
    const fromJson: BaseMessage[] = JSON.parse(
      '[{"role": "user", "content": "b"}]'
    );
    const graph = messagesGraph(() => ({ messages: new Overwrite(fromJson) }));
    const config = { configurable: { thread_id: "t" } };

    await graph.invoke({ messages: [] }, config);

    const { values } = await graph.getState(config);
    const [message] = (values as { messages: BaseMessage[] }).messages;
    expect(BaseMessage.isInstance(message)).toBe(true);
    expect(message.id).toEqual(expect.stringMatching(/./));
  });

  it("is recognized from another copy of the package", async () => {
    const copy = (state: BaseMessage[], writes: Messages[]) =>
      messagesDeltaReducer(state, writes);
    Object.defineProperty(
      copy,
      Symbol.for("langgraph.messages_delta_reducer"),
      { value: true }
    );
    const graph = new StateGraph(
      Annotation.Root({ messages: new DeltaChannel(copy) })
    )
      .addNode("model", () => ({ messages: ["b"] }))
      .addEdge(START, "model")
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "t" } };

    await graph.invoke({ messages: [] }, config);

    expect(await messageIds(graph, config)).toEqual([
      expect.stringMatching(/./),
    ]);
  });
});

describe("a DeltaChannel without messagesDeltaReducer", () => {
  it("still gives message objects ids", async () => {
    const wrapped = (state: BaseMessage[], writes: Messages[]) =>
      messagesDeltaReducer(state, writes);
    const graph = new StateGraph(
      Annotation.Root({ messages: new DeltaChannel(wrapped) })
    )
      .addNode("model", () => ({ messages: [new AIMessage("b")] }))
      .addEdge(START, "model")
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "t" } };

    await graph.invoke({ messages: [new HumanMessage("a")] }, config);

    const first = await messageIds(graph, config);
    const second = await messageIds(graph, config);
    expect(first).toEqual([
      expect.stringMatching(/./),
      expect.stringMatching(/./),
    ]);
    expect(first).toEqual(second);
  });

  const extend = (state: unknown[], writes: unknown[]) => [
    ...state,
    ...writes.flatMap((w) => (Array.isArray(w) ? w : [w])),
  ];

  it.each([
    ["an array", () => [{ type: "tool", name: "search" }]],
    ["an Overwrite", () => new Overwrite([{ type: "tool", name: "search" }])],
  ])("keeps %s of plain objects as written", async (_, write) => {
    const graph = new StateGraph(
      Annotation.Root({ events: new DeltaChannel(extend) })
    )
      .addNode("logger", () => ({ events: write() }))
      .addEdge(START, "logger")
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "t" } };

    await graph.invoke({ events: [] }, config);

    const { values } = await graph.getState(config);
    expect(values.events).toEqual([{ type: "tool", name: "search" }]);
  });
});
