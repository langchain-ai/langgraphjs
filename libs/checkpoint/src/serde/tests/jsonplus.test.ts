import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Serializable } from "@langchain/core/load/serializable";
import { uuid6 } from "../../id.js";
import { JsonPlusSerializer } from "../jsonplus.js";
import { emptyCheckpoint } from "../../base.js";
import { MemorySaver } from "../../memory.js";

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

/**
 * Stands in for a class that lives outside `@langchain/core` — e.g.
 * `ChatOpenAI`, whose namespace is `langchain`, not `langchain_core`.
 * Declared here so the test does not depend on a provider package.
 */
class FakeChatModel extends Serializable {
  lc_namespace = ["langchain", "chat_models", "fake"];

  lc_serializable = true;

  modelName: string;

  constructor(fields: { modelName: string }) {
    super(fields);
    this.modelName = fields.modelName;
  }
}

/** A class carrying a secret, mirroring how providers serialize credentials. */
class FakeChatModelWithSecret extends Serializable {
  lc_namespace = ["langchain", "chat_models", "fake"];

  lc_serializable = true;

  get lc_secrets(): { [key: string]: string } {
    return { apiKey: "FAKE_API_KEY" };
  }

  apiKey: string;

  constructor(fields: { apiKey: string }) {
    super(fields);
    this.apiKey = fields.apiKey;
  }
}

const fakeChatModelsModule = { FakeChatModel, FakeChatModelWithSecret };

describe("Non-core LangChain classes", () => {
  it("Should throw without an explicit opt-in", async () => {
    const serde = new JsonPlusSerializer();
    const [type, serialized] = await serde.dumpsTyped({
      model: new FakeChatModel({ modelName: "gpt-4o" }),
    });
    await expect(serde.loadsTyped(type, serialized)).rejects.toThrow(
      /Invalid namespace/
    );
  });

  it("Should revive a class provided via importMap", async () => {
    const serde = new JsonPlusSerializer({
      importMap: { chat_models__fake: fakeChatModelsModule },
    });
    const [type, serialized] = await serde.dumpsTyped({
      model: new FakeChatModel({ modelName: "gpt-4o" }),
    });
    const loaded = await serde.loadsTyped(type, serialized);
    expect(loaded.model).toBeInstanceOf(FakeChatModel);
    expect(loaded.model.modelName).toBe("gpt-4o");
  });

  it("Should revive classes nested in arrays, maps and sets", async () => {
    const serde = new JsonPlusSerializer({
      importMap: { chat_models__fake: fakeChatModelsModule },
    });
    const value = {
      list: [new FakeChatModel({ modelName: "a" })],
      map: new Map([["key", new FakeChatModel({ modelName: "b" })]]),
      deep: { nested: { model: new FakeChatModel({ modelName: "c" }) } },
    };
    const [type, serialized] = await serde.dumpsTyped(value);
    const loaded = await serde.loadsTyped(type, serialized);
    expect(loaded.list[0]).toBeInstanceOf(FakeChatModel);
    expect(loaded.map.get("key")).toBeInstanceOf(FakeChatModel);
    expect(loaded.deep.nested.model).toBeInstanceOf(FakeChatModel);
    expect(loaded.deep.nested.model.modelName).toBe("c");
  });

  it("Should resolve secrets via secretsMap", async () => {
    const serde = new JsonPlusSerializer({
      importMap: { chat_models__fake: fakeChatModelsModule },
      secretsMap: { FAKE_API_KEY: "sk-test" },
    });
    const [type, serialized] = await serde.dumpsTyped({
      model: new FakeChatModelWithSecret({ apiKey: "sk-test" }),
    });
    expect(new TextDecoder().decode(serialized)).not.toContain("sk-test");
    const loaded = await serde.loadsTyped(type, serialized);
    expect(loaded.model).toBeInstanceOf(FakeChatModelWithSecret);
    expect(loaded.model.apiKey).toBe("sk-test");
  });

  it("Should still revive langchain_core classes without any options", async () => {
    const serde = new JsonPlusSerializer();
    const [type, serialized] = await serde.dumpsTyped({
      message: new AIMessage("hello"),
    });
    const loaded = await serde.loadsTyped(type, serialized);
    expect(loaded.message).toBeInstanceOf(AIMessage);
  });

  it("Should round-trip through a checkpointer given a configured serde", async () => {
    const checkpointer = new MemorySaver(
      new JsonPlusSerializer({
        importMap: { chat_models__fake: fakeChatModelsModule },
      })
    );
    const config = { configurable: { thread_id: "1" } };
    const checkpoint = {
      ...emptyCheckpoint(),
      channel_values: { model: new FakeChatModel({ modelName: "gpt-4o" }) },
    };

    const nextConfig = await checkpointer.put(config, checkpoint, {
      source: "update",
      step: 1,
      parents: {},
    });
    const tuple = await checkpointer.getTuple(nextConfig);

    expect(tuple?.checkpoint.channel_values.model).toBeInstanceOf(
      FakeChatModel
    );
  });
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
