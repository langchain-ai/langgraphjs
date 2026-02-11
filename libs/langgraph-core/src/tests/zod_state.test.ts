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

  it("should preserve langgraph_type metadata when using Zod v4 .register() with MessagesZodMeta", async () => {
    // This test verifies the fix for the issue where Zod v4's .register() method
    // wasn't properly storing MessagesZodMeta metadata, causing LangGraph Studio
    // to not detect the messages key and disable the Chat tab.
    // See: https://github.com/langchain-ai/langgraphjs/issues/1722

    const { MessagesZodMeta } = await import("../graph/messages_annotation.js");
    const customStateSchema = z4.object({
      messages: z4.array(z4.any()).register(registry, MessagesZodMeta),
      llmCalls: z4.number().optional(),
    });

    const graph = new StateGraph(customStateSchema)
      .addNode("agent", () => ({
        messages: [{ type: "ai", content: "response" }],
      }))
      .addEdge("__start__", "agent")
      .compile();

    // Verify the graph works correctly
    expect(
      await graph.invoke({
        messages: [{ type: "human", content: "hello" }],
      })
    ).toMatchObject({
      messages: [
        new _AnyIdHumanMessage("hello"),
        new _AnyIdAIMessage("response"),
      ],
    });

    // "messages" must be present in the generated JSON Schema. This is what LangGraph
    // Studio checks to determine if the Chat tab should be enabled.
    const inputSchema = getInputTypeSchema(graph);
    expect(inputSchema).toBeDefined();
    expect(
      (inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties?.messages
    ).toMatchObject({
      langgraph_type: "messages",
    });

    // Also verify other schema types have the metadata
    expect
      .soft(
        (
          getStateTypeSchema(graph) as
            | { properties?: Record<string, unknown> }
            | undefined
        )?.properties?.messages
      )
      .toMatchObject({
        langgraph_type: "messages",
      });

    expect
      .soft(
        (
          getUpdateTypeSchema(graph) as
            | { properties?: Record<string, unknown> }
            | undefined
        )?.properties?.messages
      )
      .toMatchObject({
        langgraph_type: "messages",
      });

    expect
      .soft(
        (
          getOutputTypeSchema(graph) as
            | { properties?: Record<string, unknown> }
            | undefined
        )?.properties?.messages
      )
      .toMatchObject({
        langgraph_type: "messages",
      });
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
