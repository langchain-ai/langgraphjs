import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { prepareOptimisticInput } from "./optimistic-input.js";

let counter = 0;
const mint = () => `minted-${(counter += 1)}`;

describe("prepareOptimisticInput", () => {
  it("mints ids for id-less message objects and echoes them", () => {
    counter = 0;
    const result = prepareOptimisticInput(
      { messages: [{ type: "human", content: "hi" }] },
      "messages",
      mint
    );

    expect(result.echoedIds).toEqual(["minted-1"]);
    expect(result.optimisticMessages).toHaveLength(1);
    expect(result.optimisticMessages[0].id).toBe("minted-1");
    // Dispatch payload normalized to an array carrying the minted id.
    const dispatched = result.dispatchInput.messages as Array<{ id: string }>;
    expect(dispatched[0].id).toBe("minted-1");
  });

  it("preserves an existing message id (no mint)", () => {
    const result = prepareOptimisticInput(
      { messages: [{ type: "human", content: "hi", id: "keep-me" }] },
      "messages",
      mint
    );
    expect(result.echoedIds).toEqual(["keep-me"]);
    expect(result.optimisticMessages[0].id).toBe("keep-me");
  });

  it("normalizes a bare string into a human message", () => {
    counter = 0;
    const result = prepareOptimisticInput(
      { messages: "hello" },
      "messages",
      mint
    );
    expect(result.optimisticMessages).toHaveLength(1);
    expect(result.optimisticMessages[0].getType()).toBe("human");
    expect(result.optimisticMessages[0].content).toBe("hello");
    expect(result.echoedIds).toEqual(["minted-1"]);
  });

  it("does not mutate the caller's BaseMessage instances", () => {
    const original = new HumanMessage("hi");
    expect(original.id).toBeUndefined();
    const result = prepareOptimisticInput(
      { messages: [original] },
      "messages",
      mint
    );
    // Caller's instance is untouched; a fresh instance carries the id.
    expect(original.id).toBeUndefined();
    expect(result.optimisticMessages[0].id).toBeTruthy();
  });

  it("separates non-message keys into extraValues", () => {
    const result = prepareOptimisticInput(
      { messages: [new AIMessage({ content: "x", id: "a" })], cursor: "c1" },
      "messages",
      mint
    );
    expect(result.extraValues).toEqual({ cursor: "c1" });
    expect(result.dispatchInput.cursor).toBe("c1");
  });

  it("echoes nothing when input has no messages key", () => {
    const result = prepareOptimisticInput(
      { cursor: "c1" },
      "messages",
      mint
    );
    expect(result.echoedIds).toEqual([]);
    expect(result.optimisticMessages).toEqual([]);
    expect(result.extraValues).toEqual({ cursor: "c1" });
  });

  it("respects a custom messagesKey", () => {
    counter = 0;
    const result = prepareOptimisticInput(
      { chat: [{ type: "human", content: "hi" }] },
      "chat",
      mint
    );
    expect(result.echoedIds).toEqual(["minted-1"]);
    expect((result.dispatchInput.chat as unknown[]).length).toBe(1);
  });
});
