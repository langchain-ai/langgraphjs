import { describe, it, expect } from "vitest";
import { z } from "zod/v3";
import * as z4 from "zod/v4";
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
import { registry } from "../graph/zod/zod-registry.js";

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

  describe("registry default values", () => {
    it("should apply registry default when field is missing from input", async () => {
      const stateSchema = z4.object({
        foo: z4.string().default("zod-default"),
        bar: z4.string().register(registry, {
          default: () => "registry-default",
        }),
        baz: z4.string(),
      });

      const graph = new StateGraph(stateSchema)
        .addNode("process", (state) => {
          // Verify defaults are applied when node receives state
          expect(state.foo).toBe("zod-default");
          expect(state.bar).toBe("registry-default");
          expect(state.baz).toBe("provided");
          return {};
        })
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      // Only provide baz, foo and bar should get defaults
      const result = await graph.invoke({ baz: "provided" });
      // Verify defaults are in final output
      expect(result.foo).toBe("zod-default");
      expect(result.bar).toBe("registry-default");
      expect(result.baz).toBe("provided");
    });

    it("should prioritize provided input over registry default", async () => {
      const stateSchema = z4.object({
        bar: z4.string().register(registry, {
          default: () => "registry-default",
        }),
      });

      const graph = new StateGraph(stateSchema)
        .addNode("process", (state) => {
          // Verify provided value takes precedence over default
          expect(state.bar).toBe("provided-value");
          return {};
        })
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      const result = await graph.invoke({ bar: "provided-value" });
      expect(result.bar).toBe("provided-value");
    });

    it("should work with registry default alongside reducer", async () => {
      const stateSchema = z4.object({
        items: z4.array(z4.string()).register(registry, {
          default: () => ["initial"],
          reducer: {
            fn: (a, b) => a.concat(Array.isArray(b) ? b : [b]),
          },
        }),
      });

      const graph = new StateGraph(stateSchema)
        .addNode("add", (state) => {
          // Verify default is applied before reducer processes update
          expect(state.items).toEqual(["initial"]);
          return { items: ["new"] };
        })
        .addEdge(START, "add")
        .addEdge("add", END)
        .compile();

      const result = await graph.invoke({});
      // Verify reducer combined default with update
      expect(result.items).toEqual(["initial", "new"]);
    });

    it("should work when all combinations of defaults are present", async () => {
      const stateSchema = z4.object({
        withZod: z4.string().default("zod-default"),
        withRegistry: z4.string().register(registry, {
          default: () => "registry-default",
        }),
        withBoth: z4
          .string()
          .default("zod-default")
          .register(registry, {
            default: () => "registry-default",
          }),
        withNeither: z4.string(),
      });

      const graph = new StateGraph(stateSchema)
        .addNode("process", (state) => {
          // Verify defaults are applied correctly
          expect(state.withZod).toBe("zod-default");
          expect(state.withRegistry).toBe("registry-default");
          // Zod default takes precedence during parsing, so registry default isn't used
          expect(state.withBoth).toBe("zod-default");
          return {};
        })
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      const result = await graph.invoke({});
      expect(result.withZod).toBe("zod-default");
      expect(result.withRegistry).toBe("registry-default");
      expect(result.withBoth).toBe("zod-default"); // Zod default takes precedence during parsing
    });
  });

  describe("reducer with separate state/input/output schemas", () => {
    it("should allow same reducer field in state, input, and output schemas", async () => {
      // Define a reducer function at module level (similar to DeepAgents pattern)
      const itemsReducer = (
        left: Record<string, { value: string }>,
        right: Record<string, { value: string } | null>
      ): Record<string, { value: string }> => {
        const result = { ...left };
        for (const [key, val] of Object.entries(right)) {
          if (val === null) {
            delete result[key];
          } else {
            result[key] = val;
          }
        }
        return result;
      };

      // Create a schema field with reducer (shared across state/input/output)
      const itemsField = z4
        .record(z4.string(), z4.object({ value: z4.string() }))
        .default({})
        .register(registry, {
          reducer: {
            fn: itemsReducer,
            schema: z4.record(
              z4.string(),
              z4.object({ value: z4.string() }).nullable()
            ),
          },
        });

      // Create separate state, input, and output schemas that all include the reducer field
      const stateSchema = z4.object({
        items: itemsField,
        count: z4.number().default(0),
      });

      const inputSchema = z4.object({
        items: itemsField,
      });

      const outputSchema = z4.object({
        items: itemsField,
        count: z4.number(),
      });

      // This should NOT throw "Channel already exists with a different type"
      // because BinaryOperatorAggregate.equals() compares reducer function references
      const graph = new StateGraph({
        state: stateSchema,
        input: inputSchema,
        output: outputSchema,
      })
        .addNode("process", (state) => {
          return {
            items: { newKey: { value: "added" } },
            count:
              Object.keys(state.items as unknown as Record<string, unknown>)
                .length + 1,
          };
        })
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      const result = await graph.invoke({
        items: { existingKey: { value: "existing" } },
      });

      // Verify reducer worked correctly
      expect(result.items).toEqual({
        existingKey: { value: "existing" },
        newKey: { value: "added" },
      });
      expect(result.count).toBe(2);
    });

    it("should detect different reducer functions as different channels", () => {
      // Two different reducer functions
      const reducer1 = (a: number[], b: number[]) => [...a, ...b];
      const reducer2 = (a: number[], b: number[]) => [...b, ...a]; // Different implementation

      const field1 = z4
        .array(z4.number())
        .default([])
        .register(registry, { reducer: { fn: reducer1 } });

      const field2 = z4
        .array(z4.number())
        .default([])
        .register(registry, { reducer: { fn: reducer2 } });

      const stateSchema = z4.object({
        numbers: field1,
      });

      const inputSchema = z4.object({
        numbers: field2, // Different reducer!
      });

      // This SHOULD throw because the reducer functions are different
      expect(() => {
        new StateGraph({ state: stateSchema, input: inputSchema })
          .addNode("process", () => ({}))
          .addEdge(START, "process")
          .addEdge("process", END)
          .compile();
      }).toThrow('Channel "numbers" already exists with a different type');
    });
  });
});
