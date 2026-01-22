import { describe, test, expectTypeOf } from "vitest";
import { z } from "zod/v4";
import type { Message } from "../types.messages.js";
import type {
  InferAgentState,
  InferAgentToolCalls,
  InferMiddlewareStatesFromArray,
  AgentTypeConfigLike,
  ExtractAgentConfig,
  AgentMiddlewareLike,
} from "../ui/types.js";

// Todo schema for middleware tests
const todoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
});

// Schemas for middleware state
const todosStateSchema = z.object({ todos: z.array(todoSchema) });
const counterStateSchema = z.object({ count: z.number() });
const filesStateSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});

// Schemas for tools
const getWeatherArgsSchema = z.object({ location: z.string() });
const searchArgsSchema = z.object({ query: z.string() });

// Schemas for agent state
const customStateSchema = z.object({
  sessionId: z.string(),
  preferences: z.object({ theme: z.string() }),
});
const agentStateSchema = z.object({ customField: z.string() });
const configStateSchema = z.object({ userId: z.string() });

type Todo = z.infer<typeof todoSchema>;
type TodosState = z.infer<typeof todosStateSchema>;
type FilesState = z.infer<typeof filesStateSchema>;

// Mock middleware structure using real Zod schemas (simple version for backwards compatibility)
interface MockMiddleware<TStateSchema extends z.ZodTypeAny> {
  name: string;
  stateSchema: TStateSchema;
}

// Mock tool structure using real Zod schemas
interface MockTool<TName extends string, TArgsSchema extends z.ZodTypeAny> {
  name: TName;
  _call: (args: z.infer<TArgsSchema>) => Promise<string>;
  schema: TArgsSchema;
}

// Mock ReactAgent structure (matches langchain's ReactAgent)
interface MockReactAgent<TConfig extends AgentTypeConfigLike> {
  "~agentTypes": TConfig;
  invoke: (input: { messages: Message[] }) => Promise<unknown>;
}

describe("InferMiddlewareStatesFromArray", () => {
  test("extracts state from single middleware", () => {
    type TodoMiddleware = MockMiddleware<typeof todosStateSchema>;
    type Middlewares = readonly [TodoMiddleware];

    type Result = InferMiddlewareStatesFromArray<Middlewares>;
    expectTypeOf<Result>().toEqualTypeOf<TodosState>();
  });

  test("merges states from multiple middlewares", () => {
    type TodoMiddleware = MockMiddleware<typeof todosStateSchema>;
    type CounterMiddleware = MockMiddleware<typeof counterStateSchema>;
    type Middlewares = readonly [TodoMiddleware, CounterMiddleware];

    type Result = InferMiddlewareStatesFromArray<Middlewares>;
    expectTypeOf<Result>().toExtend<{ todos: Todo[]; count: number }>();
  });

  test("returns empty object for empty middleware array", () => {
    type Middlewares = readonly [];
    type Result = InferMiddlewareStatesFromArray<Middlewares>;
    // eslint-disable-next-line @typescript-eslint/ban-types
    expectTypeOf<Result>().toEqualTypeOf<{}>();
  });

  test("handles middleware without stateSchema", () => {
    type MiddlewareWithoutState = { name: string };
    type Middlewares = readonly [MiddlewareWithoutState];
    type Result = InferMiddlewareStatesFromArray<Middlewares>;
    // eslint-disable-next-line @typescript-eslint/ban-types
    expectTypeOf<Result>().toEqualTypeOf<{}>();
  });

  test("extracts state from AgentMiddleware-like structure with ~middlewareTypes", () => {
    // This matches the actual structure of langchain's AgentMiddleware
    type LocationMiddleware = AgentMiddlewareLike<typeof counterStateSchema>;
    type Middlewares = readonly [LocationMiddleware];

    type Result = InferMiddlewareStatesFromArray<Middlewares>;
    expectTypeOf<Result>().toExtend<{ count: number }>();
  });

  test("merges states from multiple AgentMiddleware-like middlewares", () => {
    type TodoMiddleware = AgentMiddlewareLike<typeof todosStateSchema>;
    type CounterMiddleware = AgentMiddlewareLike<typeof counterStateSchema>;
    type Middlewares = readonly [TodoMiddleware, CounterMiddleware];

    type Result = InferMiddlewareStatesFromArray<Middlewares>;
    expectTypeOf<Result>().toExtend<{ todos: Todo[]; count: number }>();
  });
});

describe("InferAgentState", () => {
  test("extracts middleware states from agent", () => {
    type TodoMiddleware = MockMiddleware<typeof todosStateSchema>;

    type AgentConfig = {
      Response: Record<string, unknown>;
      State: undefined;
      Context: unknown;
      Middleware: readonly [TodoMiddleware];
      Tools: readonly [];
    };

    type Agent = MockReactAgent<AgentConfig>;
    type Result = InferAgentState<Agent>;

    expectTypeOf<Result>().toExtend<TodosState>();
  });

  test("combines agent state schema with middleware states", () => {
    type TodoMiddleware = MockMiddleware<typeof todosStateSchema>;

    type AgentConfig = {
      Response: Record<string, unknown>;
      State: typeof agentStateSchema;
      Context: unknown;
      Middleware: readonly [TodoMiddleware];
      Tools: readonly [];
    };

    type Agent = MockReactAgent<AgentConfig>;
    type Result = InferAgentState<Agent>;

    expectTypeOf<Result>().toExtend<{
      customField: string;
      todos: Todo[];
    }>();
  });

  test("returns empty object for non-agent types", () => {
    type Result = InferAgentState<{ someProperty: string }>;
    // eslint-disable-next-line @typescript-eslint/ban-types
    expectTypeOf<Result>().toEqualTypeOf<{}>();
  });
});

describe("InferAgentToolCalls", () => {
  test("extracts tool calls from agent tools", () => {
    type GetWeatherTool = MockTool<"get_weather", typeof getWeatherArgsSchema>;
    type SearchTool = MockTool<"search", typeof searchArgsSchema>;

    type AgentConfig = {
      Response: Record<string, unknown>;
      State: undefined;
      Context: unknown;
      Middleware: readonly [];
      Tools: readonly [GetWeatherTool, SearchTool];
    };

    type Agent = MockReactAgent<AgentConfig>;
    type Result = InferAgentToolCalls<Agent>;

    // Should be a union of tool call types
    expectTypeOf<Result>().toExtend<
      | { name: "get_weather"; args: { location: string }; id?: string }
      | { name: "search"; args: { query: string }; id?: string }
    >();
  });
});

describe("ExtractAgentConfig", () => {
  test("extracts config from agent type", () => {
    type AgentConfig = {
      Response: { result: string };
      State: typeof configStateSchema;
      Context: unknown;
      Middleware: readonly [];
      Tools: readonly [];
    };

    type Agent = MockReactAgent<AgentConfig>;
    type Result = ExtractAgentConfig<Agent>;

    expectTypeOf<Result>().toEqualTypeOf<AgentConfig>();
  });

  test("returns never for non-agent types", () => {
    type Result = ExtractAgentConfig<{ notAnAgent: true }>;
    expectTypeOf<Result>().toEqualTypeOf<never>();
  });

  test("correctly accesses Middleware from agent with AgentMiddleware-like middleware", () => {
    // This test simulates the real structure from langchain's createAgent
    type WeatherMiddleware = AgentMiddlewareLike<typeof counterStateSchema>;
    type AgentConfig = {
      Response: Record<string, unknown>;
      State: undefined;
      Context: unknown;
      Middleware: readonly [WeatherMiddleware];
      Tools: readonly [];
    };

    type Agent = MockReactAgent<AgentConfig>;
    type Config = ExtractAgentConfig<Agent>;

    // Verify Middleware is correctly extracted
    expectTypeOf<Config["Middleware"]>().toEqualTypeOf<
      readonly [WeatherMiddleware]
    >();

    // Verify full state inference works through InferAgentState
    type State = InferAgentState<Agent>;
    expectTypeOf<State>().toExtend<{ count: number; messages: Message[] }>();
  });
});

describe("useStream type inference integration", () => {
  test("infers complete state type from agent with todoListMiddleware", () => {
    // Use real Zod schemas for middleware and tools
    type TodoMiddleware = MockMiddleware<typeof todosStateSchema>;
    type GetWeatherTool = MockTool<"get_weather", typeof getWeatherArgsSchema>;

    // Simulate agent config as createDeepAgent would create it
    type AgentConfig = {
      Response: Record<string, unknown>;
      State: undefined;
      Context: unknown;
      Middleware: readonly [TodoMiddleware];
      Tools: readonly [GetWeatherTool];
    };

    type Agent = MockReactAgent<AgentConfig>;

    // This is what useStream<typeof agent> should infer
    type StreamState = InferAgentState<Agent>;

    // Verify messages are present
    expectTypeOf<StreamState["messages"]>().toExtend<Message[]>();

    // Verify todos from middleware are present
    expectTypeOf<StreamState["todos"]>().toExtend<Todo[]>();

    // Verify we can access todo properties
    type TodoFromState = StreamState["todos"][number];
    expectTypeOf<TodoFromState["id"]>().toEqualTypeOf<string>();
    expectTypeOf<TodoFromState["content"]>().toEqualTypeOf<string>();
    expectTypeOf<TodoFromState["status"]>().toEqualTypeOf<
      "pending" | "in_progress" | "completed" | "cancelled"
    >();
  });

  test("infers state from agent with multiple middlewares", () => {
    type TodoMiddleware = MockMiddleware<typeof todosStateSchema>;
    type FilesMiddleware = MockMiddleware<typeof filesStateSchema>;

    type AgentConfig = {
      Response: Record<string, unknown>;
      State: undefined;
      Context: unknown;
      Middleware: readonly [TodoMiddleware, FilesMiddleware];
      Tools: readonly [];
    };

    type Agent = MockReactAgent<AgentConfig>;
    type StreamState = InferAgentState<Agent>;

    // Both middleware states should be present
    expectTypeOf<StreamState["todos"]>().toExtend<Todo[]>();
    expectTypeOf<StreamState["files"]>().toExtend<FilesState["files"]>();
  });

  test("infers state from agent with custom stateSchema", () => {
    type TodoMiddleware = MockMiddleware<typeof todosStateSchema>;

    type AgentConfig = {
      Response: Record<string, unknown>;
      State: typeof customStateSchema;
      Context: unknown;
      Middleware: readonly [TodoMiddleware];
      Tools: readonly [];
    };

    type Agent = MockReactAgent<AgentConfig>;
    type StreamState = InferAgentState<Agent>;

    // Custom state should be present
    expectTypeOf<StreamState["sessionId"]>().toEqualTypeOf<string>();
    expectTypeOf<StreamState["preferences"]>().toEqualTypeOf<{
      theme: string;
    }>();

    // Middleware state should also be present
    expectTypeOf<StreamState["todos"]>().toExtend<Todo[]>();
  });

  test("preserves behavior for non-agent types (CompiledGraph)", () => {
    type GraphOutput = {
      messages: Message[];
      customData: string;
    };

    type Graph = {
      "~RunOutput": GraphOutput;
    };

    type StreamState = InferAgentState<Graph>;

    // Should return the RunOutput type directly
    expectTypeOf<StreamState>().toEqualTypeOf<GraphOutput>();
  });

  test("preserves behavior for direct state types", () => {
    type DirectState = {
      messages: Message[];
      myField: number;
    };

    type StreamState = InferAgentState<DirectState>;

    // Should return the type as-is
    expectTypeOf<StreamState>().toEqualTypeOf<DirectState>();
  });
});
