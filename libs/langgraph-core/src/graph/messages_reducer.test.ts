import { describe, it, expect } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  RemoveMessage,
  BaseMessage,
} from "@langchain/core/messages";
import {
  messagesStateReducer,
  REMOVE_ALL_MESSAGES,
} from "./messages_reducer.js";

describe("messagesStateReducer", () => {
  it("should add a single message", () => {
    const left = [new HumanMessage({ id: "1", content: "Hello" })];
    const right = new AIMessage({ id: "2", content: "Hi there!" });
    const result = messagesStateReducer(left, right);
    const expected = [
      new HumanMessage({ id: "1", content: "Hello" }),
      new AIMessage({ id: "2", content: "Hi there!" }),
    ];
    expect(result).toEqual(expected);
  });

  it("should add multiple messages", () => {
    const left = [new HumanMessage({ id: "1", content: "Hello" })];
    const right = [
      new AIMessage({ id: "2", content: "Hi there!" }),
      new SystemMessage({ id: "3", content: "System message" }),
    ];
    const result = messagesStateReducer(left, right);
    const expected = [
      new HumanMessage({ id: "1", content: "Hello" }),
      new AIMessage({ id: "2", content: "Hi there!" }),
      new SystemMessage({ id: "3", content: "System message" }),
    ];
    expect(result).toEqual(expected);
  });

  it("should update existing message", () => {
    const left = [new HumanMessage({ id: "1", content: "Hello" })];
    const right = new HumanMessage({ id: "1", content: "Hello again" });
    const result = messagesStateReducer(left, right);
    const expected = [new HumanMessage({ id: "1", content: "Hello again" })];
    expect(result).toEqual(expected);
  });

  it("should assign missing IDs", () => {
    const left = [new HumanMessage({ content: "Hello" })];
    const right = [new AIMessage({ content: "Hi there!" })];
    const result = messagesStateReducer(left, right);
    expect(result).toHaveLength(2);
    expect(
      result.every((m) => typeof m.id === "string" && m.id.length > 0)
    ).toBe(true);
  });

  it("should handle duplicates in input", () => {
    const left: BaseMessage[] = [];
    const right = [
      new AIMessage({ id: "1", content: "Hi there!" }),
      new AIMessage({ id: "1", content: "Hi there again!" }),
    ];
    const result = messagesStateReducer(left, right);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
    expect(result[0].content).toBe("Hi there again!");
  });

  it("should handle duplicates with remove", () => {
    const left = [new AIMessage({ id: "1", content: "Hello!" })];
    const right = [
      new RemoveMessage({ id: "1" }),
      new AIMessage({ id: "1", content: "Hi there!" }),
      new AIMessage({ id: "1", content: "Hi there again!" }),
    ];
    const result = messagesStateReducer(left, right);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
    expect(result[0].content).toBe("Hi there again!");
  });

  it("should remove message", () => {
    const left = [
      new HumanMessage({ id: "1", content: "Hello" }),
      new AIMessage({ id: "2", content: "Hi there!" }),
    ];
    const right = new RemoveMessage({ id: "2" });
    const result = messagesStateReducer(left, right);
    const expected = [new HumanMessage({ id: "1", content: "Hello" })];
    expect(result).toEqual(expected);
  });

  it("should handle duplicate remove messages", () => {
    const left = [
      new HumanMessage({ id: "1", content: "Hello" }),
      new AIMessage({ id: "2", content: "Hi there!" }),
    ];
    const right = [
      new RemoveMessage({ id: "2" }),
      new RemoveMessage({ id: "2" }),
    ];
    const result = messagesStateReducer(left, right);
    const expected = [new HumanMessage({ id: "1", content: "Hello" })];
    expect(result).toEqual(expected);
  });

  it("should throw on removing nonexistent message", () => {
    const left = [new HumanMessage({ id: "1", content: "Hello" })];
    const right = new RemoveMessage({ id: "2" });
    expect(() => messagesStateReducer(left, right)).toThrow(
      "Attempting to delete a message with an ID that doesn't exist"
    );
  });

  it("should handle mixed operations", () => {
    const left = [
      new HumanMessage({ id: "1", content: "Hello" }),
      new AIMessage({ id: "2", content: "Hi there!" }),
    ];
    const right = [
      new HumanMessage({ id: "1", content: "Updated hello" }),
      new RemoveMessage({ id: "2" }),
      new SystemMessage({ id: "3", content: "New message" }),
    ];
    const result = messagesStateReducer(left, right);
    const expected = [
      new HumanMessage({ id: "1", content: "Updated hello" }),
      new SystemMessage({ id: "3", content: "New message" }),
    ];
    expect(result).toEqual(expected);
  });

  it("should handle empty inputs", () => {
    expect(messagesStateReducer([], [])).toEqual([]);
    expect(
      messagesStateReducer(
        [],
        [new HumanMessage({ id: "1", content: "Hello" })]
      )
    ).toEqual([new HumanMessage({ id: "1", content: "Hello" })]);
    expect(
      messagesStateReducer(
        [new HumanMessage({ id: "1", content: "Hello" })],
        []
      )
    ).toEqual([new HumanMessage({ id: "1", content: "Hello" })]);
  });

  it("should handle non-array inputs", () => {
    const left = new HumanMessage({ id: "1", content: "Hello" });
    const right = new AIMessage({ id: "2", content: "Hi there!" });
    const result = messagesStateReducer(left, right);
    const expected = [
      new HumanMessage({ id: "1", content: "Hello" }),
      new AIMessage({ id: "2", content: "Hi there!" }),
    ];
    expect(result).toEqual(expected);
  });

  it("should remove all messages", () => {
    // simple removal
    expect(
      messagesStateReducer(
        [new HumanMessage("Hello"), new AIMessage("Hi there!")],
        [new RemoveMessage({ id: REMOVE_ALL_MESSAGES })]
      )
    ).toEqual([]);

    // removal and update (i.e. overwriting)
    expect(
      messagesStateReducer(
        [new HumanMessage("Hello"), new AIMessage("Hi there!")],
        [
          new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
          new HumanMessage({ id: "1", content: "Updated hello" }),
        ]
      )
    ).toEqual([new HumanMessage({ id: "1", content: "Updated hello" })]);

    // test removing preceding messages in the right list
    expect(
      messagesStateReducer(
        [new HumanMessage("Hello"), new AIMessage("Hi there!")],
        [
          new HumanMessage("Updated hello"),
          new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
          new HumanMessage({ id: "1", content: "Updated hi there" }),
        ]
      )
    ).toEqual([new HumanMessage({ id: "1", content: "Updated hi there" })]);
  });
});
