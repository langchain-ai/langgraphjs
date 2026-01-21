import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import { Annotation } from "./annotation.js";
import { StateGraph } from "./state.js";
import { StateSchema } from "../state/schema.js";
import { ReducedValue } from "../state/values/reduced.js";
import { Command, END, START } from "../constants.js";

describe("StateGraph", () => {
  describe("constructor", () => {
    describe("direct schema patterns", () => {
      it("accepts Annotation.Root directly", async () => {
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

        const result = await graph.invoke({ name: "test" });
        expect(result.count).toBe(1);
        expect(result.name).toBe("test");
        expectTypeOf(result).toEqualTypeOf<{ count: number; name: string }>();
      });

      it("accepts StateSchema directly", async () => {
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
        expect(result.count).toBe(1);
        expect(result.name).toBe("test");
        expectTypeOf(result).toEqualTypeOf<{ count: number; name: string }>();
      });

      it("accepts Zod schema directly", async () => {
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
        expect(result.count).toBe(1);
        expect(result.name).toBe("test");
        expectTypeOf(result).toEqualTypeOf<{ count: number; name: string }>();
      });
    });

    describe("object patterns with Annotation", () => {
      it("accepts { stateSchema, input, output } with Annotation", async () => {
        const stateSchema = Annotation.Root({
          question: Annotation<string>,
          answer: Annotation<string>,
          language: Annotation<string>,
        });

        const input = Annotation.Root({
          question: Annotation<string>,
        });

        const output = Annotation.Root({
          answer: Annotation<string>,
        });

        const graph = new StateGraph({ stateSchema, input, output })
          .addNode("agent", (state) => {
            expectTypeOf(state).toEqualTypeOf<{
              question: string;
              answer: string;
              language: string;
            }>();
            return {
              answer: `Answer to: ${state.question}`,
              language: "en",
            };
          })
          .addEdge(START, "agent")
          .addEdge("agent", END)
          .compile();

        const result = await graph.invoke({ question: "What is LangGraph?" });
        expect(result).toEqual({ answer: "Answer to: What is LangGraph?" });
        expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
      });

      it("accepts { stateSchema } with Annotation (input/output default to state)", async () => {
        const stateSchema = Annotation.Root({
          count: Annotation<number>({
            reducer: (a, b) => a + b,
            default: () => 0,
          }),
          name: Annotation<string>,
        });

        const graph = new StateGraph({ stateSchema })
          .addNode("increment", () => ({ count: 1 }))
          .addEdge(START, "increment")
          .addEdge("increment", END)
          .compile();

        const result = await graph.invoke({ name: "test" });
        expect(result.count).toBe(1);
        expect(result.name).toBe("test");
        expectTypeOf(result).toEqualTypeOf<{ count: number; name: string }>();
      });

      it("accepts { input, output } with Annotation", async () => {
        const InputAnnotation = Annotation.Root({
          question: Annotation<string>,
          context: Annotation<string>,
        });

        const OutputAnnotation = Annotation.Root({
          question: Annotation<string>,
          context: Annotation<string>,
          answer: Annotation<string>,
        });

        const graph = new StateGraph({
          input: InputAnnotation,
          output: OutputAnnotation,
        })
          .addNode("agent", (state) => ({
            answer: `Answer: ${state.question}`,
          }))
          .addEdge(START, "agent")
          .addEdge("agent", END)
          .compile();

        const result = await graph.invoke({ question: "Hi", context: "ctx" });
        expect(result.answer).toBe("Answer: Hi");
        expect(result.question).toBe("Hi");
        expect(result.context).toBe("ctx");
      });
    });

    describe("object patterns with Zod", () => {
      it("accepts { state, input, output } with Zod", async () => {
        const stateSchema = z.object({
          question: z.string(),
          answer: z.string().optional(),
          language: z.string().optional(),
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
            return {
              answer: `Answer to: ${state.question}`,
              language: "en",
            };
          })
          .addEdge(START, "agent")
          .addEdge("agent", END)
          .compile();

        const result = await graph.invoke({ question: "What is LangGraph?" });
        expect(result).toEqual({ answer: "Answer to: What is LangGraph?" });
        expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
      });

      it("accepts { state } with Zod (input/output default to state)", async () => {
        const stateSchema = z.object({
          count: z.number(),
          name: z.string(),
        });

        const graph = new StateGraph({ state: stateSchema })
          .addNode("increment", (state) => ({ count: state.count + 1 }))
          .addEdge(START, "increment")
          .addEdge("increment", END)
          .compile();

        const result = await graph.invoke({ count: 0, name: "test" });
        expect(result.count).toBe(1);
        expect(result.name).toBe("test");
      });
    });

    describe("two-arg patterns with context", () => {
      it("accepts (Annotation, { context })", async () => {
        const StateAnnotation = Annotation.Root({
          count: Annotation<number>({
            reducer: (a, b) => a + b,
            default: () => 0,
          }),
        });

        const ContextSchema = z.object({
          userId: z.string(),
        });

        const graph = new StateGraph(StateAnnotation, {
          context: ContextSchema,
        })
          .addNode("increment", (_state, runtime) => {
            expectTypeOf(runtime.configurable).toMatchTypeOf<
              { userId: string } | undefined
            >();
            return { count: 1 };
          })
          .addEdge(START, "increment")
          .addEdge("increment", END)
          .compile();

        const result = await graph.invoke(
          {},
          { configurable: { userId: "test-user" } }
        );
        expect(result.count).toBe(1);
      });

      it("accepts (StateSchema, { context })", async () => {
        const AgentState = new StateSchema({
          count: z.number().default(0),
        });

        const ContextSchema = z.object({
          userId: z.string(),
        });

        const graph = new StateGraph(AgentState, {
          context: ContextSchema,
        })
          .addNode("increment", (state) => ({ count: state.count + 1 }))
          .addEdge(START, "increment")
          .addEdge("increment", END)
          .compile();

        const result = await graph.invoke(
          {},
          { configurable: { userId: "test-user" } }
        );
        expect(result.count).toBe(1);
      });

      it("accepts (Zod, { context })", async () => {
        const stateSchema = z.object({
          count: z.number(),
        });

        const ContextSchema = z.object({
          userId: z.string(),
        });

        const graph = new StateGraph(stateSchema, {
          context: ContextSchema,
        })
          .addNode("increment", (state) => ({ count: state.count + 1 }))
          .addEdge(START, "increment")
          .addEdge("increment", END)
          .compile();

        const result = await graph.invoke(
          { count: 0 },
          { configurable: { userId: "test-user" } }
        );
        expect(result.count).toBe(1);
      });
    });

    describe("deprecated patterns", () => {
      it("accepts { channels: {...} }", async () => {
        // This is the legacy pattern using channels directly
        const graph = new StateGraph<{ count: number; name: string }>({
          channels: {
            count: {
              reducer: (a: number, b: number) => a + b,
              default: () => 0,
            },
            name: null,
          },
        })
          .addNode("increment", () => ({ count: 1 }))
          .addEdge(START, "increment")
          .addEdge("increment", END)
          .compile();

        const result = await graph.invoke({ name: "test" });
        expect(result.count).toBe(1);
        expect(result.name).toBe("test");
      });
    });

    describe("object patterns with state property", () => {
      it("accepts { state: StateSchema, input: Zod, output: Zod }", async () => {
        const FullState = new StateSchema({
          question: z.string(),
          answer: z.string().optional(),
          internal: z.string().optional(),
        });

        const InputSchema = z.object({
          question: z.string(),
        });

        const OutputSchema = z.object({
          answer: z.string(),
        });

        const graph = new StateGraph({
          state: FullState,
          input: InputSchema,
          output: OutputSchema,
        })
          .addNode("agent", (state) => {
            // Type inference: state should have full StateSchema type
            expectTypeOf(state.question).toEqualTypeOf<string>();
            expectTypeOf(state.answer).toEqualTypeOf<string | undefined>();
            expectTypeOf(state.internal).toEqualTypeOf<string | undefined>();
            return {
              answer: `Answer to: ${state.question}`,
              internal: "internal data",
            };
          })
          .addEdge(START, "agent")
          .addEdge("agent", END)
          .compile();

        const result = await graph.invoke({ question: "What is LangGraph?" });
        expect(result).toEqual({ answer: "Answer to: What is LangGraph?" });
        // Type inference: output should be limited to OutputSchema
        expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
      });

      it("accepts { state: Zod, input: StateSchema, output: Annotation }", async () => {
        const stateSchema = z.object({
          question: z.string(),
          answer: z.string().optional(),
          internal: z.string().optional(),
        });

        const InputState = new StateSchema({
          question: z.string(),
        });

        const OutputAnnotation = Annotation.Root({
          answer: Annotation<string>,
        });

        const graph = new StateGraph({
          state: stateSchema,
          input: InputState,
          output: OutputAnnotation,
        })
          .addNode("agent", (state) => {
            // Type inference: state should have Zod schema type
            expectTypeOf(state.question).toEqualTypeOf<string>();
            expectTypeOf(state.answer).toEqualTypeOf<string | undefined>();
            return {
              answer: `Answer to: ${state.question}`,
              internal: "internal data",
            };
          })
          .addEdge(START, "agent")
          .addEdge("agent", END)
          .compile();

        const result = await graph.invoke({ question: "What is LangGraph?" });
        expect(result).toEqual({ answer: "Answer to: What is LangGraph?" });
        // Type inference: output should match Annotation type
        expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
      });

      it("accepts { state: Annotation, input: Zod, output: StateSchema }", async () => {
        const StateAnnotation = Annotation.Root({
          question: Annotation<string>,
          answer: Annotation<string | undefined>,
          internal: Annotation<string | undefined>,
        });

        const InputSchema = z.object({
          question: z.string(),
        });

        const OutputState = new StateSchema({
          answer: z.string(),
        });

        const graph = new StateGraph({
          state: StateAnnotation,
          input: InputSchema,
          output: OutputState,
        })
          .addNode("agent", (state) => ({
            answer: `Answer to: ${state.question}`,
            internal: "internal data",
          }))
          .addEdge(START, "agent")
          .addEdge("agent", END)
          .compile();

        const result = await graph.invoke({ question: "What is LangGraph?" });
        expect(result).toEqual({ answer: "Answer to: What is LangGraph?" });
      });
    });

    describe("two-arg patterns with mixed schemas", () => {
      it("accepts (StateSchema, { input: Zod })", async () => {
        const FullState = new StateSchema({
          question: z.string(),
          answer: z.string().optional(),
        });

        const InputSchema = z.object({
          question: z.string(),
        });

        const graph = new StateGraph(FullState, {
          input: InputSchema,
        })
          .addNode("agent", (state) => {
            // Type inference check
            expectTypeOf(state.question).toEqualTypeOf<string>();
            expectTypeOf(state.answer).toEqualTypeOf<string | undefined>();
            return { answer: `Answer to: ${state.question}` };
          })
          .addEdge(START, "agent")
          .addEdge("agent", END)
          .compile();

        const result = await graph.invoke({ question: "Hi!" });
        expect(result.answer).toBe("Answer to: Hi!");
      });

      it("accepts (Zod, { output: StateSchema })", async () => {
        const stateSchema = z.object({
          question: z.string(),
          answer: z.string().optional(),
        });

        const OutputState = new StateSchema({
          answer: z.string(),
        });

        const graph = new StateGraph(stateSchema, {
          output: OutputState,
        })
          .addNode("agent", (state) => {
            expectTypeOf(state.question).toEqualTypeOf<string>();
            return { answer: `Answer to: ${state.question}` };
          })
          .addEdge(START, "agent")
          .addEdge("agent", END)
          .compile();

        const result = await graph.invoke({ question: "Hi!" });
        expect(result).toEqual({ answer: "Answer to: Hi!" });
        expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
      });

      it("accepts (Annotation, { input: StateSchema, output: Zod })", async () => {
        const StateAnnotation = Annotation.Root({
          question: Annotation<string>,
          answer: Annotation<string | undefined>,
        });

        const InputState = new StateSchema({
          question: z.string(),
        });

        const OutputSchema = z.object({
          answer: z.string(),
        });

        const graph = new StateGraph(StateAnnotation, {
          input: InputState,
          output: OutputSchema,
        })
          .addNode("agent", (state) => {
            expectTypeOf(state.question).toEqualTypeOf<string>();
            return { answer: `Answer to: ${state.question}` };
          })
          .addEdge(START, "agent")
          .addEdge("agent", END)
          .compile();

        const result = await graph.invoke({ question: "Hi!" });
        expect(result).toEqual({ answer: "Answer to: Hi!" });
        expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
      });
    });
  });

  describe("input validation with mixed schemas", () => {
    it("validates input StateSchema", async () => {
      const stateSchema = z.object({
        count: z.number(),
        name: z.string(),
      });

      const InputState = new StateSchema({
        count: z.number().min(0),
        name: z.string().min(1),
      });

      const graph = new StateGraph({
        state: stateSchema,
        input: InputState,
      })
        .addNode("process", (state) => ({ count: state.count + 1 }))
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      // Valid input should work
      const result = await graph.invoke({ count: 0, name: "test" });
      expect(result.count).toBe(1);

      // Invalid input should throw (empty name)
      await expect(graph.invoke({ count: 0, name: "" })).rejects.toThrow();
    });

    it("validates input zod object", async () => {
      const FullState = new StateSchema({
        count: z.number(),
        name: z.string(),
      });

      const InputSchema = z.object({
        count: z.number().min(0),
        name: z.string().min(1),
      });

      const graph = new StateGraph({
        state: FullState,
        input: InputSchema,
      })
        .addNode("process", (state) => ({ count: state.count + 1 }))
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      // Valid input should work
      const result = await graph.invoke({ count: 0, name: "test" });
      expect(result.count).toBe(1);

      // Invalid input should throw (empty name)
      await expect(graph.invoke({ count: 0, name: "" })).rejects.toThrow();
    });
  });

  describe("per-node input with mixed schemas", () => {
    it("accepts per-node input with StateSchema when graph state is Zod", async () => {
      const stateSchema = z.object({
        messages: z.array(z.string()),
        count: z.number(),
      });

      const NodeInputState = new StateSchema({
        messages: z.array(z.string()),
      });

      const graph = new StateGraph(stateSchema)
        .addNode(
          "process",
          (input) => {
            // Type: input should be constrained to NodeInputState only, not full state
            expectTypeOf(input).toEqualTypeOf<{ messages: string[] }>();
            return { messages: [...input.messages, "processed"] };
          },
          { input: NodeInputState }
        )
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      const result = await graph.invoke({ messages: ["hello"], count: 1 });
      expect(result.messages).toEqual(["hello", "processed"]);
      expect(result.count).toBe(1);
    });

    it("accepts per-node input with Zod when graph state is StateSchema", async () => {
      const FullState = new StateSchema({
        messages: z.array(z.string()),
        count: z.number(),
      });

      const NodeInputSchema = z.object({
        messages: z.array(z.string()),
      });

      const graph = new StateGraph(FullState)
        .addNode(
          "process",
          (input) => {
            // Type: input should be constrained to NodeInputSchema only, not full state
            expectTypeOf(input).toEqualTypeOf<{ messages: string[] }>();
            return { messages: [...input.messages, "processed"] };
          },
          { input: NodeInputSchema }
        )
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      const result = await graph.invoke({ messages: ["hello"], count: 1 });
      expect(result.messages).toEqual(["hello", "processed"]);
      expect(result.count).toBe(1);
    });

    it("accepts per-node input with Annotation when graph state is Zod", async () => {
      const stateSchema = z.object({
        messages: z.array(z.string()),
        count: z.number(),
      });

      const NodeInputAnnotation = Annotation.Root({
        messages: Annotation<string[]>,
      });

      const graph = new StateGraph(stateSchema)
        .addNode(
          "process",
          (input) => {
            // Type: input should be constrained to NodeInputAnnotation only, not full state
            expectTypeOf(input).toEqualTypeOf<{ messages: string[] }>();
            return { messages: [...input.messages, "processed"] };
          },
          { input: NodeInputAnnotation }
        )
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      const result = await graph.invoke({ messages: ["hello"], count: 1 });
      expect(result.messages).toEqual(["hello", "processed"]);
      expect(result.count).toBe(1);
    });
  });

  describe("type inference", () => {
    it("node receives full state type regardless of input schema", () => {
      const FullState = new StateSchema({
        question: z.string(),
        answer: z.string().optional(),
        internal: z.string().optional(),
      });

      const InputSchema = z.object({
        question: z.string(),
      });

      new StateGraph({
        state: FullState,
        input: InputSchema,
      }).addNode("agent", (state) => {
        // Even with limited input schema, node receives full state
        expectTypeOf(state.question).toEqualTypeOf<string>();
        expectTypeOf(state.answer).toEqualTypeOf<string | undefined>();
        expectTypeOf(state.internal).toEqualTypeOf<string | undefined>();
        return { answer: "response" };
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
        items: new ReducedValue(z.array(z.string()).default(() => []), {
          inputSchema: z.string(),
          reducer: (current: string[], next: string) => [...current, next],
        }),
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

  describe("graph functionality", () => {
    it("correctly collapses multiple schemas into channels", async () => {
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
        .addNode("process", (state) => ({
          answer: `Answer: ${state.question}`,
          internal: "internal data",
        }))
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      // Input only needs question
      const result = await graph.invoke({ question: "test" });

      // Output only has answer
      expect(result).toEqual({ answer: "Answer: test" });
      // Internal field should not be in output
      expect((result as Record<string, unknown>).internal).toBeUndefined();
    });

    it("outputs only fields from output schema", async () => {
      const stateSchema = z.object({
        question: z.string(),
        answer: z.string().optional(),
        metadata: z.string().optional(),
      });

      const outputSchema = z.object({
        answer: z.string(),
      });

      const graph = new StateGraph({ state: stateSchema, output: outputSchema })
        .addNode("process", (state) => ({
          answer: `Answer: ${state.question}`,
          metadata: "some metadata",
        }))
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      const result = await graph.invoke({ question: "test" });

      // Only answer should be in output
      expect(result).toEqual({ answer: "Answer: test" });
      expect(result).not.toHaveProperty("metadata");
    });

    it("detects channel conflicts with different reducers", () => {
      const schema1 = Annotation.Root({
        items: Annotation<string[]>({
          reducer: (a, b) => [...a, ...b],
          default: () => [],
        }),
      });

      const schema2 = Annotation.Root({
        items: Annotation<string[]>({
          reducer: (_a, b) => b, // Different reducer!
          default: () => [],
        }),
      });

      // This should throw because the reducers are different
      expect(() => {
        new StateGraph({ stateSchema: schema1, output: schema2 })
          .addNode("process", () => ({}))
          .addEdge(START, "process")
          .addEdge("process", END)
          .compile();
      }).toThrow();
    });

    it("allows Command with typed update", async () => {
      const StateAnnotation = Annotation.Root({
        count: Annotation<number>({
          reducer: (a, b) => a + b,
          default: () => 0,
        }),
      });

      const graph = new StateGraph(StateAnnotation)
        .addNode(
          "increment",
          () =>
            new Command({
              update: { count: 1 },
              goto: END,
            })
        )
        .addEdge(START, "increment")
        .compile();

      const result = await graph.invoke({});
      expect(result.count).toBe(1);
    });

    it("supports StateSchema with ReducedValue", async () => {
      const AgentState = new StateSchema({
        items: new ReducedValue(z.array(z.string()).default(() => []), {
          inputSchema: z.string(),
          reducer: (current: string[], next: string) => [...current, next],
        }),
        count: z.number().default(0),
      });

      const graph = new StateGraph(AgentState)
        .addNode("add", () => ({ items: "item1", count: 1 }))
        .addNode("add2", () => ({ items: "item2", count: 1 }))
        .addEdge(START, "add")
        .addEdge("add", "add2")
        .addEdge("add2", END)
        .compile();

      const result = await graph.invoke({});
      expect(result.items).toEqual(["item1", "item2"]);
      expect(result.count).toBe(1); // LastValue, not accumulated
    });

    it("per-node input with Annotation (with reducer in state)", async () => {
      // State has a reducer for messages
      const StateAnnotation = Annotation.Root({
        messages: Annotation<string[]>({
          reducer: (a, b) => [...a, ...b],
          default: () => [],
        }),
        count: Annotation<number>,
        query: Annotation<string>,
      });

      // Node input uses LastValue (no reducer) - this is the typical pattern
      // Node input schemas usually just specify which fields to read, not how to merge
      const NodeInputAnnotation = Annotation.Root({
        messages: Annotation<string[]>,
        query: Annotation<string>,
      });

      const graph = new StateGraph(StateAnnotation)
        .addNode("addQuery", (state) => ({
          query: `Query from: ${state.messages[0]}`,
        }))
        .addNode(
          "process",
          (input) => {
            // input has messages and query (from node input schema)
            expect(input.messages).toBeDefined();
            expect(input.query).toBeDefined();
            return { messages: ["processed"] };
          },
          { input: NodeInputAnnotation }
        )
        .addEdge(START, "addQuery")
        .addEdge("addQuery", "process")
        .addEdge("process", END)
        .compile();

      const result = await graph.invoke({ messages: ["hello"], count: 1 });
      expect(result.messages).toEqual(["hello", "processed"]);
      expect(result.count).toBe(1);
    });
  });
});
