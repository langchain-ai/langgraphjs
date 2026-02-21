/**
 * Type tests for message class instances in @langchain/angular.
 *
 * These tests validate that `useStream` from @langchain/angular exposes
 * @langchain/core message class instances (BaseMessage) rather than
 * plain SDK Message interfaces.
 *
 * Angular's useStream returns Angular signals, so messages are accessed
 * via `stream.messages()` (signal invocation).
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles them
 * to verify type correctness.
 */

import { describe, test, expectTypeOf } from "vitest";
import { useStream } from "../index.js";
import type {
  BaseMessage,
  StoredMessage,
} from "@langchain/core/messages";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { Message, DefaultToolCall } from "@langchain/langgraph-sdk";
import type { ToolCallWithResult } from "@langchain/langgraph-sdk";

// ============================================================================
// Test State Types
// ============================================================================

interface BasicState {
  messages: Message[];
}

type WeatherToolCall = {
  name: "get_weather";
  args: { location: string };
  id?: string;
  type?: "tool_call";
};

type SearchToolCall = {
  name: "search_web";
  args: { query: string; maxResults?: number };
  id?: string;
  type?: "tool_call";
};

type MultiToolCall = WeatherToolCall | SearchToolCall;

interface TypedToolCallState {
  messages: Message<MultiToolCall>[];
}

interface CustomState {
  messages: Message[];
  sessionId: string;
  metadata: { theme: "light" | "dark" };
}

// ============================================================================
// Type Tests: Messages are @langchain/core class instances
// ============================================================================

describe("useStream exposes BaseMessage class instances", () => {
  test("stream.messages is BaseMessage[], not plain Message[]", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages).toMatchTypeOf<BaseMessage[]>();
    expectTypeOf(stream.messages).not.toEqualTypeOf<Message[]>();
  });

  test("individual messages are BaseMessage instances", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg).toMatchTypeOf<BaseMessage>();
  });

  test("messages in values are also BaseMessage instances", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values.messages).toMatchTypeOf<BaseMessage[]>();
  });
});

// ============================================================================
// Type Tests: Class methods available on messages
// ============================================================================

describe("BaseMessage class methods are available", () => {
  test("toDict() returns StoredMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.toDict()).toEqualTypeOf<StoredMessage>();
  });

  test("getType() returns MessageType", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    const msgType = msg.getType();
    expectTypeOf(msgType).toBeString();
  });

  test("toFormattedString() is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.toFormattedString()).toEqualTypeOf<string>();
  });

  test("text getter is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.text).toEqualTypeOf<string>();
  });

  test("contentBlocks getter is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.contentBlocks).toBeArray();
  });
});

// ============================================================================
// Type Tests: Static type guards (isInstance)
// ============================================================================

describe("static type guard narrowing with isInstance", () => {
  test("AIMessage.isInstance() narrows to AIMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (AIMessage.isInstance(msg)) {
      expectTypeOf(msg).toMatchTypeOf<AIMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"ai">();
    }
  });

  test("narrowed AIMessage has tool_calls", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (AIMessage.isInstance(msg)) {
      expectTypeOf(msg).toHaveProperty("tool_calls");
      expectTypeOf(msg).toHaveProperty("invalid_tool_calls");
      expectTypeOf(msg).toHaveProperty("usage_metadata");
    }
  });

  test("AIMessageChunk.isInstance() narrows to AIMessageChunk", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (AIMessageChunk.isInstance(msg)) {
      expectTypeOf(msg).toMatchTypeOf<AIMessageChunk>();
      expectTypeOf(msg.type).toEqualTypeOf<"ai">();
    }
  });

  test("HumanMessage.isInstance() narrows to HumanMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (HumanMessage.isInstance(msg)) {
      expectTypeOf(msg).toMatchTypeOf<HumanMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"human">();
    }
  });

  test("ToolMessage.isInstance() narrows to ToolMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (ToolMessage.isInstance(msg)) {
      expectTypeOf(msg).toMatchTypeOf<ToolMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"tool">();
      expectTypeOf(msg).toHaveProperty("tool_call_id");
    }
  });

  test("SystemMessage.isInstance() narrows to SystemMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (SystemMessage.isInstance(msg)) {
      expectTypeOf(msg).toMatchTypeOf<SystemMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"system">();
    }
  });
});

// ============================================================================
// Type Tests: Type discriminant narrowing (msg.type)
// ============================================================================

describe("type discriminant still works for narrowing", () => {
  test("msg.type === 'ai' narrows to AI message type", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (msg.type === "ai") {
      expectTypeOf(msg.type).toEqualTypeOf<"ai">();
    }
  });

  test("msg.type === 'human' narrows to human message type", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (msg.type === "human") {
      expectTypeOf(msg.type).toEqualTypeOf<"human">();
    }
  });

  test("switch over msg.type covers known types", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    switch (msg.type) {
      case "ai":
        expectTypeOf(msg.type).toEqualTypeOf<"ai">();
        break;
      case "human":
        expectTypeOf(msg.type).toEqualTypeOf<"human">();
        break;
      case "tool":
        expectTypeOf(msg.type).toEqualTypeOf<"tool">();
        break;
      case "system":
        expectTypeOf(msg.type).toEqualTypeOf<"system">();
        break;
    }
  });
});

// ============================================================================
// Type Tests: Tool calls with typed state
// ============================================================================

describe("tool calls remain typed with class instances", () => {
  test("stream.toolCalls has typed call property", () => {
    const stream = useStream<TypedToolCallState>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls[0];
    expectTypeOf(tc).toMatchTypeOf<ToolCallWithResult<MultiToolCall>>();
    expectTypeOf(tc.call.name).toEqualTypeOf<
      "get_weather" | "search_web"
    >();
  });

  test("tool call args narrow by name", () => {
    const stream = useStream<TypedToolCallState>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls[0];
    if (tc.call.name === "get_weather") {
      expectTypeOf(tc.call.args).toEqualTypeOf<{ location: string }>();
    }
    if (tc.call.name === "search_web") {
      expectTypeOf(tc.call.args).toEqualTypeOf<{
        query: string;
        maxResults?: number;
      }>();
    }
  });

  test("toolCalls[].state is a lifecycle state", () => {
    const stream = useStream<TypedToolCallState>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls[0];
    expectTypeOf(tc.state).toEqualTypeOf<"pending" | "completed" | "error">();
  });
});

// ============================================================================
// Type Tests: Custom state with class instance messages
// ============================================================================

describe("custom state types work with class instance messages", () => {
  test("values includes custom state properties alongside messages", () => {
    const stream = useStream<CustomState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values.sessionId).toEqualTypeOf<string>();
    expectTypeOf(stream.values.metadata.theme).toEqualTypeOf<
      "light" | "dark"
    >();
    expectTypeOf(stream.values.messages).toMatchTypeOf<BaseMessage[]>();
  });
});

// ============================================================================
// Type Tests: Core stream properties unaffected
// ============================================================================

describe("core stream properties are unaffected", () => {
  test("isLoading is boolean", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.isLoading).toEqualTypeOf<boolean>();
  });

  test("error is unknown", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.error).toEqualTypeOf<unknown>();
  });

  test("stop returns Promise<void>", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.stop()).toEqualTypeOf<Promise<void>>();
  });

  test("submit returns Promise<void>", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.submit(null)).toEqualTypeOf<Promise<void>>();
  });

  test("branch is string", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.branch).toEqualTypeOf<string>();
  });

  test("assistantId is string", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.assistantId).toEqualTypeOf<string>();
  });
});

// ============================================================================
// Type Tests: Integration — realistic usage patterns
// ============================================================================

describe("realistic usage patterns with class instances", () => {
  test("iterating messages and rendering by type", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    for (const msg of stream.messages) {
      expectTypeOf(msg).toMatchTypeOf<BaseMessage>();

      if (AIMessage.isInstance(msg)) {
        expectTypeOf(msg.type).toEqualTypeOf<"ai">();
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const tc = msg.tool_calls[0];
          expectTypeOf(tc).toHaveProperty("name");
          expectTypeOf(tc).toHaveProperty("args");
        }
      }

      if (HumanMessage.isInstance(msg)) {
        expectTypeOf(msg.type).toEqualTypeOf<"human">();
      }
    }
  });

  test("converting back to plain dict for serialization", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    const dict = msg.toDict();
    expectTypeOf(dict.type).toEqualTypeOf<string>();
    expectTypeOf(dict.data).toHaveProperty("content");
  });

  test("using text getter for simple content extraction", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const texts = stream.messages.map((m) => m.text);
    expectTypeOf(texts).toEqualTypeOf<string[]>();
  });

  test("filtering messages by type using class type guards", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const aiMessages = stream.messages.filter(AIMessage.isInstance);
    expectTypeOf(aiMessages).toMatchTypeOf<AIMessage[]>();

    const humanMessages = stream.messages.filter(HumanMessage.isInstance);
    expectTypeOf(humanMessages).toMatchTypeOf<HumanMessage[]>();

    const toolMessages = stream.messages.filter(ToolMessage.isInstance);
    expectTypeOf(toolMessages).toMatchTypeOf<ToolMessage[]>();
  });
});
