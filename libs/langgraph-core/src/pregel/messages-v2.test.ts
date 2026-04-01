import { describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { LLMResult } from "@langchain/core/outputs";
import { Serialized } from "@langchain/core/load/serializable";
import { ChainValues } from "@langchain/core/utils/types";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { StreamProtocolMessagesHandler } from "./messages-v2.js";

describe("StreamProtocolMessagesHandler", () => {
  it("forwards Core stream events with run metadata", () => {
    const streamFn = vi.fn();
    const handler = new StreamProtocolMessagesHandler(streamFn);
    const runId = "run-123";

    handler.handleChatModelStart(
      {} as Serialized,
      [],
      runId,
      undefined,
      {},
      [],
      {
        langgraph_checkpoint_ns: "ns1|ns2",
        langgraph_node: "node-a",
      },
      "ModelName"
    );

    const event: ChatModelStreamEvent = {
      event: "message-start",
      id: "msg-123",
    };
    handler.handleChatModelStreamEvent(event, runId);

    expect(streamFn).toHaveBeenCalledWith([
      ["ns1", "ns2"],
      "messages",
      [
        { event: "message-start", id: "msg-123" },
        {
          langgraph_checkpoint_ns: "ns1|ns2",
          langgraph_node: "node-a",
          name: "ModelName",
          run_id: runId,
          tags: [],
        },
      ],
    ]);
  });

  it("forwards Core delta events", () => {
    const streamFn = vi.fn();
    const handler = new StreamProtocolMessagesHandler(streamFn);
    const runId = "run-123";

    handler.handleChatModelStart(
      {} as Serialized,
      [],
      runId,
      undefined,
      {},
      [],
      {
        langgraph_checkpoint_ns: "ns1|ns2",
        langgraph_node: "node-a",
      },
      "ModelName"
    );

    handler.handleChatModelStreamEvent(
      { event: "message-start", id: "msg-123" },
      runId
    );
    handler.handleChatModelStreamEvent(
      {
        event: "content-block-start",
        index: 0,
        content: { type: "text", text: "" },
      },
      runId
    );
    handler.handleChatModelStreamEvent(
      {
        event: "content-block-delta",
        index: 0,
        delta: { type: "text-delta", text: "Hello" },
      },
      runId
    );

    expect(streamFn.mock.calls.map((call) => call[0][2][0])).toEqual([
      { event: "message-start", id: "msg-123" },
      {
        event: "content-block-start",
        index: 0,
        content: { type: "text", text: "" },
      },
      {
        event: "content-block-delta",
        index: 0,
        delta: { type: "text-delta", text: "Hello" },
      },
    ]);
  });

  it("forwards Core tool call deltas", () => {
    const streamFn = vi.fn();
    const handler = new StreamProtocolMessagesHandler(streamFn);
    const runId = "run-123";

    handler.handleChatModelStart(
      {} as Serialized,
      [],
      runId,
      undefined,
      {},
      [],
      { langgraph_checkpoint_ns: "ns1" },
      "ModelName"
    );

    handler.handleChatModelStreamEvent(
      { event: "message-start", id: "msg-123" },
      runId
    );
    handler.handleChatModelStreamEvent(
      {
        event: "content-block-start",
        index: 0,
        content: {
          type: "tool_call_chunk",
          id: "call-1",
          name: "search",
          args: "",
        },
      } as ChatModelStreamEvent,
      runId
    );
    handler.handleChatModelStreamEvent(
      {
        event: "content-block-delta",
        index: 0,
        delta: {
          type: "block-delta",
          fields: {
            type: "tool_call_chunk",
            id: "call-1",
            name: "search",
            args: '{"q"',
          },
        },
      },
      runId
    );
    handler.handleChatModelStreamEvent(
      {
        event: "content-block-delta",
        index: 0,
        delta: {
          type: "block-delta",
          fields: {
            type: "tool_call_chunk",
            id: "call-1",
            name: "search",
            args: '{"q":"hi"}',
          },
        },
      },
      runId
    );

    expect(streamFn.mock.calls.map((call) => call[0][2][0])).toEqual([
      { event: "message-start", id: "msg-123" },
      {
        event: "content-block-start",
        index: 0,
        content: {
          type: "tool_call_chunk",
          id: "call-1",
          name: "search",
          args: "",
        },
      },
      {
        event: "content-block-delta",
        index: 0,
        delta: {
          type: "block-delta",
          fields: {
            type: "tool_call_chunk",
            id: "call-1",
            name: "search",
            args: '{"q"',
          },
        },
      },
      {
        event: "content-block-delta",
        index: 0,
        delta: {
          type: "block-delta",
          fields: {
            type: "tool_call_chunk",
            id: "call-1",
            name: "search",
            args: '{"q":"hi"}',
          },
        },
      },
    ]);
  });

  it("does not emit final LLM messages after streamed events", () => {
    const streamFn = vi.fn();
    const handler = new StreamProtocolMessagesHandler(streamFn);
    const runId = "run-123";

    handler.handleChatModelStart(
      {} as Serialized,
      [],
      runId,
      undefined,
      {},
      [],
      { langgraph_checkpoint_ns: "ns1" },
      "ModelName"
    );

    handler.handleChatModelStreamEvent(
      { event: "message-start", id: "msg-123" },
      runId
    );
    handler.handleLLMEnd(
      {
        generations: [
          [
            {
              text: "Hello",
              message: new AIMessage({ id: "msg-123", content: "Hello" }),
            },
          ],
        ],
      } as unknown as LLMResult,
      runId
    );

    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it("emits protocol lifecycle events for non-streaming chain outputs", () => {
    const streamFn = vi.fn();
    const handler = new StreamProtocolMessagesHandler(streamFn);
    const runId = "chain-123";

    handler.handleChainStart(
      {} as Serialized,
      {} as ChainValues,
      runId,
      undefined,
      [],
      {
        langgraph_checkpoint_ns: "ns1",
        langgraph_node: "NodeName",
      },
      undefined,
      "NodeName"
    );

    handler.handleChainEnd(
      new AIMessage({
        id: "msg-456",
        content: "Done",
        response_metadata: { stop_reason: "tool_use" },
      }),
      runId
    );

    expect(streamFn.mock.calls.map((call) => call[0][2][0])).toEqual([
      { event: "message-start", id: "msg-456" },
      {
        event: "content-block-start",
        index: 0,
        content: { type: "text", text: "" },
      },
      {
        event: "content-block-delta",
        index: 0,
        delta: { type: "text-delta", text: "Done" },
      },
      {
        event: "content-block-finish",
        index: 0,
        content: { type: "text", text: "Done" },
      },
      {
        event: "message-finish",
        responseMetadata: { stop_reason: "tool_use" },
      },
    ]);
  });
});
