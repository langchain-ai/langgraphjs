import { z } from "zod/v4";
import { describe, test, expectTypeOf } from "vitest";
import { createAgent, tool, createMiddleware } from "langchain";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { useStream, type ToolCallState } from "../index.js";

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
  }
);

const createFile = tool(
  async ({
    path,
  }: {
    path: string;
    content: string;
    overwrite: boolean;
  }) => {
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
  }
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
      })
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

const fourToolAgent = createAgent({
  model: "gpt-4o-mini",
  tools: [getWeather, searchWeb, sendEmail, createFile],
  systemPrompt: "Multi-purpose assistant.",
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

    expectTypeOf(stream.messages.value).toExtend<BaseMessage[]>();
    expectTypeOf(stream.messages.value[0]).toExtend<BaseMessage>();
  });

  test("multi-tool agent: messages is BaseMessage[]", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages.value).toExtend<BaseMessage[]>();
  });

  test("agent with middleware: messages is BaseMessage[]", () => {
    const stream = useStream<typeof agentWithMiddleware>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages.value).toExtend<BaseMessage[]>();
  });

  test("messages can be narrowed with type guards", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
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

    const aiMessages = stream.messages.value.filter(AIMessage.isInstance);
    expectTypeOf(aiMessages).toExtend<AIMessage[]>();

    const humanMessages = stream.messages.value.filter(HumanMessage.isInstance);
    expectTypeOf(humanMessages).toExtend<HumanMessage[]>();
  });

  test("messages have BaseMessage methods available", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
    expectTypeOf(msg.text).toEqualTypeOf<string>();
    expectTypeOf(msg.id).toEqualTypeOf<string | undefined>();
    expectTypeOf(msg.type).toBeString();
    expectTypeOf(msg.toDict()).toHaveProperty("type");
  });

  test("getMessagesMetadata accepts BaseMessage", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const msg = stream.messages.value[0];
    const metadata = stream.getMessagesMetadata(msg, 0);
    if (metadata) {
      expectTypeOf(metadata.messageId).toEqualTypeOf<string>();
    }
  });
});

describe("stream.toolCalls has correct types from agent tools", () => {
  test("single tool: call.name is literal type", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls.value[0];
    expectTypeOf(tc.call.name).toEqualTypeOf<"get_weather">();
  });

  test("single tool: call.args is correctly typed", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls.value[0];
    expectTypeOf(tc.call.args).toEqualTypeOf<{ location: string }>();
  });

  test("multiple tools: call.name is union of tool names", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls.value[0];
    expectTypeOf(tc.call.name).toEqualTypeOf<
      "get_weather" | "search_web" | "send_email"
    >();
  });

  test("four tools: call.name is full union", () => {
    const stream = useStream<typeof fourToolAgent>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls.value[0];
    expectTypeOf(tc.call.name).toEqualTypeOf<
      "get_weather" | "search_web" | "send_email" | "create_file"
    >();
  });

  test("toolCalls has ToolCallWithResult structure", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls.value[0];
    expectTypeOf(tc.id).toEqualTypeOf<string>();
    expectTypeOf(tc.call).not.toBeNever();
    expectTypeOf(tc.result).toBeNullable();
    expectTypeOf(tc.index).toEqualTypeOf<number>();
    expectTypeOf(tc.state).toEqualTypeOf<ToolCallState>();
  });

  test("toolCalls state is the expected union", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls.value[0];
    expectTypeOf(tc.state).toEqualTypeOf<
      "pending" | "completed" | "error"
    >();
  });

  test("toolCall.call has optional id and type", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls.value[0];
    expectTypeOf(tc.call).toHaveProperty("id");
    expectTypeOf(tc.call).toHaveProperty("type");
    type IdType = (typeof tc.call)["id"];
    expectTypeOf<string | undefined>().toMatchTypeOf<IdType>();
  });

  test("getToolCalls returns typed ToolCallWithResult array", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.getToolCalls).toBeFunction();
  });

  test("agent with middleware still has typed toolCalls", () => {
    const stream = useStream<typeof agentWithMiddleware>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls.value[0];
    expectTypeOf(tc.call.name).toEqualTypeOf<"get_weather">();
    expectTypeOf(tc.call.args).toEqualTypeOf<{ location: string }>();
  });

  test("agent with multiple middleware has typed toolCalls", () => {
    const stream = useStream<typeof agentWithMultipleMiddleware>({
      assistantId: "agent",
    });

    const tc = stream.toolCalls.value[0];
    expectTypeOf(tc.call.name).toEqualTypeOf<
      "search_web" | "create_file"
    >();
  });
});

describe("stream.values contains the expected agent state", () => {
  test("simple agent: values has messages", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values.value).toHaveProperty("messages");
  });

  test("agent with middleware: values includes middleware state", () => {
    const stream = useStream<typeof agentWithMiddleware>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values.value).toHaveProperty("messages");
    expectTypeOf(stream.values.value).toHaveProperty("todos");
    expectTypeOf(stream.values.value.todos).toMatchTypeOf<Todo[]>();
  });

  test("agent with middleware: todo items have correct shape", () => {
    const stream = useStream<typeof agentWithMiddleware>({
      assistantId: "agent",
    });

    const todo = stream.values.value.todos[0];
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

    expectTypeOf(stream.values.value).toHaveProperty("messages");
    expectTypeOf(stream.values.value).toHaveProperty("todos");
    expectTypeOf(stream.values.value).toHaveProperty("files");
    expectTypeOf(stream.values.value).toHaveProperty("count");
    expectTypeOf(stream.values.value.count).toEqualTypeOf<number>();
    expectTypeOf(stream.values.value.files).toMatchTypeOf<
      { path: string; content: string }[]
    >();
  });

  test("agent with custom state: values includes custom fields", () => {
    const stream = useStream<typeof agentWithCustomState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values.value).toHaveProperty("messages");
    expectTypeOf(stream.values.value).toHaveProperty("sessionId");
    expectTypeOf(stream.values.value).toHaveProperty("preferences");
    expectTypeOf(stream.values.value.sessionId).toEqualTypeOf<string>();
    expectTypeOf(stream.values.value.preferences.theme).toEqualTypeOf<
      "light" | "dark"
    >();
    expectTypeOf(stream.values.value.preferences.language).toEqualTypeOf<string>();
  });

  test("agent with custom state + middleware: both are merged", () => {
    const stream = useStream<typeof agentWithCustomStateAndMiddleware>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values.value).toHaveProperty("messages");
    expectTypeOf(stream.values.value).toHaveProperty("projectName");
    expectTypeOf(stream.values.value).toHaveProperty("priority");
    expectTypeOf(stream.values.value).toHaveProperty("todos");
    expectTypeOf(stream.values.value).toHaveProperty("files");
    expectTypeOf(stream.values.value.projectName).toEqualTypeOf<string>();
    expectTypeOf(stream.values.value.priority).toEqualTypeOf<
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

  test("simple agent does not have subagents map", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream).not.toHaveProperty("subagents");
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
    expectTypeOf(stream).not.toHaveProperty("subagents");
  });
});

describe("core stream properties are correctly typed", () => {
  test("isLoading is boolean", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.isLoading.value).toEqualTypeOf<boolean>();
  });

  test("error is unknown", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.error.value).toEqualTypeOf<unknown>();
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

  test("branch is string", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.branch.value).toEqualTypeOf<string>();
  });

  test("assistantId is string", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.assistantId.value).toEqualTypeOf<string>();
  });

  test("setBranch accepts string", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.setBranch).toBeCallableWith("main");
  });

  test("isThreadLoading is boolean", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.isThreadLoading.value).toEqualTypeOf<boolean>();
  });
});

describe("realistic usage patterns with createAgent", () => {
  test("complete workflow: render tool calls by name", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "agent",
    });

    for (const tc of stream.toolCalls.value) {
      if (tc.call.name === "get_weather") {
        expectTypeOf(tc.call.args).toEqualTypeOf<{ location: string }>();
      }
      if (tc.call.name === "search_web") {
        expectTypeOf(tc.call.args).toHaveProperty("query");
        expectTypeOf(tc.call.args.query).toEqualTypeOf<string>();
      }
      if (tc.call.name === "send_email") {
        expectTypeOf(tc.call.args).toEqualTypeOf<{
          to: string;
          subject: string;
          body: string;
        }>();
      }

      expectTypeOf(tc.state).toEqualTypeOf<ToolCallState>();
      if (tc.result) {
        expectTypeOf(tc.result.type).toEqualTypeOf<"tool">();
        expectTypeOf(tc.result.tool_call_id).toEqualTypeOf<string>();
      }
    }
  });

  test("iterate messages and extract text", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    const texts = stream.messages.value.map((m) => m.text);
    expectTypeOf(texts).toEqualTypeOf<string[]>();
  });

  test("access middleware state alongside messages", () => {
    const stream = useStream<typeof agentWithMultipleMiddleware>({
      assistantId: "agent",
    });

    const pendingTodos = stream.values.value.todos.filter(
      (t) => t.status === "pending"
    );
    expectTypeOf(pendingTodos).toMatchTypeOf<Todo[]>();

    const fileCount = stream.values.value.files.length;
    expectTypeOf(fileCount).toEqualTypeOf<number>();

    const currentCount = stream.values.value.count;
    expectTypeOf(currentCount).toEqualTypeOf<number>();
  });

  test("submit with agent state update", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    expectTypeOf(stream.submit).toBeCallableWith(
      { messages: [{ type: "human", content: "Hello" }] },
      undefined
    );
  });
});
