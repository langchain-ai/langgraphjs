import { describe, it, expect } from "vitest";
import { deserialize, serialize } from "../src/storage/persist.mjs";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

describe("persist", () => {
  it("basic", async () => {
    const data = { a: 1, b: "test" };
    const serialized = serialize(data);
    const deserialized = await deserialize(serialized);
    expect(deserialized).toEqual(data);
  });

  it("langchain messages", async () => {
    const data = [new HumanMessage("hello"), new AIMessage("world")];
    const serialized = serialize(data);
    const deserialized = await deserialize<typeof data>(serialized);

    expect(deserialized).toHaveLength(2);
    expect(deserialized[0]).toHaveProperty("lc_id");
    expect(deserialized[1]).toHaveProperty("lc_id");
    expect(deserialized).toMatchObject(data);
  });

  it("uint8array", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const serialized = serialize(data);
    const deserialized = await deserialize<typeof data>(serialized);

    expect(deserialized).toBeInstanceOf(Uint8Array);
    expect(deserialized).toEqual(data);
  });
});
