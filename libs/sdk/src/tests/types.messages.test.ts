import { describe, test, expect } from "vitest";
import { getToolCallsWithResults } from "../utils/tools.js";
import type {
  Message,
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "../types.messages.js";

describe("getToolCallsWithResults", () => {
  test("returns empty array for empty messages", () => {
    const result = getToolCallsWithResults([]);
    expect(result).toEqual([]);
  });

  test("returns empty array when no AI messages with tool calls", () => {
    const messages: Message[] = [
      { type: "human", content: "Hello" },
      { type: "ai", content: "Hi there!" },
      { type: "system", content: "You are a helpful assistant" },
    ];
    const result = getToolCallsWithResults(messages);
    expect(result).toEqual([]);
  });

  test("returns empty array for AI message with empty tool_calls array", () => {
    const messages: Message[] = [{ type: "ai", content: "", tool_calls: [] }];
    const result = getToolCallsWithResults(messages);
    expect(result).toEqual([]);
  });

  test("pairs tool call with its result", () => {
    const aiMessage: AIMessage = {
      type: "ai",
      content: "",
      tool_calls: [
        { name: "get_weather", args: { location: "NYC" }, id: "tc1" },
      ],
    };
    const toolMessage: ToolMessage = {
      type: "tool",
      content: "Sunny, 72°F",
      tool_call_id: "tc1",
    };
    const messages: Message[] = [aiMessage, toolMessage];

    const result = getToolCallsWithResults(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "tc1",
      call: { name: "get_weather", args: { location: "NYC" }, id: "tc1" },
      result: toolMessage,
      aiMessage,
      index: 0,
      state: "completed",
    });
  });

  test("returns undefined result when tool call has no matching result", () => {
    const aiMessage: AIMessage = {
      type: "ai",
      content: "",
      tool_calls: [
        { name: "get_weather", args: { location: "NYC" }, id: "tc1" },
      ],
    };
    const messages: Message[] = [aiMessage];

    const result = getToolCallsWithResults(messages);

    expect(result).toHaveLength(1);
    expect(result[0].call).toEqual({
      name: "get_weather",
      args: { location: "NYC" },
      id: "tc1",
    });
    expect(result[0].result).toBeUndefined();
    expect(result[0].aiMessage).toBe(aiMessage);
    expect(result[0].index).toBe(0);
  });

  test("returns undefined result when tool call has no id", () => {
    const aiMessage: AIMessage = {
      type: "ai",
      content: "",
      tool_calls: [{ name: "get_weather", args: { location: "NYC" } }],
    };
    const toolMessage: ToolMessage = {
      type: "tool",
      content: "Sunny",
      tool_call_id: "some_id",
    };
    const messages: Message[] = [aiMessage, toolMessage];

    const result = getToolCallsWithResults(messages);

    expect(result).toHaveLength(1);
    expect(result[0].result).toBeUndefined();
  });

  test("handles multiple tool calls in single AI message", () => {
    const aiMessage: AIMessage = {
      type: "ai",
      content: "",
      tool_calls: [
        { name: "get_weather", args: { location: "NYC" }, id: "tc1" },
        { name: "get_weather", args: { location: "LA" }, id: "tc2" },
      ],
    };
    const toolMessage1: ToolMessage = {
      type: "tool",
      content: "Sunny, 72°F",
      tool_call_id: "tc1",
    };
    const toolMessage2: ToolMessage = {
      type: "tool",
      content: "Cloudy, 65°F",
      tool_call_id: "tc2",
    };
    const messages: Message[] = [aiMessage, toolMessage1, toolMessage2];

    const result = getToolCallsWithResults(messages);

    expect(result).toHaveLength(2);
    expect(result[0].call.name).toBe("get_weather");
    expect(result[0].result).toBe(toolMessage1);
    expect(result[0].index).toBe(0);
    expect(result[1].call.name).toBe("get_weather");
    expect(result[1].result).toBe(toolMessage2);
    expect(result[1].index).toBe(1);
  });

  test("handles multiple AI messages with tool calls", () => {
    const aiMessage1: AIMessage = {
      type: "ai",
      content: "",
      tool_calls: [{ name: "search", args: { query: "test" }, id: "tc1" }],
    };
    const toolMessage1: ToolMessage = {
      type: "tool",
      content: "Search results",
      tool_call_id: "tc1",
    };
    const aiMessage2: AIMessage = {
      type: "ai",
      content: "",
      tool_calls: [
        { name: "get_weather", args: { location: "NYC" }, id: "tc2" },
      ],
    };
    const toolMessage2: ToolMessage = {
      type: "tool",
      content: "Sunny",
      tool_call_id: "tc2",
    };
    const messages: Message[] = [
      aiMessage1,
      toolMessage1,
      aiMessage2,
      toolMessage2,
    ];

    const result = getToolCallsWithResults(messages);

    expect(result).toHaveLength(2);
    expect(result[0].call.name).toBe("search");
    expect(result[0].aiMessage).toBe(aiMessage1);
    expect(result[0].result).toBe(toolMessage1);
    expect(result[1].call.name).toBe("get_weather");
    expect(result[1].aiMessage).toBe(aiMessage2);
    expect(result[1].result).toBe(toolMessage2);
  });

  test("handles tool result appearing before AI message in array", () => {
    const toolMessage: ToolMessage = {
      type: "tool",
      content: "Result",
      tool_call_id: "tc1",
    };
    const aiMessage: AIMessage = {
      type: "ai",
      content: "",
      tool_calls: [{ name: "test_tool", args: {}, id: "tc1" }],
    };
    // Tool message comes before AI message (unusual but should still work)
    const messages: Message[] = [toolMessage, aiMessage];

    const result = getToolCallsWithResults(messages);

    expect(result).toHaveLength(1);
    expect(result[0].result).toBe(toolMessage);
  });

  test("works with custom tool call types", () => {
    type MyToolCall =
      | { name: "get_weather"; args: { location: string }; id: string }
      | { name: "search"; args: { query: string }; id: string };

    const aiMessage: AIMessage<MyToolCall> = {
      type: "ai",
      content: "",
      tool_calls: [
        { name: "get_weather", args: { location: "NYC" }, id: "tc1" },
      ],
    };
    const toolMessage: ToolMessage = {
      type: "tool",
      content: "Sunny",
      tool_call_id: "tc1",
    };
    const messages: Message<MyToolCall>[] = [aiMessage, toolMessage];

    const result = getToolCallsWithResults<MyToolCall>(messages);

    expect(result).toHaveLength(1);
    expect(result[0].call.name).toBe("get_weather");
    // Type narrowing works - args.location is typed
    if (result[0].call.name === "get_weather") {
      expect(result[0].call.args.location).toBe("NYC");
    }
  });

  test("ignores other message types when collecting results", () => {
    const humanMessage: HumanMessage = { type: "human", content: "Hi" };
    const aiMessage: AIMessage = {
      type: "ai",
      content: "",
      tool_calls: [{ name: "greet", args: {}, id: "tc1" }],
    };
    const toolMessage: ToolMessage = {
      type: "tool",
      content: "Hello!",
      tool_call_id: "tc1",
    };
    const systemMessage: Message = {
      type: "system",
      content: "System prompt",
    };
    const messages: Message[] = [
      humanMessage,
      systemMessage,
      aiMessage,
      toolMessage,
    ];

    const result = getToolCallsWithResults(messages);

    expect(result).toHaveLength(1);
    expect(result[0].call.name).toBe("greet");
  });

  test("handles partial results (some tool calls with results, some without)", () => {
    const aiMessage: AIMessage = {
      type: "ai",
      content: "",
      tool_calls: [
        { name: "tool1", args: {}, id: "tc1" },
        { name: "tool2", args: {}, id: "tc2" },
        { name: "tool3", args: {}, id: "tc3" },
      ],
    };
    const toolMessage1: ToolMessage = {
      type: "tool",
      content: "Result 1",
      tool_call_id: "tc1",
    };
    const toolMessage3: ToolMessage = {
      type: "tool",
      content: "Result 3",
      tool_call_id: "tc3",
    };
    const messages: Message[] = [aiMessage, toolMessage1, toolMessage3];

    const result = getToolCallsWithResults(messages);

    expect(result).toHaveLength(3);
    expect(result[0].result).toBe(toolMessage1);
    expect(result[1].result).toBeUndefined(); // tc2 has no result
    expect(result[2].result).toBe(toolMessage3);
  });
});
