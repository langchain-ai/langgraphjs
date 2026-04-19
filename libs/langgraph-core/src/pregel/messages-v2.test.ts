import { describe, expect, it, vi } from "vitest";
import {
  AIMessage,
  AIMessageChunk,
} from "@langchain/core/messages";
import { ChatGenerationChunk, LLMResult } from "@langchain/core/outputs";
import { Serialized } from "@langchain/core/load/serializable";
import { ChainValues } from "@langchain/core/utils/types";
import { NewTokenIndices } from "@langchain/core/callbacks/base";
import { StreamProtocolMessagesHandler } from "./messages-v2.js";

describe("StreamProtocolMessagesHandler", () => {
  it("emits protocol lifecycle events for streamed text", () => {
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
        __protocol_messages_stream: true,
      },
      "ModelName"
    );

    const chunk = new ChatGenerationChunk({
      message: new AIMessageChunk({
        id: "msg-123",
        content: "Hello",
      }),
      text: "Hello",
    });

    handler.handleLLMNewToken(
      "Hello",
      { prompt: 0, completion: 0 } as NewTokenIndices,
      runId,
      undefined,
      undefined,
      { chunk }
    );

    handler.handleLLMEnd(
      {
        generations: [
          [
            {
              text: "Hello",
              message: new AIMessage({
                id: "msg-123",
                content: "Hello",
                response_metadata: { stop_reason: "end_turn" },
              }),
            },
          ],
        ],
      } as unknown as LLMResult,
      runId
    );

    expect(streamFn.mock.calls.map((call) => call[0])).toEqual([
      [
        ["ns1", "ns2"],
        "messages",
        {
          event: "message-start",
          message_id: "msg-123",
          role: "ai",
        },
      ],
      [
        ["ns1", "ns2"],
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      ],
      [
        ["ns1", "ns2"],
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content_block: { type: "text", text: "Hello" },
        },
      ],
      [
        ["ns1", "ns2"],
        "messages",
        {
          event: "content-block-finish",
          index: 0,
          content_block: { type: "text", text: "Hello" },
        },
      ],
      [
        ["ns1", "ns2"],
        "messages",
        {
          event: "message-finish",
          reason: "stop",
          metadata: { stop_reason: "end_turn" },
        },
      ],
    ]);
  });

  it("emits protocol lifecycle events for chain outputs", () => {
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
        __protocol_messages_stream: true,
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

    expect(streamFn.mock.calls.map((call) => call[0])).toEqual([
      [
        ["ns1"],
        "messages",
        {
          event: "message-start",
          message_id: "msg-456",
          role: "ai",
        },
      ],
      [
        ["ns1"],
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      ],
      [
        ["ns1"],
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content_block: { type: "text", text: "Done" },
        },
      ],
      [
        ["ns1"],
        "messages",
        {
          event: "content-block-finish",
          index: 0,
          content_block: { type: "text", text: "Done", index: 0 },
        },
      ],
      [
        ["ns1"],
        "messages",
        {
          event: "message-finish",
          reason: "tool_use",
          metadata: { stop_reason: "tool_use" },
        },
      ],
    ]);
  });

  it("lifts additional_kwargs.audio into an audio content block", () => {
    const streamFn = vi.fn();
    const handler = new StreamProtocolMessagesHandler(streamFn);
    const runId = "audio-run";

    handler.handleChatModelStart(
      {} as Serialized,
      [],
      runId,
      undefined,
      {},
      [],
      {
        langgraph_checkpoint_ns: "ns-audio",
        __protocol_messages_stream: true,
      },
      "ModelName"
    );

    handler.handleLLMEnd(
      {
        generations: [
          [
            {
              text: "",
              message: new AIMessage({
                id: "msg-audio",
                content: "",
                additional_kwargs: {
                  audio: {
                    id: "audio_abc",
                    data: "AAAA",
                    format: "wav",
                    transcript: "hello",
                  },
                },
                response_metadata: { stop_reason: "stop" },
              }),
            },
          ],
        ],
      } as unknown as LLMResult,
      runId
    );

    const events = streamFn.mock.calls.map((call) => call[0][2]);
    expect(events).toEqual([
      { event: "message-start", message_id: "msg-audio", role: "ai" },
      {
        event: "content-block-start",
        index: 0,
        content_block: {
          type: "audio",
          id: "audio_abc",
          data: "AAAA",
          mime_type: "audio/wav",
          transcript: "hello",
        },
      },
      {
        event: "content-block-delta",
        index: 0,
        content_block: {
          type: "audio",
          id: "audio_abc",
          data: "AAAA",
          mime_type: "audio/wav",
          transcript: "hello",
        },
      },
      {
        event: "content-block-finish",
        index: 0,
        content_block: {
          type: "audio",
          id: "audio_abc",
          data: "AAAA",
          mime_type: "audio/wav",
          transcript: "hello",
        },
      },
      {
        event: "message-finish",
        reason: "stop",
        metadata: { stop_reason: "stop" },
      },
    ]);
  });
});
