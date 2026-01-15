import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod/v4";

import { Annotation } from "../graph/annotation.js";
import { StateGraph } from "../graph/state.js";
import { StateSchema } from "../state/schema.js";
import { ReducedValue } from "../state/values/reduced.js";
import { Command, Send, START, END } from "../constants.js";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import type {
  GraphNode,
  ConditionalEdgeRouter,
  ExtractStateType,
  ExtractUpdateType,
} from "../graph/types.js";

describe("ExtractStateType", () => {
  describe("with StateSchema", () => {
    const AgentState = new StateSchema({
      count: z.number().default(0),
      name: z.string(),
      items: new ReducedValue(
        z.array(z.string()).default(() => []),
        {
          inputSchema: z.string(),
          reducer: (current: string[], next: string) => [...current, next],
        }
      ),
    });

    it("infers correct state type", () => {
      type State = ExtractStateType<typeof AgentState>;

      expectTypeOf<State>().toEqualTypeOf<{
        count: number;
        name: string;
        items: string[];
      }>();
    });
  });

  describe("with Annotation", () => {
    const AgentAnnotation = Annotation.Root({
      count: Annotation<number>({
        reducer: (a, b) => a + b,
        default: () => 0,
      }),
      name: Annotation<string>,
    });

    it("infers correct state type", () => {
      type State = ExtractStateType<typeof AgentAnnotation>;

      expectTypeOf<State>().toEqualTypeOf<{
        count: number;
        name: string;
      }>();
    });
  });

  describe("with Zod object", () => {
    const ZodState = z.object({
      count: z.number().default(0),
      name: z.string(),
    });

    it("infers correct state type", () => {
      type State = ExtractStateType<typeof ZodState>;

      expectTypeOf<State>().toEqualTypeOf<{
        count: number;
        name: string;
      }>();
    });
  });

  describe("fallback behavior", () => {
    it("returns schema itself for unknown types", () => {
      type Result = ExtractStateType<{ custom: true }>;
      expectTypeOf<Result>().toEqualTypeOf<{ custom: true }>();
    });

    it("uses explicit Fallback type when provided", () => {
      type Result = ExtractStateType<unknown, { fallback: true }>;
      expectTypeOf<Result>().toEqualTypeOf<{ fallback: true }>();
    });
  });
});

describe("ExtractUpdateType", () => {
  describe("with StateSchema", () => {
    const AgentState = new StateSchema({
      count: z.number().default(0),
      name: z.string(),
      items: new ReducedValue(
        z.array(z.string()).default(() => []),
        {
          inputSchema: z.string(),
          reducer: (current: string[], next: string) => [...current, next],
        }
      ),
    });

    it("infers correct update type with reducer input schema", () => {
      type Update = ExtractUpdateType<typeof AgentState>;

      expectTypeOf<Update>().toEqualTypeOf<{
        count?: number | undefined;
        name?: string | undefined;
        items?: string | undefined;
      }>();
    });
  });

  describe("with Annotation", () => {
    const AgentAnnotation = Annotation.Root({
      count: Annotation<number>({
        reducer: (_, b) => b,
        default: () => 0,
      }),
      name: Annotation<string>,
    });

    it("infers correct update type", () => {
      type Update = ExtractUpdateType<typeof AgentAnnotation>;

      expectTypeOf<Update>().toEqualTypeOf<{
        count?: number | undefined;
        name?: string | undefined;
      }>();
    });
  });

  describe("fallback behavior", () => {
    it("returns never for unknown types by default", () => {
      type Result = ExtractUpdateType<{ custom: true }>;
      expectTypeOf<Result>().toEqualTypeOf<{ custom?: true | undefined }>();
    });

    it("uses explicit FallbackBase type when provided (partialized)", () => {
      type Result = ExtractUpdateType<unknown, { fallback: true }>;
      expectTypeOf<Result>().toEqualTypeOf<{ fallback?: true }>();
    });
  });
});

describe("GraphNode", () => {
  describe("with StateSchema", () => {
    const AgentState = new StateSchema({
      count: z.number().default(0),
      name: z.string(),
    });

    it("types node functions correctly", () => {
      const myNode: GraphNode<typeof AgentState> = (state, _config) => {
        expectTypeOf(state.count).toEqualTypeOf<number>();
        expectTypeOf(state.name).toEqualTypeOf<string>();
        return { count: state.count + 1 };
      };

      expectTypeOf(myNode)
        .parameter(0)
        .toEqualTypeOf<{ count: number; name: string }>();
      expectTypeOf(myNode).parameter(1).toExtend<LangGraphRunnableConfig>();
    });

    it("allows async node functions", () => {
      const asyncNode: GraphNode<typeof AgentState> = async (state) => {
        await Promise.resolve();
        return { count: state.count + 1 };
      };

      expectTypeOf(asyncNode)
        .parameter(0)
        .toEqualTypeOf<{ count: number; name: string }>();
    });

    it("works with StateSchema.Node type helper", () => {
      const myNode: typeof AgentState.Node = (state) => {
        expectTypeOf(state.count).toEqualTypeOf<number>();
        return { count: state.count + 1 };
      };

      expectTypeOf(myNode)
        .parameter(0)
        .toEqualTypeOf<{ count: number; name: string }>();
    });
  });

  describe("with Annotation", () => {
    const AgentAnnotation = Annotation.Root({
      count: Annotation<number>({
        reducer: (a, b) => a + b,
        default: () => 0,
      }),
      name: Annotation<string>,
    });

    it("types node functions correctly", () => {
      const myNode: GraphNode<typeof AgentAnnotation> = (state, _config) => {
        expectTypeOf(state.count).toEqualTypeOf<number>();
        expectTypeOf(state.name).toEqualTypeOf<string>();
        return { count: 1 };
      };

      expectTypeOf(myNode)
        .parameter(0)
        .toEqualTypeOf<{ count: number; name: string }>();
      expectTypeOf(myNode).parameter(1).toExtend<LangGraphRunnableConfig>();
    });

    it("works with Annotation.Node type helper", () => {
      const myNode: typeof AgentAnnotation.Node = (state) => {
        expectTypeOf(state.count).toEqualTypeOf<number>();
        return { count: 1 };
      };

      expectTypeOf(myNode)
        .parameter(0)
        .toEqualTypeOf<{ count: number; name: string }>();
    });

    it("integrates with StateGraph.addNode", async () => {
      const myNode: GraphNode<typeof AgentAnnotation> = (state) => {
        return { count: state.count + 1 };
      };

      const graph = new StateGraph(AgentAnnotation)
        .addNode("myNode", myNode)
        .addEdge(START, "myNode")
        .addEdge("myNode", END)
        .compile();

      const result = await graph.invoke({ count: 0, name: "test" });
      expectTypeOf(result).toExtend<{ count: number; name: string }>();
    });
  });

  describe("with Zod object", () => {
    const ZodState = z.object({
      count: z.number().default(0),
      name: z.string(),
    });

    it("types node functions correctly", () => {
      const myNode: GraphNode<typeof ZodState> = (state, _config) => {
        expectTypeOf(state.count).toEqualTypeOf<number>();
        expectTypeOf(state.name).toEqualTypeOf<string>();
        return { count: state.count + 1 };
      };

      expectTypeOf(myNode)
        .parameter(0)
        .toEqualTypeOf<{ count: number; name: string }>();
      expectTypeOf(myNode).parameter(1).toExtend<LangGraphRunnableConfig>();
    });

    it("integrates with StateGraph.addNode", async () => {
      const myNode: GraphNode<typeof ZodState> = (state) => {
        return { count: state.count + 1 };
      };

      const graph = new StateGraph(ZodState)
        .addNode("myNode", myNode)
        .addEdge(START, "myNode")
        .addEdge("myNode", END)
        .compile();

      const result = await graph.invoke({ count: 0, name: "test" });
      expectTypeOf(result).toExtend<{ count: number; name: string }>();
    });
  });

  describe("return types", () => {
    const AgentAnnotation = Annotation.Root({
      count: Annotation<number>({
        reducer: (_, b) => b,
        default: () => 0,
      }),
    });

    it("allows empty object for no-op nodes", () => {
      const noOpNode: GraphNode<typeof AgentAnnotation> = (_state) => {
        return {};
      };

      expectTypeOf(noOpNode).parameter(0).toEqualTypeOf<{ count: number }>();
    });

    it("allows plain update objects", () => {
      const updateNode: GraphNode<typeof AgentAnnotation> = (state) => {
        return { count: state.count + 1 };
      };

      expectTypeOf(updateNode).parameter(0).toEqualTypeOf<{ count: number }>();
    });

    it("allows Command objects", () => {
      const commandNode: GraphNode<typeof AgentAnnotation> = (state) => {
        return new Command({
          goto: "next",
          update: { count: state.count + 1 },
        });
      };

      expectTypeOf(commandNode).parameter(0).toEqualTypeOf<{ count: number }>();
    });

    it("allows Command with Send array for fan-out", () => {
      const fanOutNode: GraphNode<
        typeof AgentAnnotation,
        Record<string, unknown>,
        "worker"
      > = (state) => {
        return new Command({
          goto: [
            new Send("worker", { count: state.count }),
            new Send("worker", { count: state.count + 1 }),
          ],
        });
      };

      expectTypeOf(fanOutNode).parameter(0).toEqualTypeOf<{ count: number }>();
    });
  });

  describe("with typed nodes", () => {
    const AgentAnnotation = Annotation.Root({
      step: Annotation<number>({
        reducer: (_, b) => b,
        default: () => 0,
      }),
    });

    it("constrains Command.goto to valid node names", () => {
      const routerNode: GraphNode<
        typeof AgentAnnotation,
        Record<string, unknown>,
        "process" | "end"
      > = (state) => {
        if (state.step > 5) {
          return new Command({ goto: "end" });
        }
        return new Command({
          goto: "process",
          update: { step: state.step + 1 },
        });
      };

      expectTypeOf(routerNode).parameter(0).toEqualTypeOf<{ step: number }>();
    });

    it("allows any string for goto when nodes not specified", () => {
      const flexibleNode: GraphNode<typeof AgentAnnotation> = (state) => {
        return new Command({
          goto: "anywhere",
          update: { step: state.step + 1 },
        });
      };

      expectTypeOf(flexibleNode).parameter(0).toEqualTypeOf<{ step: number }>();
      expectTypeOf(flexibleNode)
        .parameter(1)
        .toExtend<LangGraphRunnableConfig>();
    });
  });

  describe("with custom context type", () => {
    const AgentAnnotation = Annotation.Root({
      count: Annotation<number>({
        reducer: (_, b) => b,
        default: () => 0,
      }),
    });

    interface MyContext {
      customSetting: string;
    }

    it("accepts custom context as second type parameter", () => {
      const myNode: GraphNode<typeof AgentAnnotation, MyContext> = (
        state,
        runtime
      ) => {
        // Runtime<MyContext> has configurable?: MyContext
        expectTypeOf(runtime.configurable?.customSetting).toEqualTypeOf<
          string | undefined
        >();
        return { count: state.count + 1 };
      };

      expectTypeOf(myNode).parameter(0).toEqualTypeOf<{ count: number }>();
    });
  });

  describe("type safety", () => {
    const AgentAnnotation = Annotation.Root({
      count: Annotation<number>({
        reducer: (_, b) => b,
        default: () => 0,
      }),
      name: Annotation<string>,
    });

    it("rejects wrong types in return", () => {
      const _invalidNode: GraphNode<typeof AgentAnnotation> = () => ({
        // @ts-expect-error - count should be number, not string
        count: "not a number",
      });
      expect(_invalidNode).toBeDefined();
    });

    it("rejects invalid goto with typed nodes", () => {
      const _invalidRouter: GraphNode<
        typeof AgentAnnotation,
        Record<string, unknown>,
        "agent" | "tool"
      > = () =>
        // @ts-expect-error - 'invalid' is not in "agent" | "tool"
        new Command({ goto: "invalid" });
      expect(_invalidRouter).toBeDefined();
    });
  });
});

// =============================================================================
// ConditionalEdgeRouter
// =============================================================================

describe("ConditionalEdgeRouter", () => {
  const AgentAnnotation = Annotation.Root({
    step: Annotation<number>({
      reducer: (_, b) => b,
      default: () => 0,
    }),
    done: Annotation<boolean>({
      reducer: (_, b) => b,
      default: () => false,
    }),
  });

  describe("return types", () => {
    it("allows returning node names", () => {
      const router: ConditionalEdgeRouter<
        typeof AgentAnnotation,
        Record<string, unknown>,
        "process" | "finalize"
      > = (state) => {
        return state.step > 5 ? "finalize" : "process";
      };

      expectTypeOf(router)
        .parameter(0)
        .toEqualTypeOf<{ step: number; done: boolean }>();
    });

    it("allows returning END", () => {
      const router: ConditionalEdgeRouter<
        typeof AgentAnnotation,
        Record<string, unknown>,
        "continue"
      > = (state) => {
        if (state.done) return END;
        return "continue";
      };

      expectTypeOf(router)
        .parameter(0)
        .toEqualTypeOf<{ step: number; done: boolean }>();

      expectTypeOf(router).returns.toExtend<
        | "continue"
        | typeof END
        | Send<"continue", { step: number; done: boolean }>
        | Array<"continue" | Send<"continue", { step: number; done: boolean }>>
      >();
    });

    it("allows returning Send packets", () => {
      const fanOutRouter: ConditionalEdgeRouter<
        typeof AgentAnnotation,
        Record<string, unknown>,
        "worker"
      > = (state) => {
        return new Send("worker", { step: state.step, done: state.done });
      };

      expectTypeOf(fanOutRouter)
        .parameter(0)
        .toEqualTypeOf<{ step: number; done: boolean }>();
    });

    it("allows returning arrays of nodes and Send packets", () => {
      const fanOutRouter: ConditionalEdgeRouter<
        typeof AgentAnnotation,
        Record<string, unknown>,
        "worker"
      > = (state) => {
        return [
          new Send("worker", { step: state.step, done: state.done }),
          new Send("worker", { step: state.step + 1, done: false }),
        ];
      };

      expectTypeOf(fanOutRouter)
        .parameter(0)
        .toEqualTypeOf<{ step: number; done: boolean }>();
    });
  });

  describe("type safety", () => {
    it("rejects invalid Send node names", () => {
      const _invalidRouter: ConditionalEdgeRouter<
        typeof AgentAnnotation,
        Record<string, unknown>,
        "worker"
      > = (state) =>
        // @ts-expect-error - "invalid" is not in "worker"
        new Send("invalid", { step: state.step, done: false });
      expect(_invalidRouter).toBeDefined();
    });
  });
});

// =============================================================================
// Send
// =============================================================================

describe("Send", () => {
  const AgentAnnotation = Annotation.Root({
    count: Annotation<number>({
      reducer: (_, b) => b,
      default: () => 0,
    }),
    name: Annotation<string>,
  });

  it("types node and args correctly", () => {
    const packet: Send<
      "process",
      ExtractUpdateType<typeof AgentAnnotation>
    > = new Send("process", { count: 5 });

    expectTypeOf(packet.node).toEqualTypeOf<"process">();
    expectTypeOf(packet.args).toEqualTypeOf<{
      count?: number | undefined;
      name?: string | undefined;
    }>();
  });
});

// =============================================================================
// Schema type helpers
// =============================================================================

describe("Schema type helpers", () => {
  describe("Annotation.Root", () => {
    const schema = Annotation.Root({
      messages: Annotation<string[]>({
        reducer: (a, b) => [...a, ...b],
        default: () => [],
      }),
    });

    it("provides .State type helper", () => {
      type SchemaState = typeof schema.State;
      expectTypeOf<SchemaState>().toEqualTypeOf<{ messages: string[] }>();
    });

    it("provides .Update type helper", () => {
      type SchemaUpdate = typeof schema.Update;
      expectTypeOf<SchemaUpdate>().toEqualTypeOf<{
        messages?: string[] | undefined;
      }>();
    });

    it("provides .Node type helper", () => {
      const myNode: typeof schema.Node = (state) => {
        return { messages: [...state.messages, "new"] };
      };

      expectTypeOf(myNode).parameter(0).toEqualTypeOf<{ messages: string[] }>();
    });
  });

  describe("StateSchema", () => {
    const schema = new StateSchema({
      count: z.number().default(0),
      name: z.string(),
    });

    it("provides .State type helper", () => {
      type SchemaState = typeof schema.State;
      expectTypeOf<SchemaState>().toEqualTypeOf<{
        count: number;
        name: string;
      }>();
    });

    it("provides .Update type helper", () => {
      type SchemaUpdate = typeof schema.Update;
      expectTypeOf<SchemaUpdate>().toEqualTypeOf<{
        count?: number | undefined;
        name?: string | undefined;
      }>();
    });

    it("provides .Node type helper", () => {
      const myNode: typeof schema.Node = (state) => {
        return { count: state.count + 1 };
      };

      expectTypeOf(myNode)
        .parameter(0)
        .toEqualTypeOf<{ count: number; name: string }>();
    });
  });

  describe("StateGraph", () => {
    it("provides .Node type helper", () => {
      const builder = new StateGraph(
        Annotation.Root({
          count: Annotation<number>({
            reducer: (_, b) => b,
            default: () => 0,
          }),
        })
      );

      const myNode: typeof builder.Node = (state) => {
        return { count: state.count + 1 };
      };

      expectTypeOf(myNode).parameter(0).toEqualTypeOf<{ count: number }>();
    });
  });
});
