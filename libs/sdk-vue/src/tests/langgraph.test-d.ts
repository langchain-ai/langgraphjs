/**
 * Type tests for `useStream` with `StateGraph` from `@langchain/langgraph`.
 *
 * Validates that:
 * - stream.messages is BaseMessage[] (React-specific class instances)
 * - stream.values contains the expected graph state
 * - Compiled graph streams use BaseStream (no toolCalls, no subagents)
 * - Direct state types work as fallback
 *
 * Uses mocked StateGraph types to avoid circular dependencies between
 * @langchain/langgraph-sdk and @langchain/langgraph.
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles them
 * to verify type correctness.
 */

import { describe, test, expectTypeOf } from "vitest";
import { z } from "zod/v4";
import type { BaseMessage, StoredMessage } from "@langchain/core/messages";
import {
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    ToolMessage,
    SystemMessage,
} from "@langchain/core/messages";
import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "../index.js";
import {
    MockStateGraph as StateGraph,
    MockStateSchema as StateSchema,
    MessagesValue,
    START,
    END,
} from "./fixtures/langgraph-mocks.js";

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

const ResearchGraphSchema = new StateSchema({
    messages: MessagesValue,
    topic: z.string().default(""),
    analyticalResearch: z.string().default(""),
    creativeResearch: z.string().default(""),
});

const researchGraph = new StateGraph(ResearchGraphSchema)
    .addNode(
        "dispatcher",
        async (state: typeof ResearchGraphSchema.State) => ({
            topic: String(state.messages[0]),
        })
    )
    .addNode("researcher_analytical", async () => ({
        analyticalResearch: "Analytical results",
    }))
    .addNode("researcher_creative", async () => ({
        creativeResearch: "Creative results",
    }))
    .addEdge(START, "dispatcher")
    .addEdge("dispatcher", "researcher_analytical")
    .addEdge("researcher_analytical", "researcher_creative")
    .addEdge("researcher_creative", END)
    .compile();

const ChatbotGraphSchema = new StateSchema({
    messages: MessagesValue,
    userName: z.string().default(""),
    conversationMode: z.enum(["casual", "professional", "technical"]).default("casual"),
    messageCount: z.number().default(0),
});

const chatbotGraph = new StateGraph(ChatbotGraphSchema)
    .addNode("greet", async () => ({
        messageCount: 1,
    }))
    .addNode("respond", async (state: typeof ChatbotGraphSchema.State) => ({
        messageCount: state.messageCount + 1,
    }))
    .addEdge(START, "greet")
    .addEdge("greet", "respond")
    .addEdge("respond", END)
    .compile();

const PipelineGraphSchema = new StateSchema({
    messages: MessagesValue,
    rawInput: z.string().default(""),
    parsedData: z.object({
        entities: z.array(z.string()),
        sentiment: z.enum(["positive", "negative", "neutral"]),
        confidence: z.number(),
    }).default({ entities: [], sentiment: "neutral", confidence: 0 }),
    summary: z.string().default(""),
    tags: z.array(z.string()).default([]),
});

const pipelineGraph = new StateGraph(PipelineGraphSchema)
    .addNode("parser", async (state: typeof PipelineGraphSchema.State) => ({
        rawInput: String(state.messages[0]),
        parsedData: {
            entities: ["entity1"],
            sentiment: "positive" as const,
            confidence: 0.95,
        },
    }))
    .addNode("analyzer", async () => ({
        summary: "Analysis complete",
        tags: ["important", "reviewed"],
    }))
    .addEdge(START, "parser")
    .addEdge("parser", "analyzer")
    .addEdge("analyzer", END)
    .compile();

interface BasicDirectState {
    messages: Message[];
}

interface CustomDirectState {
    messages: Message[];
    sessionId: string;
    metadata: { theme: "light" | "dark" };
}

interface ComplexDirectState {
    messages: Message[];
    settings: {
        temperature: number;
        maxTokens: number;
        model: string;
    };
    history: Array<{ role: string; content: string; timestamp: number }>;
    isActive: boolean;
}

describe("graph: stream.messages is BaseMessage[]", () => {
    test("simple graph: messages is BaseMessage[]", () => {
        const stream = useStream<typeof simpleGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.messages.value).toExtend<BaseMessage[]>();
        expectTypeOf(stream.messages.value[0]).toExtend<BaseMessage>();
    });

    test("graph messages are NOT plain Message[]", () => {
        const stream = useStream<typeof simpleGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.messages.value).not.toEqualTypeOf<Message[]>();
    });

    test("graph messages can be narrowed with type guards", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        const msg = stream.messages.value[0];
        if (AIMessage.isInstance(msg)) {
            expectTypeOf(msg).toExtend<AIMessage>();
            expectTypeOf(msg.type).toEqualTypeOf<"ai">();
            expectTypeOf(msg).toHaveProperty("tool_calls");
            expectTypeOf(msg).toHaveProperty("usage_metadata");
            expectTypeOf(msg.tool_calls).toExtend<{
                name: string;
                args: Record<string, unknown>;
                id?: string;
                type?: "tool_call";
            }[] | undefined>();
        }
        if (HumanMessage.isInstance(msg)) {
            expectTypeOf(msg).toExtend<HumanMessage>();
            expectTypeOf(msg.type).toEqualTypeOf<"human">();
        }
        if (ToolMessage.isInstance(msg)) {
            expectTypeOf(msg).toExtend<ToolMessage>();
            expectTypeOf(msg).toHaveProperty("tool_call_id");
        }
        if (SystemMessage.isInstance(msg)) {
            expectTypeOf(msg).toExtend<SystemMessage>();
            expectTypeOf(msg.type).toEqualTypeOf<"system">();
        }
        if (AIMessageChunk.isInstance(msg)) {
            expectTypeOf(msg).toExtend<AIMessageChunk>();
        }
    });

    test("graph messages have BaseMessage class methods", () => {
        const stream = useStream<typeof simpleGraph>({
            assistantId: "graph",
        });

        const msg = stream.messages.value[0];
        expectTypeOf(msg.text).toEqualTypeOf<string>();
        expectTypeOf(msg.id).toEqualTypeOf<string | undefined>();
        expectTypeOf(msg.type).toBeString();
        expectTypeOf(msg.toDict()).toEqualTypeOf<StoredMessage>();
    });

    test("graph messages can be filtered by type", () => {
        const stream = useStream<typeof simpleGraph>({
            assistantId: "graph",
        });

        const aiMessages = stream.messages.value.filter(AIMessage.isInstance);
        expectTypeOf(aiMessages).toExtend<AIMessage[]>();

        const humanMessages = stream.messages.value.filter(HumanMessage.isInstance);
        expectTypeOf(humanMessages).toExtend<HumanMessage[]>();

        const toolMessages = stream.messages.value.filter(ToolMessage.isInstance);
        expectTypeOf(toolMessages).toExtend<ToolMessage[]>();
    });

    test("graph messages text can be mapped to string[]", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        const texts = stream.messages.value.map((m) => m.text);
        expectTypeOf(texts).toEqualTypeOf<string[]>();
    });
});

describe("graph: stream.values has correct state type", () => {
    test("simple graph: values has messages", () => {
        const stream = useStream<typeof simpleGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.values.value).toHaveProperty("messages");
    });

    test("research graph: values has all custom fields", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.values.value).toHaveProperty("messages");
        expectTypeOf(stream.values.value).toHaveProperty("topic");
        expectTypeOf(stream.values.value).toHaveProperty("analyticalResearch");
        expectTypeOf(stream.values.value).toHaveProperty("creativeResearch");
        expectTypeOf(stream.values.value.topic).toEqualTypeOf<string>();
        expectTypeOf(stream.values.value.analyticalResearch).toEqualTypeOf<string>();
        expectTypeOf(stream.values.value.creativeResearch).toEqualTypeOf<string>();
    });

    test("chatbot graph: values has enum and number fields", () => {
        const stream = useStream<typeof chatbotGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.values.value).toHaveProperty("messages");
        expectTypeOf(stream.values.value).toHaveProperty("userName");
        expectTypeOf(stream.values.value).toHaveProperty("conversationMode");
        expectTypeOf(stream.values.value).toHaveProperty("messageCount");
        expectTypeOf(stream.values.value.userName).toEqualTypeOf<string>();
        expectTypeOf(stream.values.value.conversationMode).toEqualTypeOf<
            "casual" | "professional" | "technical"
        >();
        expectTypeOf(stream.values.value.messageCount).toEqualTypeOf<number>();
    });

    test("pipeline graph: values has nested object and array fields", () => {
        const stream = useStream<typeof pipelineGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.values.value).toHaveProperty("messages");
        expectTypeOf(stream.values.value).toHaveProperty("rawInput");
        expectTypeOf(stream.values.value).toHaveProperty("parsedData");
        expectTypeOf(stream.values.value).toHaveProperty("summary");
        expectTypeOf(stream.values.value).toHaveProperty("tags");

        expectTypeOf(stream.values.value.rawInput).toEqualTypeOf<string>();
        expectTypeOf(stream.values.value.summary).toEqualTypeOf<string>();
        expectTypeOf(stream.values.value.tags).toEqualTypeOf<string[]>();

        expectTypeOf(stream.values.value.parsedData.entities).toEqualTypeOf<string[]>();
        expectTypeOf(stream.values.value.parsedData.sentiment).toEqualTypeOf<
            "positive" | "negative" | "neutral"
        >();
        expectTypeOf(stream.values.value.parsedData.confidence).toEqualTypeOf<number>();
    });
});

describe("direct state types work without StateGraph", () => {
    test("basic direct state: values has messages property", () => {
        const stream = useStream<BasicDirectState>({
            assistantId: "direct",
        });

        expectTypeOf(stream.values.value).toHaveProperty("messages");
    });

    test("custom direct state: values has all fields", () => {
        const stream = useStream<CustomDirectState>({
            assistantId: "direct",
        });

        expectTypeOf(stream.values.value).toHaveProperty("messages");
        expectTypeOf(stream.values.value).toHaveProperty("sessionId");
        expectTypeOf(stream.values.value).toHaveProperty("metadata");
    });

    test("complex direct state: values has nested fields", () => {
        const stream = useStream<ComplexDirectState>({
            assistantId: "direct",
        });

        expectTypeOf(stream.values.value).toHaveProperty("messages");
        expectTypeOf(stream.values.value).toHaveProperty("settings");
        expectTypeOf(stream.values.value).toHaveProperty("history");
        expectTypeOf(stream.values.value).toHaveProperty("isActive");
    });

    test("direct state: messages is still BaseMessage[]", () => {
        const stream = useStream<BasicDirectState>({
            assistantId: "direct",
        });

        expectTypeOf(stream.messages.value).toExtend<BaseMessage[]>();
        expectTypeOf(stream.messages.value).not.toEqualTypeOf<Message[]>();
    });
});

describe("graph streams do not have agent-specific features", () => {
    test("compiled graph does not have toolCalls", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream).not.toHaveProperty("toolCalls");
    });

    test("compiled graph does not have getToolCalls", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream).not.toHaveProperty("getToolCalls");
    });

    test("compiled graph does not have subagents", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream).not.toHaveProperty("subagents");
    });

    test("compiled graph does not have getSubagentsByType", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream).not.toHaveProperty("getSubagentsByType");
    });

    test("compiled graph does not have activeSubagents", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream).not.toHaveProperty("activeSubagents");
    });

    test("compiled graph does not have getSubagent", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream).not.toHaveProperty("getSubagent");
    });

    test("direct state type also does not have agent features", () => {
        const stream = useStream<BasicDirectState>({
            assistantId: "direct",
        });

        expectTypeOf(stream).not.toHaveProperty("toolCalls");
        expectTypeOf(stream).not.toHaveProperty("subagents");
        expectTypeOf(stream).not.toHaveProperty("getSubagentsByType");
    });
});

describe("graph: core stream properties", () => {
    test("isLoading is boolean", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.isLoading.value).toEqualTypeOf<boolean>();
    });

    test("isThreadLoading is boolean", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.isThreadLoading.value).toEqualTypeOf<boolean>();
    });

    test("error is unknown", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.error.value).toEqualTypeOf<unknown>();
    });

    test("stop returns Promise<void>", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.stop()).toEqualTypeOf<Promise<void>>();
    });

    test("submit returns Promise<void>", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.submit(null)).toEqualTypeOf<Promise<void>>();
    });

    test("branch is string", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.branch.value).toEqualTypeOf<string>();
    });

    test("setBranch accepts string", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.setBranch).toBeCallableWith("main");
    });

    test("assistantId is string", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.assistantId.value).toEqualTypeOf<string>();
    });

    test("joinStream is a function", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.joinStream).toBeFunction();
    });
});

describe("graph: getMessagesMetadata accepts BaseMessage", () => {
    test("getMessagesMetadata works with compiled graph messages", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        const msg = stream.messages.value[0];
        const metadata = stream.getMessagesMetadata(msg, 0);
        if (metadata) {
            expectTypeOf(metadata.messageId).toEqualTypeOf<string>();
            expectTypeOf(metadata.branch).toEqualTypeOf<string | undefined>();
            expectTypeOf(metadata.branchOptions).toEqualTypeOf<
                string[] | undefined
            >();
        }
    });

    test("getMessagesMetadata works with direct state type", () => {
        const stream = useStream<BasicDirectState>({
            assistantId: "direct",
        });

        const msg = stream.messages.value[0];
        const metadata = stream.getMessagesMetadata(msg, 0);
        if (metadata) {
            expectTypeOf(metadata.messageId).toEqualTypeOf<string>();
        }
    });
});

describe("graph: interrupt support", () => {
    test("interrupt is available on graph stream", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream).toHaveProperty("interrupt");
        expectTypeOf(stream).toHaveProperty("interrupts");
    });

    test("interrupt has id property", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        if (stream.interrupt) {
            expectTypeOf(stream.interrupt).toHaveProperty("value");
        }
    });

    test("interrupts is an array", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.interrupts.value).toBeArray();
    });
});

describe("realistic StateGraph usage patterns", () => {
    test("render research pipeline state", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        const { topic } = stream.values.value;
        expectTypeOf(topic).toEqualTypeOf<string>();

        const analytical = stream.values.value.analyticalResearch;
        expectTypeOf(analytical).toEqualTypeOf<string>();

        const creative = stream.values.value.creativeResearch;
        expectTypeOf(creative).toEqualTypeOf<string>();

        for (const msg of stream.messages.value) {
            expectTypeOf(msg).toExtend<BaseMessage>();
            expectTypeOf(msg.text).toEqualTypeOf<string>();
        }
    });

    test("render chatbot with mode switching", () => {
        const stream = useStream<typeof chatbotGraph>({
            assistantId: "graph",
        });

        const mode = stream.values.value.conversationMode;
        if (mode === "casual") {
            expectTypeOf(mode).toEqualTypeOf<"casual">();
        }
        if (mode === "professional") {
            expectTypeOf(mode).toEqualTypeOf<"professional">();
        }
        if (mode === "technical") {
            expectTypeOf(mode).toEqualTypeOf<"technical">();
        }

        expectTypeOf(stream.values.value.messageCount).toEqualTypeOf<number>();
    });

    test("render pipeline with nested parsed data", () => {
        const stream = useStream<typeof pipelineGraph>({
            assistantId: "graph",
        });

        const { entities, sentiment, confidence } = stream.values.value.parsedData;
        expectTypeOf(entities).toEqualTypeOf<string[]>();
        expectTypeOf(sentiment).toEqualTypeOf<
            "positive" | "negative" | "neutral"
        >();
        expectTypeOf(confidence).toEqualTypeOf<number>();

        for (const tag of stream.values.value.tags) {
            expectTypeOf(tag).toEqualTypeOf<string>();
        }
    });

    test("submit with graph state values", () => {
        const stream = useStream<typeof researchGraph>({
            assistantId: "graph",
        });

        expectTypeOf(stream.submit).toBeCallableWith(
            { messages: [{ type: "human", content: "Research AI" }] },
            undefined
        );
    });

    test("serialize messages to plain dicts", () => {
        const stream = useStream<typeof simpleGraph>({
            assistantId: "graph",
        });

        const dicts = stream.messages.value.map((m) => m.toDict());
        expectTypeOf(dicts).toEqualTypeOf<StoredMessage[]>();
    });

    test("extract AI messages with tool calls from graph", () => {
        const stream = useStream<typeof simpleGraph>({
            assistantId: "graph",
        });

        const aiMessages = stream.messages.value.filter(AIMessage.isInstance);
        for (const ai of aiMessages) {
            expectTypeOf(ai.type).toEqualTypeOf<"ai">();
            if (ai.tool_calls && ai.tool_calls.length > 0) {
                const tc = ai.tool_calls[0];
                expectTypeOf(tc).toHaveProperty("name");
                expectTypeOf(tc).toHaveProperty("args");
            }
        }
    });
});
