import { describe, it, expect } from "vitest";
import { z } from "zod";
import { StateGraph } from "../graph/state.js";
import { END, START } from "../constants.js";
import { _AnyIdAIMessage, _AnyIdHumanMessage } from "./utils.js";
import {
  getOutputTypeSchema,
  getInputTypeSchema,
  getUpdateTypeSchema,
  getStateTypeSchema,
} from "../graph/zod/schema.js";
import { MessagesZodState } from "../graph/messages_annotation.js";
import { withLangGraph, schemaMetaRegistry } from "../graph/zod/meta.js";

describe("StateGraph with Zod schemas", () => {
  it("should accept Zod schema as input in addNode", async () => {
    // Create a Zod schema for the state
    const stateSchema = z.object({
      messages: z.array(z.string()),
      count: z.number(),
    });

    // Create a node that uses a different Zod schema for input (still retains messages)
    const processNodeInputSchema = z.object({
      messages: z.array(z.string()),
      query: z.string(),
    });

    type ProcessNodeInput = z.infer<typeof processNodeInputSchema>;

    const graph = new StateGraph(stateSchema)
      .addNode("addQuery", (state) => {
        return {
          query: `${state.messages[0]} as a query`,
        };
      })
      .addNode(
        "process",
        (input: ProcessNodeInput) => {
          // input should be typed according to the node's input schema
          expect(input.messages).toBeDefined();
          // query should be brought over from the previous node
          expect(input.query).toBeDefined();
          // @ts-expect-error count is not in the node's input schema, but we still want to check that it's not in the input
          expect(input.count).toBeUndefined();
          return {
            messages: [...input.messages, "processed"],
            query: "Not in the output",
          };
        },
        { input: processNodeInputSchema }
      )
      .addEdge(START, "addQuery")
      .addEdge("addQuery", "process")
      .addEdge("process", END)
      .compile();

    const result = await graph.invoke({ messages: ["hello"], count: 1 });
    expect(result).toEqual({
      messages: ["hello", "processed"],
      count: 1,
    });
    // @ts-expect-error query is not in the state schema but still gets passed around internally
    expect(result.query).toBeUndefined();
  });

  it("should allow creating a StateGraph with a Zod schema", async () => {
    const stateSchema = z.object({
      messages: z.array(z.string()),
      count: z.number(),
    });

    type State = z.infer<typeof stateSchema>;

    const graph = new StateGraph(stateSchema)
      .addNode("process", (state: State) => {
        return { messages: [...state.messages, "processed"] };
      })
      .addEdge(START, "process")
      .addEdge("process", END)
      .compile();

    const result = await graph.invoke({ messages: ["hello"], count: 1 });
    expect(result).toEqual({
      messages: ["hello", "processed"],
      count: 1,
    });
  });

  it("should accept Zod messages schema & return tagged JSON schema", async () => {
    const schema = MessagesZodState.extend({ count: z.number() });

    const graph = new StateGraph(schema)
      .addNode("agent", () => ({
        messages: [{ type: "ai", content: "agent" }],
      }))
      .addNode("tool", () => ({
        messages: [{ type: "ai", content: "tool" }],
      }))
      .addEdge("__start__", "agent")
      .addEdge("agent", "tool")
      .compile();

    expect(
      await graph.invoke({
        messages: [{ type: "human", content: "hello" }],
      })
    ).toMatchObject({
      messages: [
        new _AnyIdHumanMessage("hello"),
        new _AnyIdAIMessage("agent"),
        new _AnyIdAIMessage("tool"),
      ],
    });

    expect.soft(getStateTypeSchema(graph)).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: {
        messages: { langgraph_type: "messages" },
        count: { type: "number" },
      },
    });

    expect.soft(getUpdateTypeSchema(graph)).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: {
        messages: { langgraph_type: "messages" },
        count: { type: "number" },
      },
    });

    expect.soft(getInputTypeSchema(graph)).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: {
        messages: { langgraph_type: "messages" },
        count: { type: "number" },
      },
    });

    expect.soft(getOutputTypeSchema(graph)).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: {
        messages: { langgraph_type: "messages" },
        count: { type: "number" },
      },
    });
  });

  it("should cache channel instances for the same field schema", () => {
    // This test verifies the fix for "Channel already exists with a different type" error
    // that occurs when multiple schemas share the same field definitions.
    // The fix caches channel instances per field schema to ensure identity equality.

    // Create a custom reducer for testing
    const fileDataReducer = (
      left: Record<string, string> | undefined,
      right: Record<string, string | null>
    ): Record<string, string> => {
      if (left === undefined) {
        const result: Record<string, string> = {};
        for (const [key, value] of Object.entries(right)) {
          if (value !== null) result[key] = value;
        }
        return result;
      }
      const result = { ...left };
      for (const [key, value] of Object.entries(right)) {
        if (value === null) delete result[key];
        else result[key] = value;
      }
      return result;
    };

    // Create a shared field schema with a reducer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filesFieldSchema = withLangGraph(z.record(z.string()) as any, {
      reducer: {
        fn: fileDataReducer,
        schema: z.record(z.string().nullable()),
      },
      default: () => ({}),
    });

    // Create two different object schemas that share the same field schema
    const schema1 = z.object({ files: filesFieldSchema, count: z.number() });
    const schema2 = z.object({ files: filesFieldSchema, name: z.string() });

    // Get channels for both schemas
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channels1 = schemaMetaRegistry.getChannelsForSchema(schema1 as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channels2 = schemaMetaRegistry.getChannelsForSchema(schema2 as any);

    // The 'files' channel should be the same instance for both schemas
    // This is the key assertion - without the cache fix, this would fail
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((channels1 as any).files).toBe((channels2 as any).files);
  });

  it("should not throw when creating StateGraph with different input/output schemas sharing fields", () => {
    // This test ensures that StateGraph can be created when state/input/output
    // schemas are different objects but share the same field schema definitions.
    // This is a common pattern when using middleware that adds state fields.

    const fileDataReducer = (
      left: Record<string, string> | undefined,
      right: Record<string, string | null>
    ): Record<string, string> => {
      const result = left ? { ...left } : {};
      for (const [key, value] of Object.entries(right)) {
        if (value === null) delete result[key];
        else result[key] = value;
      }
      return result;
    };

    // Shared field schema
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filesFieldSchema = withLangGraph(z.record(z.string()) as any, {
      reducer: {
        fn: fileDataReducer,
        schema: z.record(z.string().nullable()),
      },
      default: () => ({}),
    });

    // Create separate state, input, output schemas (simulating middleware behavior)
    const stateSchema = MessagesZodState.extend({ files: filesFieldSchema });
    const inputSchema = z.object({
      messages: MessagesZodState.shape.messages,
      files: filesFieldSchema,
    });
    const outputSchema = z.object({
      messages: MessagesZodState.shape.messages,
      files: filesFieldSchema,
    });

    // This should not throw "Channel already exists with a different type"
    expect(() => {
      const graph = new StateGraph({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        state: stateSchema as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input: inputSchema as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        output: outputSchema as any,
      });
      // Verify graph was created successfully
      expect(graph).toBeDefined();
    }).not.toThrow();
  });
});
