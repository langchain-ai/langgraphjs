import { z } from "zod/v4";
import { describe, test, expectTypeOf } from "vitest";
import { createAgent, tool, createMiddleware } from "langchain";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import {
  useMessageMetadata,
  useStream,
  type AssembledToolCall,
} from "../index.js";

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

const sendEmail = tool(
  async ({ to }: { to: string; subject: string; body: string }) => {
    return `Email sent to ${to}`;
  },
  {
    name: "send_email",
    description: "Send an email",
    schema: z.object({
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body"),
    }),
  },
);

const createFile = tool(
  async ({ path }: { path: string; content: string; overwrite: boolean }) => {
    return `Created ${path}`;
  },
  {
    name: "create_file",
    description: "Create a file with content",
    schema: z.object({
      path: z.string(),
      content: z.string(),
      overwrite: z.boolean().default(false),
    }),
  },
);

const todoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
});

type Todo = z.infer<typeof todoSchema>;

const todoListMiddleware = createMiddleware({
  name: "todoList",
  stateSchema: z.object({
    todos: z.array(todoSchema),
  }),
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

const counterMiddleware = createMiddleware({
  name: "counter",
  stateSchema: z.object({
    count: z.number(),
  }),
});

const simpleAgent = createAgent({
  model: "gpt-4o-mini",
  tools: [getWeather],
  systemPrompt: "You are a helpful weather assistant.",
});

const multiToolAgent = createAgent({
  model: "gpt-4o-mini",
  tools: [getWeather, searchWeb, sendEmail],
  systemPrompt: "You are a helpful assistant with multiple capabilities.",
});

const agentWithMiddleware = createAgent({
  model: "gpt-4o-mini",
  tools: [getWeather],
  middleware: [todoListMiddleware],
  systemPrompt: "You are a helpful assistant that tracks todos.",
});

const agentWithMultipleMiddleware = createAgent({
  model: "gpt-4o-mini",
  tools: [searchWeb, createFile],
  middleware: [todoListMiddleware, filesMiddleware, counterMiddleware],
  systemPrompt: "Assistant with todos, files, and counters.",
});

const customStateSchema = z.object({
  sessionId: z.string(),
  preferences: z.object({
    theme: z.enum(["light", "dark"]),
    language: z.string(),
  }),
});

const agentWithCustomState = createAgent({
  model: "gpt-4o-mini",
  tools: [getWeather],
  stateSchema: customStateSchema,
  systemPrompt: "Assistant with custom state.",
});

const agentWithCustomStateAndMiddleware = createAgent({
  model: "gpt-4o-mini",
  tools: [searchWeb],
  stateSchema: z.object({
    projectName: z.string(),
    priority: z.enum(["low", "medium", "high"]),
  }),
  middleware: [todoListMiddleware, filesMiddleware],
  systemPrompt: "Project assistant.",
});

describe("stream.messages contains BaseMessage class instances", () => {
  test("simple agent: messages is BaseMessage[]", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages).toExtend<BaseMessage[]>();
    expectTypeOf(stream.messages[0]).toExtend<BaseMessage>();
  });

  test("multi-tool agent: messages is BaseMessage[]", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages).toExtend<BaseMessage[]>();
  });

  test("agent with middleware: messages is BaseMessage[]", () => {
    const stream = useStream<typeof agentWithMiddleware>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages).toExtend<BaseMessage[]>();
  });

  test("messages can be narrowed with type guards", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (AIMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<AIMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"ai">();
      expectTypeOf(msg).toHaveProperty("tool_calls");
    }
    if (HumanMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<HumanMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"human">();
    }
  });

  test("filtering messages by type produces correct arrays", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "agent",
    });

    const aiMessages = stream.messages.filter(AIMessage.isInstance);
    expectTypeOf(aiMessages).toExtend<AIMessage[]>();

    const humanMessages = stream.messages.filter(HumanMessage.isInstance);
    expectTypeOf(humanMessages).toExtend<HumanMessage[]>();
  });

  test("messages have BaseMessage methods available", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.text).toEqualTypeOf<string>();
    expectTypeOf(msg.id).toEqualTypeOf<string | undefined>();
    expectTypeOf(msg.type).toBeString();
    expectTypeOf(msg.toDict()).toHaveProperty("type");
  });

  test("useMessageMetadata accepts BaseMessage ids", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    const metadata = useMessageMetadata(stream, () => msg.id);
    if (metadata.current) {
      expectTypeOf(metadata.current.parentCheckpointId).toEqualTypeOf<
        string | undefined
      >();
    }
  });
});

describe("stream.toolCalls exposes assembled protocol tool calls", () => {
  test("tool call has v2 assembled shape", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls[0];
    expectTypeOf(tc).toExtend<AssembledToolCall>();
    expectTypeOf(tc.name).toEqualTypeOf<string>();
    expectTypeOf(tc.callId).toEqualTypeOf<string>();
    expectTypeOf(tc.namespace).toEqualTypeOf<string[]>();
    expectTypeOf(tc.input).toEqualTypeOf<unknown>();
    expectTypeOf(tc.output).toEqualTypeOf<Promise<unknown>>();
    expectTypeOf(tc.status).toExtend<Promise<unknown>>();
    expectTypeOf(tc.error).toEqualTypeOf<Promise<string | undefined>>();
  });

  test("toolCalls is an assembled tool-call array", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.toolCalls).toExtend<AssembledToolCall[]>();
  });
});

describe("stream.values contains the expected agent state", () => {
  test("simple agent: values has messages", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values).toHaveProperty("messages");
  });

  test("agent with middleware: values includes middleware state", () => {
    const stream = useStream<typeof agentWithMiddleware>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values).toHaveProperty("messages");
    expectTypeOf(stream.values).toHaveProperty("todos");
    expectTypeOf(stream.values.todos).toMatchTypeOf<Todo[]>();
  });

  test("agent with middleware: todo items have correct shape", () => {
    const stream = useStream<typeof agentWithMiddleware>({
      assistantId: "agent",
    });

    const todo = stream.values.todos[0];
    expectTypeOf(todo.id).toEqualTypeOf<string>();
    expectTypeOf(todo.content).toEqualTypeOf<string>();
    expectTypeOf(todo.status).toEqualTypeOf<
      "pending" | "in_progress" | "completed" | "cancelled"
    >();
  });

  test("agent with multiple middlewares: values has all middleware state", () => {
    const stream = useStream<typeof agentWithMultipleMiddleware>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values).toHaveProperty("messages");
    expectTypeOf(stream.values).toHaveProperty("todos");
    expectTypeOf(stream.values).toHaveProperty("files");
    expectTypeOf(stream.values).toHaveProperty("count");
    expectTypeOf(stream.values.count).toEqualTypeOf<number>();
    expectTypeOf(stream.values.files).toMatchTypeOf<
      { path: string; content: string }[]
    >();
  });

  test("agent with custom state: values includes custom fields", () => {
    const stream = useStream<typeof agentWithCustomState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values).toHaveProperty("messages");
    expectTypeOf(stream.values).toHaveProperty("sessionId");
    expectTypeOf(stream.values).toHaveProperty("preferences");
    expectTypeOf(stream.values.sessionId).toEqualTypeOf<string>();
    expectTypeOf(stream.values.preferences.theme).toEqualTypeOf<
      "light" | "dark"
    >();
    expectTypeOf(stream.values.preferences.language).toEqualTypeOf<string>();
  });

  test("agent with custom state + middleware: both are merged", () => {
    const stream = useStream<typeof agentWithCustomStateAndMiddleware>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values).toHaveProperty("messages");
    expectTypeOf(stream.values).toHaveProperty("projectName");
    expectTypeOf(stream.values).toHaveProperty("priority");
    expectTypeOf(stream.values).toHaveProperty("todos");
    expectTypeOf(stream.values).toHaveProperty("files");
    expectTypeOf(stream.values.projectName).toEqualTypeOf<string>();
    expectTypeOf(stream.values.priority).toEqualTypeOf<
      "low" | "medium" | "high"
    >();
  });
});

describe("agent streams exclude deep agent features", () => {
  test("simple agent does not have getSubagentsByType", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream).not.toHaveProperty("getSubagentsByType");
  });

  test("simple agent still exposes subagent discovery map", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream).toHaveProperty("subagents");
  });

  test("simple agent does not have activeSubagents", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream).not.toHaveProperty("activeSubagents");
  });

  test("simple agent does not have getSubagent", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream).not.toHaveProperty("getSubagent");
  });

  test("agent with middleware does not have subagent features", () => {
    const stream = useStream<typeof agentWithMultipleMiddleware>({
      assistantId: "agent",
    });

    expectTypeOf(stream).not.toHaveProperty("getSubagentsByType");
  });
});

describe("core stream properties are correctly typed", () => {
  test("isLoading is boolean", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.isLoading).toEqualTypeOf<boolean>();
  });

  test("error is unknown", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.error).toEqualTypeOf<unknown>();
  });

  test("stop returns Promise<void>", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.stop()).toEqualTypeOf<Promise<void>>();
  });

  test("submit returns Promise<void>", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.submit(null)).toEqualTypeOf<Promise<void>>();
  });

  test("assistantId is string", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.assistantId).toEqualTypeOf<string>();
  });

  test("isThreadLoading is boolean", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.isThreadLoading).toEqualTypeOf<boolean>();
  });
});

describe("realistic usage patterns with createAgent", () => {
  test("complete workflow: render assembled tool calls", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "agent",
    });

    for (const tc of stream.toolCalls) {
      expectTypeOf(tc.name).toEqualTypeOf<string>();
      expectTypeOf(tc.input).toEqualTypeOf<unknown>();
      expectTypeOf(tc.output).toEqualTypeOf<Promise<unknown>>();
    }
  });

  test("iterate messages and extract text", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const texts = stream.messages.map((m) => m.text);
    expectTypeOf(texts).toEqualTypeOf<string[]>();
  });

  test("access middleware state alongside messages", () => {
    const stream = useStream<typeof agentWithMultipleMiddleware>({
      assistantId: "agent",
    });

    const pendingTodos = stream.values.todos.filter(
      (t) => t.status === "pending",
    );
    expectTypeOf(pendingTodos).toMatchTypeOf<Todo[]>();

    const fileCount = stream.values.files.length;
    expectTypeOf(fileCount).toEqualTypeOf<number>();

    const currentCount = stream.values.count;
    expectTypeOf(currentCount).toEqualTypeOf<number>();
  });

  test("submit with agent state update", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.submit).toBeCallableWith(
      { messages: [{ type: "human", content: "Hello" }] },
      undefined,
    );
  });

  test("submit accepts @langchain/core HumanMessage instances", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.submit).toBeCallableWith(
      { messages: [new HumanMessage("Hello")] },
      undefined,
    );

    expectTypeOf(stream.submit).toBeCallableWith(
      { messages: new HumanMessage("Hello") },
      undefined,
    );
  });

  test("toolCalls[] exposes protocol fields", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls[0];
    expectTypeOf(tc.callId).toEqualTypeOf<string>();
    expectTypeOf(tc.namespace).toEqualTypeOf<string[]>();
  });

  test("toolCalls is the selector-backed tool-call array", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.toolCalls).toBeArray();
  });
});
