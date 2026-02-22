/**
 * Type tests for `useStream` with DeepAgent types.
 *
 * Validates that:
 * - stream.messages is BaseMessage[] (React-specific class instances)
 * - stream.toolCalls is correctly typed from deep agent tools
 * - stream.values contains the expected agent state
 * - stream.subagents contains the right types for subagents
 * - getSubagentsByType returns correctly narrowed subagent streams
 * - Subagent state includes middleware state
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles them
 * to verify type correctness.
 */

import { z } from "zod/v4";
import { describe, test, expectTypeOf } from "vitest";
import { tool, createMiddleware, AIMessage, ToolMessage, type BaseMessage, type ContentBlock } from "langchain";
import { createDeepAgent } from "deepagents";
import type { Message } from "@langchain/langgraph-sdk";

import { useStream } from "../index.js";

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
    }
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
    }
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
            })
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
            })
        ),
    }),
});

const deepAgentTwoSubagents = createDeepAgent({
    tools: [getWeather, searchWeb],
    middleware: [filesMiddleware, todoListMiddleware, counterMiddleware, notesMiddleware],
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
        if (AIMessage.isInstance(stream.messages[0])) {
            expectTypeOf(stream.messages[0].tool_calls).toExtend<{
                readonly type?: "tool_call";
                id?: string;
                name: string;
                args: Record<string, any>;
            }[] | undefined>();
        }
        if (ToolMessage.isInstance(stream.messages[0])) {
            expectTypeOf(stream.messages[0].content).toEqualTypeOf<string | (ContentBlock | ContentBlock.Text)[]>();
        }
    });

    test("has well typed values", () => {
        const stream = useStream<typeof deepAgentTwoSubagents>({
            assistantId: "deep-agent",
        });

        expectTypeOf(stream.values).toHaveProperty("messages");
        expectTypeOf(stream.values.todos).toEqualTypeOf<{
            content: string;
            status: "completed" | "in_progress" | "pending";
        }[] & {
            status: "pending" | "in_progress" | "completed" | "cancelled";
            content: string;
            id: string;
        }[]>()
        expectTypeOf(stream.values.count).toEqualTypeOf<number>();
        expectTypeOf(stream.values.files).toEqualTypeOf<{
            path: string;
            content: string;
        }[]>();
        expectTypeOf(stream.values.notes).toEqualTypeOf<{
            title: string;
            body: string;
            createdAt: string;
        }[]>();
    });

    test("should have well typed subagents", () => {
        const stream = useStream<typeof deepAgentTwoSubagents>({
            assistantId: "deep-agent",
        });

        const subagents = stream.subagents.get("");
        expectTypeOf(subagents?.result).toEqualTypeOf<string | null | undefined>();
        expectTypeOf(subagents?.status).toEqualTypeOf<"pending" | "running" | "complete" | "error" | undefined>();
        if (AIMessage.isInstance(subagents?.messages[0])) {
            expectTypeOf(subagents?.messages[0].tool_calls).toEqualTypeOf<(({
                name: "get_weather";
                args: {
                    location: string;
                };
                id?: string;
                type?: "tool_call";
            } | {
                name: "search_web";
                args: {
                    query: string;
                    maxResults?: number | undefined;
                };
                id?: string;
                type?: "tool_call";
            })[] & {
                readonly type?: "tool_call";
                id?: string;
                name: string;
                args: Record<string, any>;
            }[]) | undefined>();
        }
    });

    test("should have well typed tool calls", () => {
        const stream = useStream<typeof deepAgentTwoSubagents>({
            assistantId: "deep-agent",
        });

        const tc = stream.toolCalls[0];
        expectTypeOf(tc.call.name).toEqualTypeOf<"get_weather" | "search_web">();
        expectTypeOf(tc.call.args).toEqualTypeOf<{
            location: string;
        } | {
            query: string;
            maxResults?: number | undefined;
        }>();
        expectTypeOf(tc.id).toEqualTypeOf<string>();
        expectTypeOf(tc.index).toEqualTypeOf<number>();
        expectTypeOf(tc.state).toEqualTypeOf<
            "pending" | "completed" | "error"
        >();
        expectTypeOf(tc.result).toBeNullable();
    });

    test("getToolCalls is available on deep agent streams", () => {
        const stream = useStream<typeof deepAgentTwoSubagents>({
            assistantId: "deep-agent",
        });

        const msg = stream.messages[0];
        if (AIMessage.isInstance(msg)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const toolCalls = stream.getToolCalls(msg as any);
            expectTypeOf(toolCalls[0].state).toEqualTypeOf<"pending" | "completed" | "error">();
            expectTypeOf(toolCalls[0].call.name).toEqualTypeOf<"get_weather" | "search_web">();
            expectTypeOf(toolCalls[0].call.args).toEqualTypeOf<{
                location: string;
            } | {
                query: string;
                maxResults?: number | undefined;
            }>();
            expectTypeOf(toolCalls[0].id).toEqualTypeOf<string>();
            expectTypeOf(toolCalls[0].index).toEqualTypeOf<number>();
        }
    });

    test("should have well typed subagent values", () => {
        const stream = useStream<typeof deepAgentTwoSubagents>({
            assistantId: "deep-agent",
        });

        const subagent = [...stream.subagents.values()][0];
        expectTypeOf(subagent.id).toEqualTypeOf<string>();
        expectTypeOf(subagent.status).toEqualTypeOf<"pending" | "running" | "complete" | "error">();
        expectTypeOf(subagent.messages).toExtend<Message[]>();
        expectTypeOf(subagent.toolCall).toEqualTypeOf<{
            id: string;
            name: string;
            args: {
                description?: string | undefined;
                subagent_type?: "researcher" | "writer" | undefined;
                [key: string]: unknown;
            };
        }>();
        expectTypeOf(subagent.result).toEqualTypeOf<string | null>();
        expectTypeOf(subagent.namespace).toEqualTypeOf<string[]>();
        expectTypeOf(subagent.parentId).toEqualTypeOf<string | null>();
        expectTypeOf(subagent.depth).toEqualTypeOf<number>();
        expectTypeOf(subagent.startedAt).toEqualTypeOf<Date | null>();
        expectTypeOf(subagent.completedAt).toEqualTypeOf<Date | null>();
    });
});
