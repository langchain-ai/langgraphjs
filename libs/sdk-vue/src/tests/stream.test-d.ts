/**
 * Type tests for message class instances in @langchain/vue.
 *
 * These tests validate that `useStream` from @langchain/vue exposes
 * @langchain/core message class instances (BaseMessage) rather than
 * plain SDK Message interfaces.
 *
 * In Vue, reactive properties are wrapped in `Ref<T>` or `ComputedRef<T>`,
 * so accessing the underlying value requires `.value`.
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles them
 * to verify type correctness.
 */

import { describe, test, expectTypeOf } from "vitest";
import type { ComputedRef, Ref } from "vue";
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

interface CustomState {
  messages: Message[];
  sessionId: string;
  metadata: { theme: "light" | "dark" };
}

// ============================================================================
// Type Tests: Messages are @langchain/core class instances
// ============================================================================

describe("useStream exposes BaseMessage class instances", () => {
  test("stream.messages is ComputedRef<BaseMessage[]>", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages).toExtend<ComputedRef<BaseMessage[]>>();
    expectTypeOf(stream.messages.value).toExtend<BaseMessage[]>();
    expectTypeOf(stream.messages.value).not.toEqualTypeOf<Message[]>();
  });

  test("individual messages are BaseMessage instances", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
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

    const msg = stream.messages.value[0];
    expectTypeOf(msg.toDict()).toEqualTypeOf<StoredMessage>();
  });

  test("getType() returns MessageType", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
    const msgType = msg.getType();
    expectTypeOf(msgType).toBeString();
  });

  test("text getter is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
    expectTypeOf(msg.text).toEqualTypeOf<string>();
  });

  test("id property is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
    expectTypeOf(msg.id).toEqualTypeOf<string | undefined>();
  });

  test("type property is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
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

    const msg = stream.messages.value[0];
    if (AIMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<AIMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"ai">();
    }
  });

  test("narrowed AIMessage has tool_calls", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
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

    const msg = stream.messages.value[0];
    if (AIMessageChunk.isInstance(msg)) {
      expectTypeOf(msg).toExtend<AIMessageChunk>();
    }
  });

  test("HumanMessage.isInstance() narrows to HumanMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
    if (HumanMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<HumanMessage>();
    }
  });

  test("ToolMessage.isInstance() narrows to ToolMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
    if (ToolMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<ToolMessage>();
      expectTypeOf(msg).toHaveProperty("tool_call_id");
    }
  });

  test("SystemMessage.isInstance() narrows to SystemMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
    if (SystemMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<SystemMessage>();
    }
  });
});

// ============================================================================
// Type Tests: Vue reactive properties
// ============================================================================

describe("Vue reactive wrappers are correct", () => {
  test("isLoading is Ref<boolean>", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.isLoading).toExtend<Ref<boolean>>();
    expectTypeOf(stream.isLoading.value).toEqualTypeOf<boolean>();
  });

  test("error is Ref<unknown>", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.error).toExtend<Ref<unknown>>();
  });

  test("branch is Ref<string>", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.branch).toExtend<Ref<string>>();
    expectTypeOf(stream.branch.value).toEqualTypeOf<string>();
  });

  test("stop is a plain function", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.stop()).toEqualTypeOf<Promise<void>>();
  });

  test("submit is a plain function", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.submit(null)).toEqualTypeOf<Promise<void>>();
  });
});

// ============================================================================
// Type Tests: Custom state with class instance messages
// ============================================================================

describe("custom state types work with class instance messages", () => {
  test("values property exists with custom state", () => {
    const stream = useStream<CustomState>({
      assistantId: "agent",
    });

    expectTypeOf(stream).toHaveProperty("values");
  });

  test("stream.messages.value is BaseMessage[]", () => {
    const stream = useStream<CustomState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages.value).toExtend<BaseMessage[]>();
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

    const msg = stream.messages.value[0];
    const metadata = stream.getMessagesMetadata(msg, 0);

    if (metadata) {
      expectTypeOf(metadata.messageId).toEqualTypeOf<string>();
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

    for (const msg of stream.messages.value) {
      expectTypeOf(msg).toExtend<BaseMessage>();

      if (AIMessage.isInstance(msg)) {
        expectTypeOf(msg.type).toEqualTypeOf<"ai">();
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

    const msg = stream.messages.value[0];
    const dict = msg.toDict();
    expectTypeOf(dict.type).toEqualTypeOf<string>();
  });

  test("using text getter for simple content extraction", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const texts = stream.messages.value.map((m) => m.text);
    expectTypeOf(texts).toEqualTypeOf<string[]>();
  });

  test("filtering messages by type using class type guards", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const aiMessages = stream.messages.value.filter(AIMessage.isInstance);
    expectTypeOf(aiMessages).toExtend<AIMessage[]>();

    const humanMessages = stream.messages.value.filter(
      HumanMessage.isInstance
    );
    expectTypeOf(humanMessages).toExtend<HumanMessage[]>();

    const toolMessages = stream.messages.value.filter(ToolMessage.isInstance);
    expectTypeOf(toolMessages).toExtend<ToolMessage[]>();
  });
});
