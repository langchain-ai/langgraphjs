import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import {
  buildMessageIndex,
  reconcileMessagesFromValues,
  shouldPreferValuesMessageForToolCalls,
} from "./message-reconciliation.js";

describe("reconcileMessagesFromValues", () => {
  it("keeps values authoritative for order while preserving streamed content", () => {
    const streamedAssistant = new AIMessage({
      id: "assistant-1",
      content: "streamed partial",
    });
    const valueHuman = new HumanMessage({
      id: "human-1",
      content: "hello",
    });
    const valueAssistant = new AIMessage({
      id: "assistant-1",
      content: "values final",
    });

    const result = reconcileMessagesFromValues({
      valueMessages: [valueHuman, valueAssistant],
      currentMessages: [streamedAssistant],
      currentIndexById: buildMessageIndex([streamedAssistant]),
      previousValueMessageIds: new Set(),
      streamedMessageIds: new Set(["assistant-1"]),
    });

    expect(result.messages).toEqual([valueHuman, streamedAssistant]);
    expect(result.valueMessageIds).toEqual(new Set(["human-1", "assistant-1"]));
  });

  it("preserves stream-only messages that have not appeared in values yet", () => {
    const committed = new HumanMessage({ id: "human-1", content: "hello" });
    const streamedAssistant = new AIMessage({
      id: "assistant-1",
      content: "still streaming",
    });

    const result = reconcileMessagesFromValues({
      valueMessages: [committed],
      currentMessages: [committed, streamedAssistant],
      currentIndexById: buildMessageIndex([committed, streamedAssistant]),
      previousValueMessageIds: new Set(["human-1"]),
      streamedMessageIds: new Set(["assistant-1"]),
    });

    expect(result.messages).toEqual([committed, streamedAssistant]);
  });

  it("drops messages removed from a later values snapshot", () => {
    const retained = new HumanMessage({ id: "human-1", content: "hello" });
    const removed = new AIMessage({ id: "assistant-1", content: "remove me" });
    const streaming = new AIMessage({
      id: "assistant-2",
      content: "not committed yet",
    });

    const result = reconcileMessagesFromValues({
      valueMessages: [retained],
      currentMessages: [retained, removed, streaming],
      currentIndexById: buildMessageIndex([retained, removed, streaming]),
      previousValueMessageIds: new Set(["human-1", "assistant-1"]),
      streamedMessageIds: new Set(["assistant-2"]),
    });

    expect(result.messages).toEqual([retained, streaming]);
  });

  it("does not preserve unkeyed stream-only messages", () => {
    const unkeyedValue = new HumanMessage({ content: "value only" });
    const unkeyedStream = new AIMessage({ content: "stream only" });

    const result = reconcileMessagesFromValues({
      valueMessages: [unkeyedValue],
      currentMessages: [unkeyedStream],
      currentIndexById: buildMessageIndex([unkeyedStream]),
      previousValueMessageIds: new Set(),
      streamedMessageIds: new Set(),
    });

    expect(result.messages).toEqual([unkeyedValue]);
    expect(result.valueMessageIds).toEqual(new Set());
  });

  it("can prefer values messages when they contain finalized tool calls", () => {
    const streamed = new AIMessage({
      id: "assistant-1",
      content: "",
    });
    const values = new AIMessage({
      id: "assistant-1",
      content: "",
      tool_calls: [{ id: "tool-1", name: "search", args: {} }],
    });

    const result = reconcileMessagesFromValues({
      valueMessages: [values],
      currentMessages: [streamed],
      currentIndexById: buildMessageIndex([streamed]),
      previousValueMessageIds: new Set(),
      preferValuesMessage: shouldPreferValuesMessageForToolCalls,
    });

    expect(result.messages).toEqual([values]);
  });

  it("keeps the current array identity when reconciliation is unchanged", () => {
    const current = [new HumanMessage({ id: "human-1", content: "hello" })];

    const result = reconcileMessagesFromValues({
      valueMessages: [new HumanMessage({ id: "human-1", content: "hello" })],
      currentMessages: current,
      currentIndexById: buildMessageIndex(current),
      previousValueMessageIds: new Set(["human-1"]),
    });

    expect(result.messages).toBe(current);
  });
});
