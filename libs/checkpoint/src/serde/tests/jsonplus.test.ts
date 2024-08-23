import { it, expect } from "@jest/globals";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { uuid6 } from "../../id.js";
import { JsonPlusSerializer } from "../jsonplus.js";

const value = {
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
  array: [
    new Error("nestedfoo"),
    5,
    true,
    false,
    {
      a: "b",
      set: new Set([4, 3, 2, 1]),
    },
  ],
  object: {
    messages: [new HumanMessage("hey there"), new AIMessage("hi how are you")],
  },
};

it("should serialize and deserialize various data types", async () => {
  const serde = new JsonPlusSerializer();
  const [type, serialized] = serde.dumpsTyped(value);
  const deserialized = await serde.loadsTyped(type, serialized);
  expect(deserialized).toEqual(value);
});
