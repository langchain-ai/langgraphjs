import { describe, expect, it } from "vitest";
import {
  extractToolCallsFromBlocks,
  normalizePlainAIMessageFields,
  stripProviderToolCallBlocks,
  toolCallFromProviderBlock,
} from "./normalize-tool-calls.js";

describe("toolCallFromProviderBlock", () => {
  it("maps tool_call blocks", () => {
    expect(
      toolCallFromProviderBlock({
        type: "tool_call",
        id: "call_1",
        name: "search",
        args: { q: "test" },
      })
    ).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "search",
      args: { q: "test" },
    });
  });

  it("maps tool_use blocks", () => {
    expect(
      toolCallFromProviderBlock({
        type: "tool_use",
        id: "toolu_1",
        name: "ls",
        input: { path: "." },
      })
    ).toEqual({
      type: "tool_call",
      id: "toolu_1",
      name: "ls",
      args: { path: "." },
    });
  });

  it("maps OpenAI Responses function_call blocks", () => {
    expect(
      toolCallFromProviderBlock({
        type: "function_call",
        name: "get_weather",
        call_id: "call_123",
        arguments: '{"city":"Paris"}',
      })
    ).toEqual({
      type: "tool_call",
      id: "call_123",
      name: "get_weather",
      args: { city: "Paris" },
    });
  });

  it("handles invalid JSON in function_call arguments", () => {
    expect(
      toolCallFromProviderBlock({
        type: "function_call",
        name: "get_weather",
        call_id: "call_456",
        arguments: "not valid json",
      })
    ).toEqual({
      type: "tool_call",
      id: "call_456",
      name: "get_weather",
      args: { raw: "not valid json" },
    });
  });
});

describe("normalizePlainAIMessageFields", () => {
  it("promotes function_call content blocks to tool_calls", () => {
    const result = normalizePlainAIMessageFields({
      type: "ai",
      id: "msg_1",
      content: [
        {
          type: "function_call",
          name: "get_weather",
          call_id: "call_123",
          arguments: '{"city":"San Francisco"}',
        },
      ],
      tool_calls: [],
    });

    expect(result.tool_calls).toEqual([
      {
        type: "tool_call",
        id: "call_123",
        name: "get_weather",
        args: { city: "San Francisco" },
      },
    ]);
    expect(result.content).toEqual([]);
  });

  it("falls back to response_metadata.output", () => {
    const result = normalizePlainAIMessageFields({
      type: "ai",
      content: "",
      tool_calls: [],
      response_metadata: {
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_789",
            name: "get_weather",
            arguments: '{"city":"NYC"}',
          },
        ],
      },
    });

    expect(result.tool_calls).toEqual([
      {
        type: "tool_call",
        id: "call_789",
        name: "get_weather",
        args: { city: "NYC" },
      },
    ]);
  });

  it("promotes legacy additional_kwargs.tool_calls", () => {
    const legacy = [
      {
        id: "call_legacy",
        type: "function",
        function: { name: "search", arguments: "{}" },
      },
    ];
    const result = normalizePlainAIMessageFields({
      type: "ai",
      content: "",
      tool_calls: [],
      additional_kwargs: { tool_calls: legacy },
    });

    expect(result.tool_calls).toEqual(legacy);
  });

  it("leaves messages with existing tool_calls unchanged", () => {
    const message = {
      type: "ai",
      content: [{ type: "function_call", name: "x", call_id: "y" }],
      tool_calls: [{ type: "tool_call", id: "existing", name: "x", args: {} }],
    };
    expect(normalizePlainAIMessageFields(message)).toBe(message);
  });
});

describe("stripProviderToolCallBlocks", () => {
  it("removes function_call blocks but keeps other content", () => {
    expect(
      stripProviderToolCallBlocks([
        { type: "text", text: "hello" },
        { type: "function_call", name: "x", call_id: "y", arguments: "{}" },
      ])
    ).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("extractToolCallsFromBlocks", () => {
  it("extracts multiple tool calls in order", () => {
    expect(
      extractToolCallsFromBlocks([
        { type: "tool_call", id: "a", name: "one", args: {} },
        {
          type: "function_call",
          call_id: "b",
          name: "two",
          arguments: '{"k":1}',
        },
      ])
    ).toEqual([
      { type: "tool_call", id: "a", name: "one", args: {} },
      { type: "tool_call", id: "b", name: "two", args: { k: 1 } },
    ]);
  });
});
