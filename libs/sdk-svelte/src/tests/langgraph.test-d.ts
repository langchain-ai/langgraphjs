/**
 * Type tests for `useStream` with `StateGraph` from `@langchain/langgraph`.
 *
 * Validates that:
 * - stream.messages is Readable<BaseMessage[]> (Svelte-specific class instances)
 * - stream.values is Readable<StateType> containing the expected graph state
 * - Compiled graph streams use BaseStream (no toolCalls, no subagents)
 * - Direct state types work as fallback
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles them
 * to verify type correctness.
 */

import { describe, test, expectTypeOf } from "vitest";
import { z } from "zod/v4";
import { get } from "svelte/store";
import type { Readable } from "svelte/store";
import type { BaseMessage, StoredMessage } from "@langchain/core/messages";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  StateGraph,
  StateSchema,
  MessagesValue,
  START,
  END,
} from "@langchain/langgraph";
import { useStream } from "../index.js";

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
  .addNode("dispatcher", async (state: typeof ResearchGraphSchema.State) => ({
    topic: String(state.messages[0]),
  }))
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
  conversationMode: z
    .enum(["casual", "professional", "technical"])
    .default("casual"),
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
  parsedData: z
    .object({
      entities: z.array(z.string()),
      sentiment: z.enum(["positive", "negative", "neutral"]),
      confidence: z.number(),
    })
    .default({ entities: [], sentiment: "neutral", confidence: 0 }),
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
  messages: BaseMessage[];
}

interface CustomDirectState {
  messages: BaseMessage[];
  sessionId: string;
  metadata: { theme: "light" | "dark" };
}

interface ComplexDirectState {
  messages: BaseMessage[];
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

    expectTypeOf(stream.messages).toExtend<Readable<BaseMessage[]>>();
    expectTypeOf(get(stream.messages)).toExtend<BaseMessage[]>();
    expectTypeOf(get(stream.messages)[0]).toExtend<BaseMessage>();
  });

  test("graph messages can be narrowed with type guards", () => {
    const stream = useStream<typeof researchGraph>({
      assistantId: "graph",
    });

    const msg = get(stream.messages)[0];
    if (AIMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<AIMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"ai">();
      expectTypeOf(msg).toHaveProperty("tool_calls");
      expectTypeOf(msg).toHaveProperty("usage_metadata");
      expectTypeOf(msg.tool_calls).toExtend<
        | {
            name: string;
            args: Record<string, unknown>;
            id?: string;
            type?: "tool_call";
          }[]
        | undefined
      >();
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

    const msg = get(stream.messages)[0];
    expectTypeOf(msg.text).toEqualTypeOf<string>();
    expectTypeOf(msg.id).toEqualTypeOf<string | undefined>();
    expectTypeOf(msg.getType()).toBeString();
    expectTypeOf(msg.toDict()).toEqualTypeOf<StoredMessage>();
  });

  test("graph messages can be filtered by type", () => {
    const stream = useStream<typeof simpleGraph>({
      assistantId: "graph",
    });

    const aiMessages = get(stream.messages).filter(AIMessage.isInstance);
    expectTypeOf(aiMessages).toExtend<AIMessage[]>();

    const humanMessages = get(stream.messages).filter(HumanMessage.isInstance);
    expectTypeOf(humanMessages).toExtend<HumanMessage[]>();

    const toolMessages = get(stream.messages).filter(ToolMessage.isInstance);
    expectTypeOf(toolMessages).toExtend<ToolMessage[]>();
  });

  test("graph messages text can be mapped to string[]", () => {
    const stream = useStream<typeof researchGraph>({
      assistantId: "graph",
    });

    const texts = get(stream.messages).map((m) => m.text);
    expectTypeOf(texts).toEqualTypeOf<string[]>();
  });
});

describe("graph: stream.values has correct state type", () => {
  test("simple graph: values has messages", () => {
    const stream = useStream<typeof simpleGraph>({
      assistantId: "graph",
    });

    expectTypeOf(get(stream.values)).toHaveProperty("messages");
  });

  test("research graph: values has all custom fields", () => {
    const stream = useStream<typeof researchGraph>({
      assistantId: "graph",
    });

    expectTypeOf(get(stream.values)).toHaveProperty("messages");
    expectTypeOf(get(stream.values)).toHaveProperty("topic");
    expectTypeOf(get(stream.values)).toHaveProperty("analyticalResearch");
    expectTypeOf(get(stream.values)).toHaveProperty("creativeResearch");
    expectTypeOf(get(stream.values).topic).toEqualTypeOf<string>();
    expectTypeOf(get(stream.values).analyticalResearch).toEqualTypeOf<string>();
    expectTypeOf(get(stream.values).creativeResearch).toEqualTypeOf<string>();
  });

  test("chatbot graph: values has enum and number fields", () => {
    const stream = useStream<typeof chatbotGraph>({
      assistantId: "graph",
    });

    expectTypeOf(get(stream.values)).toHaveProperty("messages");
    expectTypeOf(get(stream.values)).toHaveProperty("userName");
    expectTypeOf(get(stream.values)).toHaveProperty("conversationMode");
    expectTypeOf(get(stream.values)).toHaveProperty("messageCount");
    expectTypeOf(get(stream.values).userName).toEqualTypeOf<string>();
    expectTypeOf(get(stream.values).conversationMode).toEqualTypeOf<
      "casual" | "professional" | "technical"
    >();
    expectTypeOf(get(stream.values).messageCount).toEqualTypeOf<number>();
  });

  test("pipeline graph: values has nested object and array fields", () => {
    const stream = useStream<typeof pipelineGraph>({
      assistantId: "graph",
    });

    expectTypeOf(get(stream.values)).toHaveProperty("messages");
    expectTypeOf(get(stream.values)).toHaveProperty("rawInput");
    expectTypeOf(get(stream.values)).toHaveProperty("parsedData");
    expectTypeOf(get(stream.values)).toHaveProperty("summary");
    expectTypeOf(get(stream.values)).toHaveProperty("tags");

    expectTypeOf(get(stream.values).rawInput).toEqualTypeOf<string>();
    expectTypeOf(get(stream.values).summary).toEqualTypeOf<string>();
    expectTypeOf(get(stream.values).tags).toEqualTypeOf<string[]>();

    expectTypeOf(get(stream.values).parsedData.entities).toEqualTypeOf<
      string[]
    >();
    expectTypeOf(get(stream.values).parsedData.sentiment).toEqualTypeOf<
      "positive" | "negative" | "neutral"
    >();
    expectTypeOf(
      get(stream.values).parsedData.confidence,
    ).toEqualTypeOf<number>();
  });
});

describe("direct state types work without StateGraph", () => {
  test("basic direct state: values has messages property", () => {
    const stream = useStream<BasicDirectState>({
      assistantId: "direct",
    });

    expectTypeOf(get(stream.values)).toHaveProperty("messages");
  });

  test("custom direct state: values has all fields", () => {
    const stream = useStream<CustomDirectState>({
      assistantId: "direct",
    });

    expectTypeOf(get(stream.values)).toHaveProperty("messages");
    expectTypeOf(get(stream.values)).toHaveProperty("sessionId");
    expectTypeOf(get(stream.values)).toHaveProperty("metadata");
  });

  test("complex direct state: values has nested fields", () => {
    const stream = useStream<ComplexDirectState>({
      assistantId: "direct",
    });

    expectTypeOf(get(stream.values)).toHaveProperty("messages");
    expectTypeOf(get(stream.values)).toHaveProperty("settings");
    expectTypeOf(get(stream.values)).toHaveProperty("history");
    expectTypeOf(get(stream.values)).toHaveProperty("isActive");
  });

  test("direct state: messages is still BaseMessage[]", () => {
    const stream = useStream<BasicDirectState>({
      assistantId: "direct",
    });

    expectTypeOf(get(stream.messages)).toExtend<BaseMessage[]>();
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

    expectTypeOf(get(stream.isLoading)).toEqualTypeOf<boolean>();
  });

  test("isThreadLoading is boolean", () => {
    const stream = useStream<typeof researchGraph>({
      assistantId: "graph",
    });

    expectTypeOf(get(stream.isThreadLoading)).toEqualTypeOf<boolean>();
  });

  test("error is unknown", () => {
    const stream = useStream<typeof researchGraph>({
      assistantId: "graph",
    });

    expectTypeOf(get(stream.error)).toEqualTypeOf<unknown>();
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

    expectTypeOf(get(stream.branch)).toEqualTypeOf<string>();
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

    expectTypeOf(stream.assistantId).toEqualTypeOf<string>();
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

    const msg = get(stream.messages)[0];
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

    const msg = get(stream.messages)[0];
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

    const interruptValue = get(stream.interrupt);
    if (interruptValue) {
      expectTypeOf(interruptValue).toHaveProperty("id");
      expectTypeOf(interruptValue).toHaveProperty("value");
    }
  });

  test("interrupts is an array", () => {
    const stream = useStream<typeof researchGraph>({
      assistantId: "graph",
    });

    expectTypeOf(get(stream.interrupts)).toBeArray();
  });
});

describe("realistic StateGraph usage patterns", () => {
  test("render research pipeline state", () => {
    const stream = useStream<typeof researchGraph>({
      assistantId: "graph",
    });

    const { topic } = get(stream.values);
    expectTypeOf(topic).toEqualTypeOf<string>();

    const analytical = get(stream.values).analyticalResearch;
    expectTypeOf(analytical).toEqualTypeOf<string>();

    const creative = get(stream.values).creativeResearch;
    expectTypeOf(creative).toEqualTypeOf<string>();

    for (const msg of get(stream.messages)) {
      expectTypeOf(msg).toExtend<BaseMessage>();
      expectTypeOf(msg.text).toEqualTypeOf<string>();
    }
  });

  test("render chatbot with mode switching", () => {
    const stream = useStream<typeof chatbotGraph>({
      assistantId: "graph",
    });

    const mode = get(stream.values).conversationMode;
    if (mode === "casual") {
      expectTypeOf(mode).toEqualTypeOf<"casual">();
    }
    if (mode === "professional") {
      expectTypeOf(mode).toEqualTypeOf<"professional">();
    }
    if (mode === "technical") {
      expectTypeOf(mode).toEqualTypeOf<"technical">();
    }

    expectTypeOf(get(stream.values).messageCount).toEqualTypeOf<number>();
  });

  test("render pipeline with nested parsed data", () => {
    const stream = useStream<typeof pipelineGraph>({
      assistantId: "graph",
    });

    const { entities, sentiment, confidence } = get(stream.values).parsedData;
    expectTypeOf(entities).toEqualTypeOf<string[]>();
    expectTypeOf(sentiment).toEqualTypeOf<
      "positive" | "negative" | "neutral"
    >();
    expectTypeOf(confidence).toEqualTypeOf<number>();

    for (const tag of get(stream.values).tags) {
      expectTypeOf(tag).toEqualTypeOf<string>();
    }
  });

  test("submit with graph state values", () => {
    const stream = useStream<typeof researchGraph>({
      assistantId: "graph",
    });

    expectTypeOf(stream.submit).toBeCallableWith(
      { messages: [new HumanMessage("Research AI")] },
      undefined,
    );
  });

  test("serialize messages to plain dicts", () => {
    const stream = useStream<typeof simpleGraph>({
      assistantId: "graph",
    });

    const dicts = get(stream.messages).map((m) => m.toDict());
    expectTypeOf(dicts).toEqualTypeOf<StoredMessage[]>();
  });

  test("extract AI messages with tool calls from graph", () => {
    const stream = useStream<typeof simpleGraph>({
      assistantId: "graph",
    });

    const aiMessages = get(stream.messages).filter(AIMessage.isInstance);
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
