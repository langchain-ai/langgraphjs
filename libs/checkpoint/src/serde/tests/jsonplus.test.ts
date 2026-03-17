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
  ["a top-level Uint8Array", new Uint8Array([72, 101, 108, 108, 111])],
  [
    "a Uint8Array nested in an object",
    { data: new Uint8Array([72, 101, 108, 108, 111]), label: "hello" },
  ],
  [
    "a Uint8Array nested in an array",
    [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
  ],
  [
    "a Uint8Array deeply nested",
    { files: { image: new Uint8Array([137, 80, 78, 71]) } },
  ],
] satisfies [string, unknown][];

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && value.constructor === Uint8Array;
}

function assertTypedArraysPreserved(a: unknown, b: unknown): void {
  if (isUint8Array(a)) {
    expect(isUint8Array(b)).toBe(true);
    expect(Array.from(b as Uint8Array)).toEqual(Array.from(a));
  } else if (Array.isArray(a)) {
    expect(Array.isArray(b)).toBe(true);
    (a as unknown[]).forEach((item, i) =>
      assertTypedArraysPreserved(item, (b as unknown[])[i])
    );
  } else if (a !== null && typeof a === "object") {
    for (const key of Object.keys(a as object)) {
      assertTypedArraysPreserved(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      );
    }
  }
}

it.each(VALUES)(
  "should serialize and deserialize %s",
  async (_description, value) => {
    const serde = new JsonPlusSerializer();
    const [type, serialized] = await serde.dumpsTyped(value);
    const deserialized = await serde.loadsTyped(type, serialized);
    expect(deserialized).toEqual(value);
    assertTypedArraysPreserved(value, deserialized);
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
