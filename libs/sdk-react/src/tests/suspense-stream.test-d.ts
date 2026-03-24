/**
 * Type tests for `useSuspenseStream`.
 *
 * Validates that:
 * - `isStreaming` is a boolean
 * - `isLoading`, `error`, `isThreadLoading` are NOT present
 * - `messages` is BaseMessage[]
 * - `submit`, `stop`, `switchThread`, etc. are present
 * - The hook works with compiled graphs and direct state types
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles them
 * to verify type correctness.
 */

import { describe, test, expectTypeOf } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";
import {
  StateGraph,
  StateSchema,
  MessagesValue,
  START,
  END,
} from "@langchain/langgraph";
import type { Message } from "@langchain/langgraph-sdk";
import { createSuspenseCache, useSuspenseStream } from "../index.js";

const SimpleGraphSchema = new StateSchema({
  messages: MessagesValue,
});

const simpleGraph = new StateGraph(SimpleGraphSchema)
  .addNode("agent", async (state: typeof SimpleGraphSchema.State) => ({
    messages: state.messages,
  }))
  .addEdge(START, "agent")
  .addEdge("agent", END)
  .compile();

describe("useSuspenseStream: return type removes loading/error", () => {
  test("isStreaming is boolean", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });

    expectTypeOf(stream.isStreaming).toEqualTypeOf<boolean>();
  });

  test("isLoading is NOT on the return type", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });

    expectTypeOf(stream).not.toHaveProperty("isLoading");
  });

  test("error is NOT on the return type", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });

    expectTypeOf(stream).not.toHaveProperty("error");
  });

  test("isThreadLoading is NOT on the return type", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });

    expectTypeOf(stream).not.toHaveProperty("isThreadLoading");
  });

  test("messages is BaseMessage[]", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages).toExtend<BaseMessage[]>();
  });

  test("submit is present and callable", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });

    expectTypeOf(stream.submit).toBeFunction();
  });

  test("stop is present", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });

    expectTypeOf(stream.stop).toBeFunction();
  });

  test("switchThread is present", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });

    expectTypeOf(stream.switchThread).toBeFunction();
  });
});

describe("useSuspenseStream: works with compiled graphs", () => {
  test("compiled graph: isStreaming is boolean", () => {
    const stream = useSuspenseStream<typeof simpleGraph>({
      assistantId: "graph",
    });

    expectTypeOf(stream.isStreaming).toEqualTypeOf<boolean>();
  });

  test("compiled graph: messages is BaseMessage[]", () => {
    const stream = useSuspenseStream<typeof simpleGraph>({
      assistantId: "graph",
    });

    expectTypeOf(stream.messages).toExtend<BaseMessage[]>();
  });

  test("compiled graph: isLoading is NOT present", () => {
    const stream = useSuspenseStream<typeof simpleGraph>({
      assistantId: "graph",
    });

    expectTypeOf(stream).not.toHaveProperty("isLoading");
  });
});

describe("useSuspenseStream: suspense cache option", () => {
  test("accepts a custom suspense cache", () => {
    const suspenseCache = createSuspenseCache();
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
      suspenseCache,
    });

    expectTypeOf(stream.isStreaming).toEqualTypeOf<boolean>();
  });
});
