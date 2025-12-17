import { describe, test, expectTypeOf } from "vitest";

import type { Message } from "../../types.messages.js";
import { useStream } from "../stream.js";

describe("useStream", () => {
  test("should properly type tool calls with explicit ToolCallsType", () => {
    // Define tool call types as a discriminated union
    type MyToolCalls =
      | {
          name: "get_weather";
          args: {
            location: string;
          };
          id?: string | undefined;
          type?: "tool_call" | undefined;
        }
      | {
          name: "search";
          args: {
            query: string;
          };
          id?: string | undefined;
          type?: "tool_call" | undefined;
        };

    interface MyState {
      messages: Message<MyToolCalls>[];
    }

    // Use with explicit ToolCallsType
    const stream = useStream<MyState, { ToolCallsType: MyToolCalls }>({
      assistantId: "test",
      apiUrl: "http://localhost:2024",
    });

    // Verify messages are typed with the tool calls
    expectTypeOf(stream.messages).toEqualTypeOf<Message<MyToolCalls>[]>();

    // Verify toolCalls are properly typed
    for (const { call } of stream.toolCalls) {
      if (call.name === "get_weather") {
        expectTypeOf(call.args).toEqualTypeOf<{ location: string }>();
      }
      if (call.name === "search") {
        expectTypeOf(call.args).toEqualTypeOf<{ query: string }>();
      }
    }

    // Verify message type narrowing works
    for (const message of stream.messages) {
      if (message.type === "tool") {
        expectTypeOf(message.tool_call_id).toBeString();
      }

      if (message.type === "ai") {
        expectTypeOf(message.tool_calls).toEqualTypeOf<
          MyToolCalls[] | undefined
        >();
      }
    }
  });

  test("should default to DefaultToolCall when no ToolCallsType specified", () => {
    interface MyState {
      messages: Message[];
    }

    const stream = useStream<MyState>({
      assistantId: "test",
      apiUrl: "http://localhost:2024",
    });

    // Should use DefaultToolCall
    for (const message of stream.messages) {
      if (message.type === "ai" && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          expectTypeOf(toolCall.name).toBeString();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          expectTypeOf(toolCall.args).toEqualTypeOf<{ [x: string]: any }>();
        }
      }
    }
  });
});
