/**
 * Type tests for useStream hook and related type inference utilities.
 *
 * These tests validate that the type system correctly infers state types,
 * tool call types, and subagent types from actual LangChain primitives.
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles them
 * to verify type correctness. This allows us to test the type inference
 * system without needing working LLM integrations.
 */

import { describe, test, expectTypeOf } from "vitest";
import { z } from "zod/v4";
import {
  StateGraph,
  START,
  END,
  StateSchema,
  MessagesValue,
} from "@langchain/langgraph";
import { createAgent, tool, createMiddleware } from "langchain";
import { createDeepAgent } from "deepagents";

import { useStream } from "../react/stream.js";
import type { Message } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";
import type {
  InferAgentState,
  InferAgentToolCalls,
  InferMiddlewareStatesFromArray,
  ExtractAgentConfig,
  InferSubagentState,
  InferSubagentNames,
  SubagentStateMap,
} from "../ui/types.js";
import type { ResolveStreamOptions } from "../ui/stream/index.js";

// ============================================================================
// Tool Definitions
// ============================================================================

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
  async ({
    to,
  }: {
    to: string;
    subject: string;
    body: string;
  }) => {
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

// ============================================================================
// Middleware Definitions
// ============================================================================

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

// ============================================================================
// Agent Definitions
// ============================================================================

// Simple agent with no middleware
const simpleAgent = createAgent({
  model: "gpt-4o-mini",
  tools: [getWeather],
  systemPrompt: "You are a helpful assistant.",
});

// Agent with multiple tools
const multiToolAgent = createAgent({
  model: "gpt-4o-mini",
  tools: [getWeather, searchWeb, sendEmail],
  systemPrompt: "You are a helpful assistant with multiple capabilities.",
});

// Agent with middleware
const agentWithMiddleware = createAgent({
  model: "gpt-4o-mini",
  tools: [getWeather],
  middleware: [todoListMiddleware],
  systemPrompt: "You are a helpful assistant that tracks todos.",
});

// Agent with multiple middlewares
const agentWithMultipleMiddleware = createAgent({
  model: "gpt-4o-mini",
  tools: [searchWeb],
  middleware: [todoListMiddleware, filesMiddleware, counterMiddleware],
  systemPrompt: "You are an assistant with todos, files, and counters.",
});

// Agent with custom state schema
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
  systemPrompt: "You are an assistant with custom state.",
});

// ============================================================================
// Deep Agent Definitions
// ============================================================================

const researcherSubagent = {
  name: "researcher" as const,
  description: "Researches topics and gathers information",
  systemPrompt: "You are a research specialist.",
  tools: [searchWeb],
  middleware: [filesMiddleware],
};

const writerSubagent = {
  name: "writer" as const,
  description: "Writes content based on research",
  systemPrompt: "You are a professional writer.",
  tools: [sendEmail],
  middleware: [todoListMiddleware],
};

const deepAgent = createDeepAgent({
  model: "gpt-4o-mini",
  tools: [getWeather],
  subagents: [researcherSubagent, writerSubagent],
  systemPrompt: "You coordinate research and writing tasks.",
});

// ============================================================================
// StateGraph Definitions
// ============================================================================

const GraphStateSchema = new StateSchema({
  messages: MessagesValue,
  topic: z.string().default(""),
  analyticalResearch: z.string().default(""),
  creativeResearch: z.string().default(""),
});

const compiledGraph = new StateGraph(GraphStateSchema)
  .addNode("dispatcher", async (state: typeof GraphStateSchema.State) => ({
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

// ============================================================================
// Type Tests: Middleware State Inference
// ============================================================================

describe("InferMiddlewareStatesFromArray", () => {
  test("extracts state from single middleware", () => {
    type Middlewares = readonly [typeof todoListMiddleware];
    type Result = InferMiddlewareStatesFromArray<Middlewares>;

    expectTypeOf<Result>().toHaveProperty("todos");
    expectTypeOf<Result["todos"]>().toMatchTypeOf<Todo[]>();
  });

  test("merges states from multiple middlewares", () => {
    type Middlewares = readonly [
      typeof todoListMiddleware,
      typeof counterMiddleware,
    ];
    type Result = InferMiddlewareStatesFromArray<Middlewares>;

    expectTypeOf<Result>().toHaveProperty("todos");
    expectTypeOf<Result>().toHaveProperty("count");
    expectTypeOf<Result["todos"]>().toMatchTypeOf<Todo[]>();
    expectTypeOf<Result["count"]>().toEqualTypeOf<number>();
  });

  test("returns empty object for empty middleware array", () => {
    type Middlewares = readonly [];
    type Result = InferMiddlewareStatesFromArray<Middlewares>;
    // eslint-disable-next-line @typescript-eslint/ban-types
    expectTypeOf<Result>().toEqualTypeOf<{}>();
  });
});

// ============================================================================
// Type Tests: Agent State Inference
// ============================================================================

describe("InferAgentState", () => {
  test("infers state with messages from simple agent", () => {
    type State = InferAgentState<typeof simpleAgent>;

    expectTypeOf<State>().toHaveProperty("messages");
    expectTypeOf<State["messages"]>().toExtend<Message<{
      name: "get_weather";
      args: {
        location: string;
      };
      id?: string;
      type?: "tool_call";
    }>[]>();
  });

  test("infers middleware state from agent with middleware", () => {
    type State = InferAgentState<typeof agentWithMiddleware>;

    expectTypeOf<State>().toHaveProperty("messages");
    expectTypeOf<State>().toHaveProperty("todos");
    expectTypeOf<State["todos"]>().toMatchTypeOf<Todo[]>();
  });

  test("infers merged state from agent with multiple middlewares", () => {
    type State = InferAgentState<typeof agentWithMultipleMiddleware>;

    expectTypeOf<State>().toHaveProperty("messages");
    expectTypeOf<State>().toHaveProperty("todos");
    expectTypeOf<State>().toHaveProperty("files");
    expectTypeOf<State>().toHaveProperty("count");
    expectTypeOf<State["count"]>().toEqualTypeOf<number>();
  });

  test("infers custom state schema from agent", () => {
    type State = InferAgentState<typeof agentWithCustomState>;

    expectTypeOf<State>().toHaveProperty("messages");
    expectTypeOf<State>().toHaveProperty("sessionId");
    expectTypeOf<State>().toHaveProperty("preferences");
    expectTypeOf<State["sessionId"]>().toEqualTypeOf<string>();
    expectTypeOf<State["preferences"]>().toEqualTypeOf<{
      theme: "light" | "dark";
      language: string;
    }>();
  });

  test("infers state from CompiledStateGraph", () => {
    type State = InferAgentState<typeof compiledGraph>;

    expectTypeOf<State>().toHaveProperty("messages");
    expectTypeOf<State>().toHaveProperty("topic");
    expectTypeOf<State>().toHaveProperty("analyticalResearch");
    expectTypeOf<State>().toHaveProperty("creativeResearch");
    expectTypeOf<State["topic"]>().toEqualTypeOf<string>();
  });
});

// ============================================================================
// Type Tests: Tool Call Inference
// ============================================================================

describe("InferAgentToolCalls", () => {
  test("infers single tool call type", () => {
    type ToolCalls = InferAgentToolCalls<typeof simpleAgent>;

    // The tool call name should be the literal type "get_weather"
    expectTypeOf<ToolCalls["name"]>().toEqualTypeOf<"get_weather">();
    expectTypeOf<ToolCalls["args"]>().toEqualTypeOf<{ location: string }>();
  });

  test("infers union of tool call types from multiple tools", () => {
    type ToolCalls = InferAgentToolCalls<typeof multiToolAgent>;

    // Name should be a union of all tool names
    expectTypeOf<ToolCalls["name"]>().toEqualTypeOf<
      "get_weather" | "search_web" | "send_email"
    >();
  });

  test("tool calls have optional id property", () => {
    type ToolCalls = InferAgentToolCalls<typeof simpleAgent>;

    expectTypeOf<ToolCalls>().toHaveProperty("id");
    type IdType = ToolCalls["id"];
    expectTypeOf<string | undefined>().toMatchTypeOf<IdType>();
  });
});

// ============================================================================
// Type Tests: Agent Config Extraction
// ============================================================================

describe("ExtractAgentConfig", () => {
  test("extracts config from simple agent", () => {
    type Config = ExtractAgentConfig<typeof simpleAgent>;

    expectTypeOf<Config>().toHaveProperty("Response");
    expectTypeOf<Config>().toHaveProperty("State");
    expectTypeOf<Config>().toHaveProperty("Context");
    expectTypeOf<Config>().toHaveProperty("Middleware");
    expectTypeOf<Config>().toHaveProperty("Tools");
  });

  test("returns never for non-agent types", () => {
    type Result = ExtractAgentConfig<{ notAnAgent: true }>;
    expectTypeOf<Result>().toEqualTypeOf<never>();
  });
});

// ============================================================================
// Type Tests: Deep Agent Subagent Inference
// ============================================================================

describe("Deep Agent Subagent Types", () => {
  test("infers subagent names from deep agent", () => {
    type Names = InferSubagentNames<typeof deepAgent>;

    expectTypeOf<Names>().toEqualTypeOf<"researcher" | "writer">();
  });

  test("infers subagent state including middleware", () => {
    type ResearcherState = InferSubagentState<typeof deepAgent, "researcher">;

    expectTypeOf<ResearcherState>().toHaveProperty("messages");
    expectTypeOf<ResearcherState>().toHaveProperty("files");
  });

  test("infers different state for different subagents", () => {
    type WriterState = InferSubagentState<typeof deepAgent, "writer">;

    expectTypeOf<WriterState>().toHaveProperty("messages");
    expectTypeOf<WriterState>().toHaveProperty("todos");
  });

  test("creates subagent state map", () => {
    type StateMap = SubagentStateMap<typeof deepAgent>;

    expectTypeOf<StateMap>().toHaveProperty("researcher");
    expectTypeOf<StateMap>().toHaveProperty("writer");
    expectTypeOf<StateMap["researcher"]>().toHaveProperty("files");
    expectTypeOf<StateMap["writer"]>().toHaveProperty("todos");
  });
});

// ============================================================================
// Type Tests: useStream with different agent types
// ============================================================================

describe("useStream resolves correct interface by agent type", () => {
  test("useStream with createAgent returns agent stream interface", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "agent",
    });

    // Agent stream should have toolCalls
    expectTypeOf(stream).toHaveProperty("toolCalls");
    expectTypeOf(stream).toHaveProperty("getToolCalls");
    expectTypeOf(stream).toHaveProperty("values");
    expectTypeOf(stream).toHaveProperty("messages");
    expectTypeOf(stream).toHaveProperty("submit");
    expectTypeOf(stream).toHaveProperty("stop");
    expectTypeOf(stream).toHaveProperty("isLoading");
    expectTypeOf(stream).toHaveProperty("error");
  });

  test("useStream with createDeepAgent returns deep agent stream interface", () => {
    const stream = useStream<typeof deepAgent>({
      assistantId: "deep-agent",
    });

    // Deep agent stream should have subagent methods
    expectTypeOf(stream).toHaveProperty("subagents");
    expectTypeOf(stream).toHaveProperty("activeSubagents");
    expectTypeOf(stream).toHaveProperty("getSubagent");
    expectTypeOf(stream).toHaveProperty("getSubagentsByType");

    // And also tool call methods
    expectTypeOf(stream).toHaveProperty("toolCalls");
    expectTypeOf(stream).toHaveProperty("getToolCalls");
  });

  test("useStream with StateGraph returns graph stream interface", () => {
    const stream = useStream<typeof compiledGraph>({
      assistantId: "graph",
    });

    // Graph stream should have base properties
    expectTypeOf(stream).toHaveProperty("values");
    expectTypeOf(stream).toHaveProperty("messages");
    expectTypeOf(stream).toHaveProperty("submit");
    expectTypeOf(stream).toHaveProperty("nodes");
    expectTypeOf(stream).toHaveProperty("activeNodes");
    expectTypeOf(stream).toHaveProperty("getNodeStream");
    expectTypeOf(stream).toHaveProperty("getNodeStreamsByName");
  });

  test("useStream with middleware agent includes middleware state", () => {
    const stream = useStream<typeof agentWithMiddleware>({
      assistantId: "middleware-agent",
    });

    expectTypeOf(stream.values).toHaveProperty("messages");
    expectTypeOf(stream.values).toHaveProperty("todos");
  });

  test("useStream with multi-tool agent has typed tool calls", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "multi-tool-agent",
    });

    const toolCall = stream.toolCalls[0].call;
    expectTypeOf(toolCall.name).toEqualTypeOf<
      "get_weather" | "search_web" | "send_email"
    >();
  });
});

// ============================================================================
// Type Tests: Stream Options Resolution
// ============================================================================

describe("ResolveStreamOptions", () => {
  test("graph stream options have base options", () => {
    type Options = ResolveStreamOptions<typeof compiledGraph, BagTemplate>;

    expectTypeOf<Options>().toHaveProperty("assistantId");
    expectTypeOf<Options>().toHaveProperty("apiUrl");
    expectTypeOf<Options>().toHaveProperty("threadId");
    expectTypeOf<Options>().toHaveProperty("onThreadId");
    expectTypeOf<Options>().toHaveProperty("messagesKey");
  });

  test("agent stream options have subagentToolNames", () => {
    type Options = ResolveStreamOptions<typeof simpleAgent, BagTemplate>;

    expectTypeOf<Options>().toHaveProperty("assistantId");
    expectTypeOf<Options>().toHaveProperty("subagentToolNames");
  });

  test("deep agent stream options have filterSubagentMessages", () => {
    type Options = ResolveStreamOptions<typeof deepAgent, BagTemplate>;

    expectTypeOf<Options>().toHaveProperty("filterSubagentMessages");

    type FilterType = Options extends { filterSubagentMessages?: infer F }
      ? F
      : never;
    expectTypeOf<FilterType>().toEqualTypeOf<boolean>();
  });

  test("graph options do NOT have agent-specific options", () => {
    type Options = ResolveStreamOptions<typeof compiledGraph, BagTemplate>;

    type HasSubagentToolNames = Options extends { subagentToolNames?: unknown }
      ? true
      : false;
    expectTypeOf<HasSubagentToolNames>().toEqualTypeOf<false>();

    type HasFilterSubagent = Options extends {
      filterSubagentMessages?: unknown;
    }
      ? true
      : false;
    expectTypeOf<HasFilterSubagent>().toEqualTypeOf<false>();
  });
});

// ============================================================================
// Type Tests: Node Stream Inference
// ============================================================================

describe("Node Stream Types", () => {
  test("InferNodeNames extracts node names from graph", () => {
    const stream = useStream<typeof compiledGraph>({
      assistantId: "graph",
    });

    // Node names should be narrowed to the specific node queried
    const nodeStreams = stream.getNodeStreamsByName("dispatcher");
    expectTypeOf(nodeStreams[0].name).toEqualTypeOf<"dispatcher">();
  });

  test("stream has typed nodes map", () => {
    const stream = useStream<typeof compiledGraph>({
      assistantId: "graph",
    });

    expectTypeOf(stream.nodes).toMatchTypeOf<Map<string, unknown>>();
  });

  test("node stream has correct properties", () => {
    const stream = useStream<typeof compiledGraph>({
      assistantId: "graph",
    });

    const nodeStream = stream.getNodeStream("some-id");
    if (nodeStream) {
      expectTypeOf(nodeStream).toHaveProperty("id");
      expectTypeOf(nodeStream).toHaveProperty("name");
      expectTypeOf(nodeStream).toHaveProperty("messages");
      expectTypeOf(nodeStream).toHaveProperty("values");
      expectTypeOf(nodeStream).toHaveProperty("update");
      expectTypeOf(nodeStream).toHaveProperty("status");
      expectTypeOf(nodeStream).toHaveProperty("isLoading");
      expectTypeOf(nodeStream).toHaveProperty("startedAt");
      expectTypeOf(nodeStream).toHaveProperty("completedAt");

      // Verify specific types
      expectTypeOf(nodeStream.id).toEqualTypeOf<string>();
      expectTypeOf(nodeStream.isLoading).toEqualTypeOf<boolean>();
      expectTypeOf(nodeStream.messages).toBeArray();
    }
  });

  test("activeNodes is an array of NodeStream", () => {
    const stream = useStream<typeof compiledGraph>({
      assistantId: "graph",
    });

    expectTypeOf(stream.activeNodes).toBeArray();

    // Each active node should have expected properties
    const activeNode = stream.activeNodes[0];
    expectTypeOf(activeNode.name).toEqualTypeOf<
      "dispatcher" | "researcher_analytical" | "researcher_creative"
    >();
  });

  test("getNodeStreamsByName returns array", () => {
    const stream = useStream<typeof compiledGraph>({
      assistantId: "graph",
    });

    const nodeStreams = stream.getNodeStreamsByName("dispatcher");
    expectTypeOf(nodeStreams).toBeArray();
  });
});

// ============================================================================
// Type Tests: State Type Inference via useStream.values
// ============================================================================

describe("useStream.values state inference", () => {
  test("infers state from agent with middleware", () => {
    const stream = useStream<typeof agentWithMiddleware>({
      assistantId: "agent",
    });

    expectTypeOf(stream.values).toHaveProperty("messages");
    expectTypeOf(stream.values).toHaveProperty("todos");
  });

  test("infers state from deep agent", () => {
    const stream = useStream<typeof deepAgent>({
      assistantId: "deep-agent",
    });

    expectTypeOf(stream.values).toHaveProperty("messages");
  });

  test("infers state from compiled graph", () => {
    const stream = useStream<typeof compiledGraph>({
      assistantId: "graph",
    });

    expectTypeOf(stream.values).toHaveProperty("messages");
    expectTypeOf(stream.values).toHaveProperty("topic");
    expectTypeOf(stream.values).toHaveProperty("analyticalResearch");
    expectTypeOf(stream.values.topic).toEqualTypeOf<string>();
  });

  test("passes through direct state types", () => {
    type DirectState = { messages: Message[]; customField: string };

    const stream = useStream<DirectState>({
      assistantId: "direct",
    });

    expectTypeOf(stream.values).toEqualTypeOf<DirectState>();
    expectTypeOf(stream.values.customField).toEqualTypeOf<string>();
  });
});

describe("useStream type inference integration", () => {
  test("complete workflow: agent with middleware and tools", () => {
    const stream = useStream<typeof agentWithMiddleware>({
      assistantId: "some-agent",
    })

    // Verify state has both base and middleware state
    expectTypeOf(stream.values).toHaveProperty("messages");
    expectTypeOf(stream.values).toHaveProperty("todos");
    expectTypeOf(stream).not.toHaveProperty("getSubagentsByType");

    // Verify tool calls are typed
    const toolCallType = stream.toolCalls[0].call
    expectTypeOf(toolCallType.name).toEqualTypeOf<"get_weather">();
    expectTypeOf(toolCallType.args).toEqualTypeOf<{ location: string }>();

    // Verify we can access todo properties through values
    const todoFromState = stream.values.todos[0];
    expectTypeOf(todoFromState.id).toEqualTypeOf<string>();
    expectTypeOf(todoFromState.status).toEqualTypeOf<
      "pending" | "in_progress" | "completed" | "cancelled"
    >();
  });

  test("complete workflow: deep agent with typed subagents", () => {
    const stream = useStream<typeof deepAgent>({
      assistantId: "some-agent",
    });

    // Verify deep agent has subagent methods
    expectTypeOf(stream).toHaveProperty("getSubagentsByType");
    expectTypeOf(stream).toHaveProperty("subagents");
    expectTypeOf(stream).toHaveProperty("activeSubagents");
    expectTypeOf(stream).toHaveProperty("getSubagent");

    // Verify subagents map exists and has correct type
    expectTypeOf(stream.subagents).toMatchTypeOf<Map<string, unknown>>();

    // Verify activeSubagents is an array
    expectTypeOf(stream.activeSubagents).toBeArray();

    // Verify getSubagent returns SubagentStream or undefined
    const subagent = stream.getSubagent("some-id");
    expectTypeOf(subagent).toBeNullable();
    if (subagent) {
      expectTypeOf(subagent).toHaveProperty("id");
      expectTypeOf(subagent).toHaveProperty("messages");
      expectTypeOf(subagent).toHaveProperty("isLoading");
      expectTypeOf(subagent.id).toEqualTypeOf<string>();
    }
  });

  test("complete workflow: StateGraph with node streaming", () => {
    const stream = useStream<typeof compiledGraph>({
      assistantId: "some-graph",
    });

    // Verify graph-specific state
    expectTypeOf(stream.values).toHaveProperty("topic");
    expectTypeOf(stream.values).toHaveProperty("analyticalResearch");
    expectTypeOf(stream.values).toHaveProperty("creativeResearch");
    expectTypeOf(stream.values.topic).toEqualTypeOf<string>();

    // Verify node streaming methods exist
    expectTypeOf(stream).toHaveProperty("nodes");
    expectTypeOf(stream).toHaveProperty("activeNodes");
    expectTypeOf(stream).toHaveProperty("getNodeStream");
    expectTypeOf(stream).toHaveProperty("getNodeStreamsByName");

    // Verify nodes map
    expectTypeOf(stream.nodes).toMatchTypeOf<Map<string, unknown>>();
    expectTypeOf([...stream.nodes.values()][0].name).toEqualTypeOf<"dispatcher" | "researcher_analytical" | "researcher_creative">();
    expectTypeOf([...stream.nodes.values()][0].values).toEqualTypeOf<Record<string, unknown>>();

    // Verify activeNodes is an array
    expectTypeOf(stream.activeNodes).toBeArray();

    // Verify getNodeStreamsByName returns array with narrowed name and values types
    // @ts-expect-error - not a node name
    stream.getNodeStreamsByName("not-a-node");
    const dispatcherStreams = stream.getNodeStreamsByName("dispatcher");
    expectTypeOf(dispatcherStreams).toBeArray();
    expectTypeOf(dispatcherStreams[0].name).toEqualTypeOf<"dispatcher">();
    // values is typed to what the dispatcher node returns
    expectTypeOf(dispatcherStreams[0].values).toEqualTypeOf<{ topic: string }>();

    // Verify other nodes have their own typed values
    const analyticalStreams =
      stream.getNodeStreamsByName("researcher_analytical");
    expectTypeOf(analyticalStreams[0].name).toEqualTypeOf<
      "researcher_analytical"
    >();
    expectTypeOf(analyticalStreams[0].values).toEqualTypeOf<{
      analyticalResearch: string;
    }>();
    // update is Partial<NodeValues> | undefined
    expectTypeOf(analyticalStreams[0].update).toEqualTypeOf<
      { analyticalResearch?: string } | undefined
    >();

    const creativeStreams = stream.getNodeStreamsByName("researcher_creative");
    expectTypeOf(creativeStreams[0].name).toEqualTypeOf<"researcher_creative">();
    expectTypeOf(creativeStreams[0].values).toEqualTypeOf<{
      creativeResearch: string;
    }>();

    // Verify node stream has expected properties
    const nodeStream = stream.getNodeStream("some-id");
    if (nodeStream) {
      expectTypeOf(nodeStream.id).toEqualTypeOf<string>();
      expectTypeOf(nodeStream.name).toEqualTypeOf<
        "dispatcher" | "researcher_analytical" | "researcher_creative"
      >();
      expectTypeOf(nodeStream.isLoading).toEqualTypeOf<boolean>();
      expectTypeOf(nodeStream.messages).toBeArray();
    }
  });

  test("simple agent without middleware", () => {
    const stream = useStream<typeof simpleAgent>({
      assistantId: "simple-agent",
    });

    // Verify basic stream properties
    expectTypeOf(stream.values).toHaveProperty("messages");
    expectTypeOf(stream.isLoading).toEqualTypeOf<boolean>();
    expectTypeOf(stream.error).toMatchTypeOf<unknown>();

    // Verify tool calls are typed
    const toolCall = stream.toolCalls[0];
    expectTypeOf(toolCall.call.name).toEqualTypeOf<"get_weather">();
    expectTypeOf(toolCall.call.args).toEqualTypeOf<{ location: string }>();

    // Verify submit and stop methods exist
    expectTypeOf(stream).toHaveProperty("submit");
    expectTypeOf(stream).toHaveProperty("stop");
  });

  test("agent with multiple tools has union type for tool calls", () => {
    const stream = useStream<typeof multiToolAgent>({
      assistantId: "multi-tool-agent",
    });

    // Tool call name should be a union of all tool names
    const toolCall = stream.toolCalls[0].call;
    expectTypeOf(toolCall.name).toEqualTypeOf<
      "get_weather" | "search_web" | "send_email"
    >();
  });

  test("agent with custom state schema", () => {
    const stream = useStream<typeof agentWithCustomState>({
      assistantId: "custom-state-agent",
    });

    // Verify custom state properties
    expectTypeOf(stream.values).toHaveProperty("sessionId");
    expectTypeOf(stream.values).toHaveProperty("preferences");
    expectTypeOf(stream.values.sessionId).toEqualTypeOf<string>();
    expectTypeOf(stream.values.preferences.theme).toEqualTypeOf<
      "light" | "dark"
    >();
    expectTypeOf(stream.values.preferences.language).toEqualTypeOf<string>();
  });
});
