import { describe, expect, it } from "vitest";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation } from "../graph/index.js";
import {
  inputMessageId,
  messagesDeltaReducer,
  messagesStateReducer,
} from "../graph/messages_reducer.js";
import { StateGraph } from "../graph/state.js";
import { Overwrite, START } from "../constants.js";
import { DeltaChannel } from "../channels/delta.js";

const RUN_ID = "3f2a6c1e-8b4d-4e2a-9c7f-1d5e8a2b4c6f";

function graphFor(messages: unknown) {
  const State = Annotation.Root({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: messages as any,
    other: Annotation<unknown>,
  });
  return new StateGraph(State)
    .addNode("noop", () => ({}))
    .addEdge(START, "noop")
    .compile({ checkpointer: new MemorySaver() });
}

const channels: [string, () => unknown][] = [
  [
    "messagesStateReducer",
    () =>
      Annotation<BaseMessage[]>({
        reducer: messagesStateReducer,
        default: () => [],
      }),
  ],
  [
    "DeltaChannel(messagesDeltaReducer)",
    () => new DeltaChannel(messagesDeltaReducer),
  ],
];

async function run(
  channel: () => unknown,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> = { run_id: RUN_ID },
) {
  const graph = graphFor(channel());
  const config = { configurable: { thread_id: "t" }, metadata };
  await graph.invoke(input, config);
  const { values } = await graph.getState(config);
  return values as { messages: BaseMessage[]; other: unknown };
}

describe("inputMessageId", () => {
  it("matches Python's uuid5(UUID(run_id), 'input:messages:0')", () => {
    // python3 -c 'import uuid; print(uuid.uuid5(uuid.UUID("3f2a6c1e-8b4d-4e2a-9c7f-1d5e8a2b4c6f"), "input:messages:0"))'
    expect(inputMessageId(RUN_ID, "messages", 0)).toBe(
      "aad78bc1-b4a9-5a64-af69-a8a9be5541cc",
    );
  });
});

describe.each(channels)("input messages in a %s channel", (_, channel) => {
  const pair: [string, string] = ["user", "b"];
  it.each([
    ["a message", [new HumanMessage("a"), new HumanMessage("b")]],
    [
      "a plain object",
      [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
    ],
    ["a string", ["a", "b"]],
    ["a [role, content] pair", [["user", "a"], pair]],
  ])("get the derived id when %s has none", async (_, items) => {
    const { messages } = await run(channel, { messages: items });
    expect(messages.map((m) => m.id)).toEqual([
      inputMessageId(RUN_ID, "messages", 0),
      inputMessageId(RUN_ID, "messages", 1),
    ]);
  });

  it.each([
    ["a message", () => new HumanMessage("a")],
    ["a plain object", () => ({ role: "user", content: "a" })],
    ["a string", () => "a"],
  ])("give a single %s index 0", async (_, item) => {
    const { messages } = await run(channel, { messages: item() });
    expect(messages.map((m) => m.id)).toEqual([
      inputMessageId(RUN_ID, "messages", 0),
    ]);
  });

  it("get the derived id inside an Overwrite", async () => {
    const { messages } = await run(channel, {
      messages: new Overwrite(["a", new HumanMessage("b")]),
    });
    expect(messages.map((m) => m.id)).toEqual([
      inputMessageId(RUN_ID, "messages", 0),
      inputMessageId(RUN_ID, "messages", 1),
    ]);
  });

  it("keep ids the caller set", async () => {
    const { messages } = await run(channel, {
      messages: [new HumanMessage({ content: "a", id: "mine" }), "b"],
    });
    expect(messages.map((m) => m.id)).toEqual([
      "mine",
      inputMessageId(RUN_ID, "messages", 1),
    ]);
  });

  it("get random ids in a run without a run id", async () => {
    const { messages } = await run(channel, { messages: ["a"] }, {});
    expect(messages[0].id).toEqual(expect.any(String));
    expect(messages[0].id).not.toBe(inputMessageId(RUN_ID, "messages", 0));
  });

  it("leave other channels untouched", async () => {
    const other = [{ role: "user", content: "a" }];
    const { values } = {
      values: await run(channel, { messages: [], other }),
    };
    expect(values.other).toEqual([{ role: "user", content: "a" }]);
  });
});

describe("an empty caller id", () => {
  it("is kept in a messagesStateReducer channel", async () => {
    const { messages } = await run(channels[0][1], {
      messages: [new HumanMessage({ content: "a", id: "" })],
    });
    expect(messages[0].id).toBe("");
  });
});
