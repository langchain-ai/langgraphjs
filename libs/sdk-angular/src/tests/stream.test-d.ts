/**
 * Type tests for message class instances in @langchain/angular.
 *
 * These tests validate that `useStream` from @langchain/angular exposes
 * @langchain/core message class instances (BaseMessage) rather than
 * plain SDK Message interfaces.
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles them
 * to verify type correctness.
 */

import { describe, test, expectTypeOf } from "vitest";
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
import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "../index.js";

// ============================================================================
// Test State Types
// ============================================================================

interface BasicState {
  messages: Message[];
}

// ============================================================================
// Type Tests: Messages are @langchain/core class instances
// ============================================================================

describe("useStream exposes BaseMessage class instances", () => {
  test("stream.messages is BaseMessage[], not plain Message[]", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages).toExtend<BaseMessage[]>();
    expectTypeOf(stream.messages).not.toEqualTypeOf<Message[]>();
  });

  test("individual messages are BaseMessage instances", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg).toExtend<BaseMessage>();
  });

  test("values property exists", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream).toHaveProperty("values");
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

  test("id property is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.id).toEqualTypeOf<string | undefined>();
  });

  test("type property is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg).toHaveProperty("type");
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
      expectTypeOf(msg).toExtend<AIMessage>();
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
      expectTypeOf(msg).toExtend<AIMessageChunk>();
      expectTypeOf(msg.type).toEqualTypeOf<"ai">();
    }
  });

  test("HumanMessage.isInstance() narrows to HumanMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (HumanMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<HumanMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"human">();
    }
  });

  test("ToolMessage.isInstance() narrows to ToolMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (ToolMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<ToolMessage>();
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
      expectTypeOf(msg).toExtend<SystemMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"system">();
    }
  });
});

// ============================================================================
// Type Tests: Type discriminant narrowing
// ============================================================================

describe("type discriminant still works for narrowing", () => {
  test("msg.type is a string (MessageType)", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.type).toBeString();
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

  test("assistantId is string", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.assistantId).toEqualTypeOf<string>();
  });
});

// ============================================================================
// Type Tests: getMessagesMetadata works with BaseMessage
// ============================================================================

describe("getMessagesMetadata accepts BaseMessage", () => {
  test("getMessagesMetadata can be called with a class instance", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    const metadata = stream.getMessagesMetadata(msg, 0);

    if (metadata) {
      expectTypeOf(metadata.messageId).toEqualTypeOf<string>();
      expectTypeOf(metadata.branch).toEqualTypeOf<string | undefined>();
      expectTypeOf(metadata.branchOptions).toEqualTypeOf<
        string[] | undefined
      >();
    }
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
      expectTypeOf(msg).toExtend<BaseMessage>();
      expectTypeOf(msg.content).not.toBeNever();

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
    expectTypeOf(aiMessages).toExtend<AIMessage[]>();

    const humanMessages = stream.messages.filter(HumanMessage.isInstance);
    expectTypeOf(humanMessages).toExtend<HumanMessage[]>();

    const toolMessages = stream.messages.filter(ToolMessage.isInstance);
    expectTypeOf(toolMessages).toExtend<ToolMessage[]>();
  });
});
