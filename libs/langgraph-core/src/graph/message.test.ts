import { describe, it, expect } from "vitest";
import {
  AIMessage,
  HumanMessage,
  BaseMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import { pushMessage } from "./message.js";
import { REMOVE_ALL_MESSAGES } from "./messages_reducer.js";
import { START } from "../constants.js";
import { StateGraph } from "../graph/state.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";

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
    pushMessage(message, { ...config, stateKey: "custom" });
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

  it("should push messages onto the streamEvents v3 messages channel", async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("chat", (state, config) => {
        pushMessage(new AIMessage({ id: "1", content: "First" }), config);
        return state;
      })
      .addEdge(START, "chat")
      .compile();

    const stream = await graph.streamEvents(
      { messages: [] },
      { version: "v3" }
    );

    const messageEvents: { event?: string; id?: string }[] = [];
    for await (const event of stream) {
      if (event.method === "messages") {
        messageEvents.push(event.params.data as { event?: string; id?: string });
      }
    }

    expect(
      messageEvents.some((e) => e.event === "message-start" && e.id === "1")
    ).toBe(true);
    expect(messageEvents.some((e) => e.event === "message-finish")).toBe(true);
  });
});

describe("streamEvents v3 run.messages", () => {
  it("does not include non-AI messages written by nodes", async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("summarize", () => ({
        messages: [
          new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
          new HumanMessage({ id: "summary-1", content: "summary" }),
        ],
      }))
      .addNode("answer", () => ({
        messages: [new AIMessage({ id: "answer-1", content: "answer" })],
      }))
      .addEdge(START, "summarize")
      .addEdge("summarize", "answer")
      .compile();

    const run = await graph.streamEvents(
      { messages: [new HumanMessage("hi")] },
      { version: "v3" }
    );

    const seen: { node?: string; text: string }[] = [];
    for await (const message of run.messages) {
      seen.push({ node: message.node, text: await message.text });
    }

    expect(seen).toEqual([{ node: "answer", text: "answer" }]);
  });
});
