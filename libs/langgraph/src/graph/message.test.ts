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
  pushMessage,
  REMOVE_ALL_MESSAGES,
} from "./message.js";
import { START } from "../constants.js";
import { StateGraph } from "../graph/state.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";

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

describe("pushMessage", () => {
  it("should throw on message without ID", () => {
    const message = new AIMessage("No ID");
    const config = { callbacks: [] };
    expect(() => pushMessage(message, config)).toThrow(
      "Message ID is required"
    );
  });

  it("should handle message with ID", () => {
    const message = new AIMessage({ id: "1", content: "With ID" });
    const config = { callbacks: [] };
    const result = pushMessage(message, config);
    expect(result).toEqual(message);
  });

  it("should handle message with custom state key", () => {
    const message = new AIMessage({ id: "1", content: "With ID" });
    const config = {
      callbacks: [],
      configurable: {
        __pregel_send: (messages: [string, BaseMessage][]) => {
          expect(messages).toEqual([["custom", message]]);
        },
      },
    };
    pushMessage(message, config, { stateKey: "custom" });
  });

  it("should push messages in graph", async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("chat", (state, config) => {
        expect(() => pushMessage(new AIMessage("No ID"), config)).toThrow();

        pushMessage(new AIMessage({ id: "1", content: "First" }), config);
        pushMessage(new HumanMessage({ id: "2", content: "Second" }), config);
        pushMessage(new AIMessage({ id: "3", content: "Third" }), config);

        return state;
      })
      .addEdge(START, "chat")
      .compile();

    const messages: BaseMessage[] = [];
    let values: BaseMessage[] | undefined;

    for await (const [event, chunk] of await graph.stream(
      { messages: [] },
      { streamMode: ["messages", "values"] }
    )) {
      if (event === "values") {
        values = chunk.messages;
      } else if (event === "messages") {
        const [message] = chunk;
        messages.push(message);
      }
    }

    expect(values).toEqual(messages);
  });
});
