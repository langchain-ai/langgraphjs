import { it, expect } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { uuid6 } from "../../id.js";
import { JsonPlusSerializer } from "../jsonplus.js";

const messageWithToolCall = new AIMessage({
  content: "",
  tool_calls: [
    {
      name: "current_weather_sf",
      args: {
        input: "",
      },
      type: "tool_call",
      id: "call_Co6nrPmiAdWWZQHCNdEZUjTe",
    },
  ],
  invalid_tool_calls: [],
  additional_kwargs: {
    function_call: undefined,
    tool_calls: [
      {
        id: "call_Co6nrPmiAdWWZQHCNdEZUjTe",
        type: "function",
        function: {
          name: "current_weather_sf",
          arguments: '{"input":""}',
        },
      },
    ],
  },
  response_metadata: {
    tokenUsage: {
      completionTokens: 15,
      promptTokens: 84,
      totalTokens: 99,
    },
    finish_reason: "tool_calls",
    system_fingerprint: "fp_a2ff031fb5",
  },
  id: "chatcmpl-A0s8Rd97RnFo6xMlYgpJDDfV8J1cl",
});

const complexValue = {
  number: 1,
  id: uuid6(-1),
  error: new Error("test error"),
  set: new Set([1, 2, 3, 4]),
  map: new Map([
    ["a", 1],
    ["b", 2],
  ]),
  regex: /foo*/gi,
  message: new AIMessage("test message"),
  messageWithToolCall,
  array: [
    new Error("nestedfoo"),
    5,
    true,
    null,
    false,
    {
      a: "b",
      set: new Set([4, 3, 2, 1]),
    },
  ],
  object: {
    messages: [new HumanMessage("hey there"), new AIMessage("hi how are you")],
    nestedNullVal: null,
    emptyString: "",
  },
  emptyString: "",
  nullVal: null,
};

const VALUES = [
  ["undefined", undefined],
  ["null", null],
  ["empty string", ""],
  ["simple string", "foobar"],
  ["various data types", complexValue],
  ["an AIMessage with a tool call", messageWithToolCall],
  [
    "object with the same value in memory duplicated but not nested",
    { duped1: complexValue, duped2: complexValue },
  ],
] satisfies [string, unknown][];

it.each(VALUES)(
  "should serialize and deserialize %s",
  async (_description, value) => {
    const serde = new JsonPlusSerializer();
    const [type, serialized] = await serde.dumpsTyped(value);
    const deserialized = await serde.loadsTyped(type, serialized);
    expect(deserialized).toEqual(value);
  }
);

it("Should replace circular JSON inputs", async () => {
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  a.b = b;
  b.a = a;

  const circular = {
    a,
    b,
  };
  const serde = new JsonPlusSerializer();
  const decoder = new TextDecoder();
  const [type, serialized] = await serde.dumpsTyped(circular);
  expect(type).toEqual("json");
  expect(decoder.decode(serialized)).toEqual(
    `{"a":{"b":{"a":"[Circular]"}},"b":{"a":"[Circular]"}}`
  );
});
