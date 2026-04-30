import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import type { AssembledToolCall } from "@langchain/langgraph-sdk/stream";
import { createAgent, createMiddleware, tool } from "langchain";
import { z } from "zod/v4";
import { describe, expectTypeOf, test } from "vitest";

import { injectMessageMetadata, useStream } from "../index.js";

const getWeather = tool(
  async ({ location }: { location: string }) => `Weather in ${location}`,
  {
    name: "get_weather",
    description: "Get weather",
    schema: z.object({ location: z.string() }),
  }
);

const todoMiddleware = createMiddleware({
  name: "todos",
  stateSchema: z.object({
    todos: z.array(
      z.object({
        id: z.string(),
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
      })
    ),
  }),
});

const agent = createAgent({
  model: "gpt-4o-mini",
  tools: [getWeather],
  middleware: [todoMiddleware],
});

describe("createAgent stream typing", () => {
  test("messages and values are inferred from agent types", () => {
    const stream = useStream<typeof agent>({ assistantId: "agent" });

    expectTypeOf(stream.messages()).toExtend<BaseMessage[]>();
    expectTypeOf(stream.values()).toHaveProperty("messages");
    expectTypeOf(stream.values().todos[0].status).toEqualTypeOf<
      "pending" | "in_progress" | "completed" | "cancelled"
    >();
  });

  test("toolCalls exposes assembled protocol tool calls", () => {
    const stream = useStream<typeof agent>({ assistantId: "agent" });
    const toolCall = stream.toolCalls()[0];

    expectTypeOf(toolCall).toExtend<AssembledToolCall>();
    expectTypeOf(toolCall.name).toEqualTypeOf<string>();
    expectTypeOf(toolCall.callId).toEqualTypeOf<string>();
    expectTypeOf(toolCall.input).toEqualTypeOf<unknown>();
    expectTypeOf(toolCall.output).toEqualTypeOf<Promise<unknown>>();
  });

  test("metadata is read with the companion injector", () => {
    const stream = useStream<typeof agent>({ assistantId: "agent" });
    const metadata = injectMessageMetadata(stream, () => stream.messages()[0]?.id);

    if (metadata()) {
      expectTypeOf(metadata()!.parentCheckpointId).toEqualTypeOf<
        string | undefined
      >();
    }
  });

  test("submit accepts message-like updates", () => {
    const stream = useStream<typeof agent>({ assistantId: "agent" });

    expectTypeOf(stream.submit).toBeCallableWith(
      { messages: [new HumanMessage("Hello")] },
      undefined
    );
  });

  test("agent streams only expose discovery maps for subagents", () => {
    const stream = useStream<typeof agent>({ assistantId: "agent" });

    expectTypeOf(stream).toHaveProperty("subagents");
    expectTypeOf(stream).not.toHaveProperty("getSubagent");
    expectTypeOf(stream).not.toHaveProperty("activeSubagents");
  });
});
