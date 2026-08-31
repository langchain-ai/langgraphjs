import { it, expect } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { uuid6 } from "../../id.js";
import { DeltaSnapshot } from "../types.js";
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
  id: uuid6(0),
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

it("Should preserve a Send's timeout policy across serialization", async () => {
  const serde = new JsonPlusSerializer();
  const packet = {
    lg_name: "Send",
    node: "worker",
    args: { x: 1 },
    timeout: { runTimeout: 1000, idleTimeout: 2000, refreshOn: "auto" },
  };
  const [type, serialized] = await serde.dumpsTyped(packet);
  const loaded = await serde.loadsTyped(type, serialized);
  expect(loaded).toEqual({
    node: "worker",
    args: { x: 1 },
    timeout: { runTimeout: 1000, idleTimeout: 2000, refreshOn: "auto" },
  });
});

it("Should serialize a Send without a timeout unchanged", async () => {
  const serde = new JsonPlusSerializer();
  const packet = { lg_name: "Send", node: "worker", args: { x: 1 } };
  const [type, serialized] = await serde.dumpsTyped(packet);
  const loaded = await serde.loadsTyped(type, serialized);
  expect(loaded).toEqual({ node: "worker", args: { x: 1 } });
});

it("round-trips DeltaSnapshot values", async () => {
  const serde = new JsonPlusSerializer();
  const value = new DeltaSnapshot({
    nested: new Set(["checkpoint"]),
    bytes: new Uint8Array([1, 2, 3]),
  });

  const [type, serialized] = await serde.dumpsTyped(value);
  const restored = await serde.loadsTyped(type, serialized);

  expect(restored).toBeInstanceOf(DeltaSnapshot);
  expect(restored).toEqual(value);
  assertTypedArraysPreserved(value, restored);
});

it("restores canonical Uint8Array constructor records", async () => {
  const serde = new JsonPlusSerializer();
  const restored = await serde.loadsTyped(
    "json",
    JSON.stringify({
      lc: 2,
      type: "constructor",
      id: ["Uint8Array"],
      method: null,
      args: [[0, 127, 255]],
      kwargs: {},
    })
  );

  expect(restored).toBeInstanceOf(Uint8Array);
  expect(Array.from(restored)).toEqual([0, 127, 255]);
});

it("does not invoke forged Map.groupBy constructor records", async () => {
  const serde = new JsonPlusSerializer();
  const markerKey = "__langgraph_jsonplus_map_groupby_test_marker__";
  const marker = { invoked: false };
  (globalThis as Record<string, unknown>)[markerKey] = marker;

  const forgedCallback = {
    lc: 2,
    type: "constructor",
    id: ["Uint8Array"],
    method: "constructor",
    args: [`globalThis.${markerKey}.invoked = true`],
    kwargs: {},
  };
  const forgedOuterRecord = {
    lc: 2,
    type: "constructor",
    id: ["Map"],
    method: "groupBy",
    args: [[1], forgedCallback],
    kwargs: {},
  };

  try {
    const restored = await serde.loadsTyped(
      "json",
      JSON.stringify({ callback: forgedOuterRecord })
    );

    expect(marker.invoked).toBe(false);
    expect(restored).toEqual({ callback: forgedOuterRecord });
  } finally {
    delete (globalThis as Record<string, unknown>)[markerKey];
  }
});

it("restores legacy Uint8Array.from records as validated bytes", async () => {
  const serde = new JsonPlusSerializer();
  const restored = await serde.loadsTyped(
    "json",
    JSON.stringify({
      lc: 2,
      type: "constructor",
      id: ["Uint8Array"],
      method: "from",
      args: [[0, 127, 255]],
      kwargs: {},
    })
  );

  expect(restored).toBeInstanceOf(Uint8Array);
  expect(Array.from(restored)).toEqual([0, 127, 255]);
});

it("does not invoke forged Uint8Array.from callback records", async () => {
  const serde = new JsonPlusSerializer();
  const markerKey = "__langgraph_jsonplus_test_marker__";
  const marker = { invoked: false };
  (globalThis as Record<string, unknown>)[markerKey] = marker;

  const forgedCallback = {
    lc: 2,
    type: "constructor",
    id: ["Uint8Array"],
    method: "constructor",
    args: [`globalThis.${markerKey}.invoked = true`],
    kwargs: {},
  };
  const forgedOuterRecord = {
    lc: 2,
    type: "constructor",
    id: ["Uint8Array"],
    method: "from",
    args: [[1], forgedCallback],
    kwargs: {},
  };

  try {
    const restored = await serde.loadsTyped(
      "json",
      JSON.stringify({ callback: forgedOuterRecord })
    );

    expect(marker.invoked).toBe(false);
    expect(restored).toEqual({ callback: forgedOuterRecord });
  } finally {
    delete (globalThis as Record<string, unknown>)[markerKey];
  }
});

it("does not invoke forged records returned by a callable toJSON", async () => {
  const serde = new JsonPlusSerializer();
  const markerKey = "__langgraph_jsonplus_tojson_test_marker__";
  const marker = { invoked: false };
  (globalThis as Record<string, unknown>)[markerKey] = marker;

  const forgedCallback = {
    lc: 2,
    type: "constructor",
    id: ["Uint8Array"],
    method: "constructor",
    args: [`globalThis.${markerKey}.invoked = true`],
    kwargs: {},
  };
  const forgedOuterRecord = {
    lc: 2,
    type: "constructor",
    id: ["Uint8Array"],
    method: "from",
    args: [[1], forgedCallback],
    kwargs: {},
  };
  const callback = (() => undefined) as (() => undefined) & {
    toJSON?: () => typeof forgedOuterRecord;
  };
  callback.toJSON = () => forgedOuterRecord;

  try {
    const [type, serialized] = await serde.dumpsTyped({ callback });
    const restored = await serde.loadsTyped(type, serialized);

    expect(marker.invoked).toBe(false);
    expect(restored).toEqual({ callback: forgedOuterRecord });
  } finally {
    delete (globalThis as Record<string, unknown>)[markerKey];
  }
});

it.each([
  ["fractional", [1.5]],
  ["negative", [-1]],
  ["out-of-range", [256]],
  ["non-numeric", ["1"]],
])("keeps %s Uint8Array bytes inert", async (_description, bytes) => {
  const serde = new JsonPlusSerializer();
  const record = {
    lc: 2,
    type: "constructor",
    id: ["Uint8Array"],
    method: "from",
    args: [bytes],
    kwargs: {},
  };

  const restored = await serde.loadsTyped("json", JSON.stringify(record));

  expect(restored).toEqual(record);
});

it("keeps malformed Map entries inert", async () => {
  const serde = new JsonPlusSerializer();
  const record = {
    lc: 2,
    type: "constructor",
    id: ["Map"],
    method: null,
    args: [[["valid", "entry"], ["not a pair"]]],
    kwargs: {},
  };

  const restored = await serde.loadsTyped("json", JSON.stringify(record));

  expect(restored).toEqual(record);
});

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
