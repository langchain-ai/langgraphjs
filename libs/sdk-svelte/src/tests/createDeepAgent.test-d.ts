/**
 * Type tests for `useStream` with DeepAgent types.
 *
 * Validates that:
 * - stream.messages is BaseMessage[] (Svelte-specific class instances)
 * - stream.toolCalls is correctly typed from deep agent tools
 * - stream.values contains the expected agent state
 * - stream.subagents contains the right types for subagents
 * - Subagent state includes middleware state
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles them
 * to verify type correctness.
 */

import { z } from "zod/v4";
import { describe, test, expectTypeOf } from "vitest";
import {
  tool,
  createMiddleware,
  AIMessage,
  ToolMessage,
  type BaseMessage,
  type ContentBlock,
} from "langchain";
import { createDeepAgent } from "deepagents";

import { useStream, type AssembledToolCall } from "../index.js";

const getWeather = tool(
  async ({ location }: { location: string }) => {
    return `Weather in ${location}: Sunny, 72°F`;
  },
  {
    name: "get_weather",
    description: "Get the current weather for a location",
    schema: z.object({
      location: z.string().describe("The city to get weather for"),
    }),
  },
);

const searchWeb = tool(
  async ({ query, maxResults }: { query: string; maxResults: number }) => {
    return `Found ${maxResults} results for: ${query}`;
  },
  {
    name: "search_web",
    description: "Search the web for information",
    schema: z.object({
      query: z.string().describe("The search query"),
      maxResults: z.number().default(10).describe("Maximum results to return"),
    }),
  },
);

const todoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
});

const filesMiddleware = createMiddleware({
  name: "files",
  stateSchema: z.object({
    files: z.array(
      z.object({
        path: z.string(),
        content: z.string(),
      }),
    ),
  }),
});

const todoListMiddleware = createMiddleware({
  name: "todoList",
  stateSchema: z.object({
    todos: z.array(todoSchema),
  }),
});

const counterMiddleware = createMiddleware({
  name: "counter",
  stateSchema: z.object({
    count: z.number(),
  }),
});

const notesMiddleware = createMiddleware({
  name: "notes",
  stateSchema: z.object({
    notes: z.array(
      z.object({
        title: z.string(),
        body: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
});

const deepAgentTwoSubagents = createDeepAgent({
  tools: [getWeather, searchWeb],
  middleware: [
    filesMiddleware,
    todoListMiddleware,
    counterMiddleware,
    notesMiddleware,
  ],
  subagents: [
    {
      name: "researcher",
      description: "Researches topics",
      systemPrompt: "You are a research assistant.",
    },
    {
      name: "writer",
      description: "Writes content",
      systemPrompt: "You are a writing assistant.",
    },
  ],
});

describe("deep agent", () => {
  test("has well typed messages", () => {
    const stream = useStream<typeof deepAgentTwoSubagents>({
      assistantId: "deep-agent",
    });

    expectTypeOf(stream.messages).toExtend<BaseMessage[]>();
    expectTypeOf(stream.messages[0]).toExtend<BaseMessage>();
    const firstMsg = stream.messages[0];
    if (AIMessage.isInstance(firstMsg)) {
      expectTypeOf(firstMsg.tool_calls).toExtend<
        | {
            readonly type?: "tool_call";
            id?: string;
            name: string;
            args: Record<string, any>;
          }[]
        | undefined
      >();
    }
    if (ToolMessage.isInstance(firstMsg)) {
      expectTypeOf(firstMsg.content).toEqualTypeOf<
        string | (ContentBlock | ContentBlock.Text)[]
      >();
    }
  });

  test("has well typed values", () => {
    const stream = useStream<typeof deepAgentTwoSubagents>({
      assistantId: "deep-agent",
    });

    expectTypeOf(stream.values).toHaveProperty("messages");
    expectTypeOf(stream.values.todos).toEqualTypeOf<
      {
        content: string;
        status: "completed" | "in_progress" | "pending";
      }[] &
        {
          status: "pending" | "in_progress" | "completed" | "cancelled";
          content: string;
          id: string;
        }[]
    >();
    expectTypeOf(stream.values.count).toEqualTypeOf<number>();
    expectTypeOf(stream.values.files).toEqualTypeOf<
      {
        path: string;
        content: string;
      }[]
    >();
    expectTypeOf(stream.values.notes).toEqualTypeOf<
      {
        title: string;
        body: string;
        createdAt: string;
      }[]
    >();
  });

  test("should have well typed tool calls", () => {
    const stream = useStream<typeof deepAgentTwoSubagents>({
      assistantId: "deep-agent",
    });

    const tc = stream.toolCalls[0];
    expectTypeOf(tc).toExtend<AssembledToolCall>();
    expectTypeOf(tc.name).toEqualTypeOf<string>();
    expectTypeOf(tc.callId).toEqualTypeOf<string>();
    expectTypeOf(tc.namespace).toEqualTypeOf<string[]>();
    expectTypeOf(tc.input).toEqualTypeOf<unknown>();
    expectTypeOf(tc.output).toEqualTypeOf<Promise<unknown>>();
  });

  test("toolCalls is available on deep agent streams", () => {
    const stream = useStream<typeof deepAgentTwoSubagents>({
      assistantId: "deep-agent",
    });

    expectTypeOf(stream.toolCalls).toBeArray();
  });

  test("should have well typed subagent values", () => {
    const stream = useStream<typeof deepAgentTwoSubagents>({
      assistantId: "deep-agent",
    });

    const subagent = [...stream.subagents.values()][0];
    expectTypeOf(subagent.id).toEqualTypeOf<string>();
    expectTypeOf(subagent.name).toEqualTypeOf<string>();
    expectTypeOf(subagent.status).toEqualTypeOf<"running" | "complete" | "error">();
    expectTypeOf(subagent.taskInput).toEqualTypeOf<string | undefined>();
    expectTypeOf(subagent.output).toEqualTypeOf<unknown>();
    expectTypeOf(subagent.namespace).toExtend<readonly string[]>();
    expectTypeOf(subagent.parentId).toEqualTypeOf<string | null>();
    expectTypeOf(subagent.depth).toEqualTypeOf<number>();
    expectTypeOf(subagent.startedAt).toEqualTypeOf<Date>();
    expectTypeOf(subagent.completedAt).toEqualTypeOf<Date | null>();
  });

  test("subagent discovery snapshots do not include eager content", () => {
    const stream = useStream<typeof deepAgentTwoSubagents>({
      assistantId: "deep-agent",
    });

    const subagent = [...stream.subagents.values()][0];

    expectTypeOf(subagent).not.toHaveProperty("messages");
    expectTypeOf(subagent).not.toHaveProperty("toolCalls");
  });
});
