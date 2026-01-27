/**
 * Backward compatibility TYPE tests for StateGraph constructor patterns.
 * These tests ensure that type inference continues to work correctly
 * after the StateGraph constructor refactoring.
 *
 * IMPORTANT: These tests were written BEFORE any refactoring changes.
 * They serve as regression tests to ensure backward compatibility.
 */
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod/v4";
import { Annotation } from "../graph/annotation.js";
import { StateGraph } from "../graph/state.js";
import { StateSchema } from "../state/schema.js";
import { ReducedValue } from "../state/values/reduced.js";
import { Command, END, START } from "../constants.js";

describe("StateGraph type inference backward compatibility", () => {
  describe("direct schema patterns", () => {
    it("infers state type from Annotation.Root", async () => {
      const StateAnnotation = Annotation.Root({
        count: Annotation<number>({
          reducer: (a, b) => a + b,
          default: () => 0,
        }),
        name: Annotation<string>,
      });

      const graph = new StateGraph(StateAnnotation)
        .addNode("increment", (state) => {
          expectTypeOf(state).toEqualTypeOf<{ count: number; name: string }>();
          return { count: 1 };
        })
        .addEdge(START, "increment")
        .addEdge("increment", END)
        .compile();

      // Test invoke by calling it - type checking happens implicitly
      const result = await graph.invoke({ name: "test" });
      expectTypeOf(result).toEqualTypeOf<{ count: number; name: string }>();
    });

    it("infers state type from StateSchema", async () => {
      const AgentState = new StateSchema({
        count: z.number().default(0),
        name: z.string(),
      });

      const graph = new StateGraph(AgentState)
        .addNode("increment", (state) => {
          expectTypeOf(state).toEqualTypeOf<{ count: number; name: string }>();
          return { count: state.count + 1 };
        })
        .addEdge(START, "increment")
        .addEdge("increment", END)
        .compile();

      const result = await graph.invoke({ name: "test" });
      expectTypeOf(result).toEqualTypeOf<{ count: number; name: string }>();
    });

    it("infers state type from Zod schema", async () => {
      const stateSchema = z.object({
        count: z.number(),
        name: z.string(),
      });

      const graph = new StateGraph(stateSchema)
        .addNode("increment", (state) => {
          expectTypeOf(state).toEqualTypeOf<{ count: number; name: string }>();
          return { count: state.count + 1 };
        })
        .addEdge(START, "increment")
        .addEdge("increment", END)
        .compile();

      const result = await graph.invoke({ count: 0, name: "test" });
      expectTypeOf(result).toEqualTypeOf<{ count: number; name: string }>();
    });
  });

  describe("input/output type inference", () => {
    it("infers input type from input schema (Annotation)", async () => {
      const stateSchema = Annotation.Root({
        question: Annotation<string>,
        answer: Annotation<string>,
        internal: Annotation<string>,
      });

      const input = Annotation.Root({
        question: Annotation<string>,
      });

      const output = Annotation.Root({
        answer: Annotation<string>,
      });

      const graph = new StateGraph({ stateSchema, input, output })
        .addNode("agent", (state) => {
          // Node receives full state type
          expectTypeOf(state).toEqualTypeOf<{
            question: string;
            answer: string;
            internal: string;
          }>();
          return { answer: "response", internal: "data" };
        })
        .addEdge(START, "agent")
        .addEdge("agent", END)
        .compile();

      // Type checking via actual call
      const result = await graph.invoke({ question: "test" });
      expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
    });

    it("infers output type from output schema (Annotation)", async () => {
      const stateSchema = Annotation.Root({
        question: Annotation<string>,
        answer: Annotation<string>,
        internal: Annotation<string>,
      });

      const input = Annotation.Root({
        question: Annotation<string>,
      });

      const output = Annotation.Root({
        answer: Annotation<string>,
      });

      const graph = new StateGraph({ stateSchema, input, output })
        .addNode("agent", () => ({ answer: "response", internal: "data" }))
        .addEdge(START, "agent")
        .addEdge("agent", END)
        .compile();

      const result = await graph.invoke({ question: "test" });

      // Result should be output schema type
      expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
    });

    it("infers input/output types from Zod schemas", async () => {
      const stateSchema = z.object({
        question: z.string(),
        answer: z.string().optional(),
        internal: z.string().optional(),
      });

      const inputSchema = z.object({
        question: z.string(),
      });

      const outputSchema = z.object({
        answer: z.string(),
      });

      const graph = new StateGraph({
        state: stateSchema,
        input: inputSchema,
        output: outputSchema,
      })
        .addNode("agent", (state) => {
          expectTypeOf(state.question).toEqualTypeOf<string>();
          return { answer: "response" };
        })
        .addEdge(START, "agent")
        .addEdge("agent", END)
        .compile();

      const result = await graph.invoke({ question: "test" });

      // Result should be output schema type
      expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
    });

    it("defaults input/output to state when not specified", async () => {
      const StateAnnotation = Annotation.Root({
        count: Annotation<number>({
          reducer: (a, b) => a + b,
          default: () => 0,
        }),
        name: Annotation<string>,
      });

      const graph = new StateGraph(StateAnnotation)
        .addNode("increment", () => ({ count: 1 }))
        .addEdge(START, "increment")
        .addEdge("increment", END)
        .compile();

      const result = await graph.invoke({ name: "test" });

      // Result should be full state type
      expectTypeOf(result).toEqualTypeOf<{ count: number; name: string }>();
    });
  });

  describe("node function typing", () => {
    it("node receives full state type", () => {
      const StateAnnotation = Annotation.Root({
        count: Annotation<number>({
          reducer: (a, b) => a + b,
          default: () => 0,
        }),
        name: Annotation<string>,
        items: Annotation<string[]>({
          reducer: (a, b) => [...a, ...b],
          default: () => [],
        }),
      });

      new StateGraph(StateAnnotation).addNode("process", (state) => {
        // State should have all fields
        expectTypeOf(state.count).toEqualTypeOf<number>();
        expectTypeOf(state.name).toEqualTypeOf<string>();
        expectTypeOf(state.items).toEqualTypeOf<string[]>();
        return {};
      });
    });

    it("node can return partial update type", () => {
      const StateAnnotation = Annotation.Root({
        count: Annotation<number>({
          reducer: (a, b) => a + b,
          default: () => 0,
        }),
        name: Annotation<string>,
      });

      new StateGraph(StateAnnotation).addNode("process", (state) => {
        // Can return just count
        return { count: state.count + 1 };
      });

      new StateGraph(StateAnnotation).addNode("process2", (state) => {
        // Can return just name
        return { name: state.name.toUpperCase() };
      });

      new StateGraph(StateAnnotation).addNode("process3", () => {
        // Can return empty object
        return {};
      });
    });

    it("node can return Command with typed update", () => {
      const StateAnnotation = Annotation.Root({
        count: Annotation<number>({
          reducer: (a, b) => a + b,
          default: () => 0,
        }),
      });

      new StateGraph(StateAnnotation).addNode("process", (state) => {
        return new Command({
          update: { count: state.count + 1 },
          goto: END,
        });
      });
    });

    it("StateSchema node types work correctly", () => {
      const AgentState = new StateSchema({
        count: z.number().default(0),
        items: new ReducedValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], next: string) => [...current, next],
          }
        ),
      });

      new StateGraph(AgentState).addNode("process", (state) => {
        // State has value types
        expectTypeOf(state.count).toEqualTypeOf<number>();
        expectTypeOf(state.items).toEqualTypeOf<string[]>();

        // Can return input type for items (string, not string[])
        return { items: "new item" };
      });
    });
  });

  describe("invoke typing", () => {
    it("invoke accepts input schema type", async () => {
      const stateSchema = Annotation.Root({
        question: Annotation<string>,
        answer: Annotation<string>,
      });

      const input = Annotation.Root({
        question: Annotation<string>,
      });

      const graph = new StateGraph({ stateSchema, input })
        .addNode("agent", () => ({ answer: "response" }))
        .addEdge(START, "agent")
        .addEdge("agent", END)
        .compile();

      // Type checking via actual call
      const result = await graph.invoke({ question: "test" });
      expectTypeOf(result).toEqualTypeOf<{
        question: string;
        answer: string;
      }>();
    });

    it("invoke returns output schema type", async () => {
      const stateSchema = Annotation.Root({
        question: Annotation<string>,
        answer: Annotation<string>,
      });

      const output = Annotation.Root({
        answer: Annotation<string>,
      });

      const graph = new StateGraph({ stateSchema, output })
        .addNode("agent", () => ({ answer: "response" }))
        .addEdge(START, "agent")
        .addEdge("agent", END)
        .compile();

      const result = await graph.invoke({ question: "test" });

      // Result should be output type
      expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
    });

    it("invoke with Command input", async () => {
      const StateAnnotation = Annotation.Root({
        count: Annotation<number>({
          reducer: (a, b) => a + b,
          default: () => 0,
        }),
      });

      const graph = new StateGraph(StateAnnotation)
        .addNode("increment", () => ({ count: 1 }))
        .addEdge(START, "increment")
        .addEdge("increment", END)
        .compile();

      // Test that graph has invoke method that returns correct type
      const result = await graph.invoke({});
      expectTypeOf(result).toEqualTypeOf<{ count: number }>();

      // Test that Command can be constructed with correct update type
      const cmd = new Command({ update: { count: 5 }, goto: END });
      expectTypeOf(cmd).toBeObject();
    });
  });

  describe("addConditionalEdges typing", () => {
    it("router receives state type", () => {
      const StateAnnotation = Annotation.Root({
        count: Annotation<number>({
          reducer: (a, b) => a + b,
          default: () => 0,
        }),
        shouldEnd: Annotation<boolean>,
      });

      new StateGraph(StateAnnotation)
        .addNode("process", () => ({ count: 1 }))
        .addConditionalEdges(START, (state) => {
          expectTypeOf(state).toEqualTypeOf<{
            count: number;
            shouldEnd: boolean;
          }>();
          return state.shouldEnd ? END : "process";
        });
    });

    it("router can return valid node names", () => {
      const StateAnnotation = Annotation.Root({
        step: Annotation<number>,
      });

      new StateGraph(StateAnnotation)
        .addNode("agent", () => ({ step: 1 }))
        .addNode("tool", () => ({ step: 2 }))
        .addConditionalEdges(START, (state) => {
          if (state.step === 0) return "agent";
          if (state.step === 1) return "tool";
          return END;
        });
    });
  });

  describe("StateGraph.Node type helper", () => {
    it("Annotation provides Node type", () => {
      const StateAnnotation = Annotation.Root({
        count: Annotation<number>({
          reducer: (a, b) => a + b,
          default: () => 0,
        }),
      });

      const myNode: typeof StateAnnotation.Node = (state) => {
        expectTypeOf(state).toEqualTypeOf<{ count: number }>();
        return { count: state.count + 1 };
      };

      expectTypeOf(myNode).parameter(0).toEqualTypeOf<{ count: number }>();
    });

    it("StateSchema provides Node type", () => {
      const AgentState = new StateSchema({
        count: z.number().default(0),
      });

      const myNode: typeof AgentState.Node = (state) => {
        expectTypeOf(state).toEqualTypeOf<{ count: number }>();
        return { count: state.count + 1 };
      };

      expectTypeOf(myNode).parameter(0).toEqualTypeOf<{ count: number }>();
    });
  });

  describe("generic type parameters", () => {
    it("StateGraph preserves node names in types", () => {
      const StateAnnotation = Annotation.Root({
        count: Annotation<number>,
      });

      const graph = new StateGraph(StateAnnotation)
        .addNode("agent", () => ({ count: 1 }))
        .addNode("tool", () => ({ count: 2 }));

      // Graph should track node names
      expectTypeOf(graph).toHaveProperty("nodes");
    });

    it("supports context type parameter", () => {
      const StateAnnotation = Annotation.Root({
        count: Annotation<number>,
      });

      const ContextSchema = z.object({
        userId: z.string(),
      });

      const graph = new StateGraph(StateAnnotation, {
        context: ContextSchema,
      })
        .addNode("process", (_state, runtime) => {
          // Runtime should have context type
          expectTypeOf(runtime.configurable).toMatchTypeOf<
            { userId: string } | undefined
          >();
          return { count: 1 };
        })
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      expectTypeOf(graph).toHaveProperty("invoke");
    });
  });
});
