import { describe, expectTypeOf, it } from "vitest";
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

describe("ExtractStateType with StateSchema", () => {
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

  it("should infer correct state type", () => {
    type State = ExtractStateType<typeof AgentState>;

    expectTypeOf<State>().toEqualTypeOf<{
      count: number;
      name: string;
      items: string[];
    }>();
  });

  it("should infer correct update type", () => {
    type Update = ExtractUpdateType<typeof AgentState>;

    expectTypeOf<Update>().toEqualTypeOf<{
      count?: number | undefined;
      name?: string | undefined;
      items?: string | undefined;
    }>();
  });
});

describe("GraphNode with StateSchema", () => {
  const AgentState = new StateSchema({
    count: z.number().default(0),
    name: z.string(),
  });

  it("should type node functions correctly", () => {
    const myNode: GraphNode<typeof AgentState> = (state, _config) => {
      // State should have correct types
      expectTypeOf(state.count).toEqualTypeOf<number>();
      expectTypeOf(state.name).toEqualTypeOf<string>();

      return { count: state.count + 1 };
    };

    // Verify the function type
    expectTypeOf(myNode).toBeFunction();
    expectTypeOf(myNode)
      .parameter(0)
      .toEqualTypeOf<{ count: number; name: string }>();
  });

  it("should allow async node functions", () => {
    const asyncNode: GraphNode<typeof AgentState> = async (state) => {
      await Promise.resolve();
      return { count: state.count + 1 };
    };

    expectTypeOf(asyncNode).toBeFunction();
  });

  it("StateSchema.Node should work as a type", () => {
    const myNode: typeof AgentState.Node = (state) => {
      expectTypeOf(state.count).toEqualTypeOf<number>();
      return { count: state.count + 1 };
    };

    expectTypeOf(myNode).toBeFunction();
  });
});

describe("GraphNode with Annotation", () => {
  const AgentAnnotation = Annotation.Root({
    count: Annotation<number>({
      reducer: (a, b) => a + b,
      default: () => 0,
    }),
    name: Annotation<string>,
  });

  it("should infer correct state type", () => {
    type State = ExtractStateType<typeof AgentAnnotation>;

    expectTypeOf<State>().toEqualTypeOf<{
      count: number;
      name: string;
    }>();
  });

  it("should type node functions correctly", () => {
    const myNode: GraphNode<typeof AgentAnnotation> = (state, _config) => {
      expectTypeOf(state.count).toEqualTypeOf<number>();
      expectTypeOf(state.name).toEqualTypeOf<string>();

      return { count: 1 };
    };

    expectTypeOf(myNode).toBeFunction();
  });

  it("Annotation.Node should also work", () => {
    const myNode: typeof AgentAnnotation.Node = (state) => {
      expectTypeOf(state.count).toEqualTypeOf<number>();
      return { count: 1 };
    };

    expectTypeOf(myNode).toBeFunction();
  });

  it("should work with StateGraph.addNode", () => {
    const myNode: GraphNode<typeof AgentAnnotation> = (state) => {
      return { count: state.count + 1 };
    };

    // This should compile
    const graph = new StateGraph(AgentAnnotation)
      .addNode("myNode", myNode)
      .addEdge(START, "myNode")
      .addEdge("myNode", END)
      .compile();

    expectTypeOf(graph).not.toBeNever();
  });
});

describe("GraphNode with Zod object schema", () => {
  const ZodState = z.object({
    count: z.number().default(0),
    name: z.string(),
  });

  it("should infer correct state type", () => {
    type State = ExtractStateType<typeof ZodState>;

    expectTypeOf<State>().toEqualTypeOf<{
      count: number;
      name: string;
    }>();
  });

  it("should type node functions correctly", () => {
    const myNode: GraphNode<typeof ZodState> = (state, _config) => {
      expectTypeOf(state.count).toEqualTypeOf<number>();
      expectTypeOf(state.name).toEqualTypeOf<string>();

      return { count: state.count + 1 };
    };

    expectTypeOf(myNode).toBeFunction();
  });

  it("should work with StateGraph.addNode", () => {
    const myNode: GraphNode<typeof ZodState> = (state) => {
      return { count: state.count + 1 };
    };

    const graph = new StateGraph(ZodState)
      .addNode("myNode", myNode)
      .addEdge(START, "myNode")
      .addEdge("myNode", END)
      .compile();

    expectTypeOf(graph).not.toBeNever();
  });
});

describe("GraphNode with Command routing", () => {
  const AgentAnnotation = Annotation.Root({
    step: Annotation<number>({
      reducer: (_, b) => b,
      default: () => 0,
    }),
  });

  it("should allow returning Command objects with typed nodes", () => {
    // Using second type param for typed Command.goto
    const routerNode: GraphNode<typeof AgentAnnotation, "process" | "end"> = (
      state
    ) => {
      if (state.step > 5) {
        return new Command({ goto: "end" });
      }
      return new Command({
        goto: "process",
        update: { step: state.step + 1 },
      });
    };

    expectTypeOf(routerNode).toBeFunction();
  });

  it("should allow returning plain update objects", () => {
    const mixedNode: GraphNode<typeof AgentAnnotation, "next"> = (state) => {
      // Can return plain update
      return { step: state.step + 1 };
    };

    expectTypeOf(mixedNode).not.toBeNever();
  });

  it("should allow Command without typed nodes", () => {
    // Without Nodes param, any string works for goto
    const flexibleNode: GraphNode<typeof AgentAnnotation> = (state) => {
      return new Command({
        goto: "anywhere",
        update: { step: state.step + 1 },
      });
    };

    expectTypeOf(flexibleNode).toBeFunction();
  });
});

describe("Send with ExtractUpdateType", () => {
  const AgentAnnotation = Annotation.Root({
    count: Annotation<number>({
      reducer: (_, b) => b,
      default: () => 0,
    }),
    name: Annotation<string>,
  });

  it("should extract correct update type for Send", () => {
    type Args = ExtractUpdateType<typeof AgentAnnotation>;

    expectTypeOf<Args>().toEqualTypeOf<{
      count?: number | undefined;
      name?: string | undefined;
    }>();
  });

  it("should work with Send class", () => {
    // Typed Send packet using ExtractUpdateType
    const packet: Send<
      "process",
      ExtractUpdateType<typeof AgentAnnotation>
    > = new Send("process", { count: 5 });

    expectTypeOf(packet.args).toEqualTypeOf<{
      count?: number | undefined;
      name?: string | undefined;
    }>();
  });
});

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

  it("should type conditional edge functions correctly", () => {
    const router: ConditionalEdgeRouter<
      typeof AgentAnnotation,
      "process" | "finalize"
    > = (state) => {
      expectTypeOf(state.step).toEqualTypeOf<number>();
      expectTypeOf(state.done).toEqualTypeOf<boolean>();

      if (state.done) return END;
      return state.step > 5 ? "finalize" : "process";
    };

    expectTypeOf(router).not.toBeNever();
  });

  it("should allow returning Send packets", () => {
    const fanOutRouter: ConditionalEdgeRouter<
      typeof AgentAnnotation,
      "worker"
    > = (state) => {
      // Send requires full state type (ExtractStateType)
      return [
        new Send("worker", { step: state.step, done: state.done }),
        new Send("worker", { step: state.step + 1, done: false }),
      ];
    };

    expectTypeOf(fanOutRouter).not.toBeNever();
  });

  it("should allow returning END", () => {
    const maybeEnd: ConditionalEdgeRouter<
      typeof AgentAnnotation,
      "continue"
    > = (state) => {
      if (state.done) return END;
      return "continue";
    };

    expectTypeOf(maybeEnd).not.toBeNever();
  });
});

describe("Custom config types", () => {
  const AgentAnnotation = Annotation.Root({
    count: Annotation<number>({
      reducer: (_, b) => b,
      default: () => 0,
    }),
  });

  interface MyConfig extends LangGraphRunnableConfig {
    configurable?: {
      customSetting: string;
    };
  }

  it("should allow custom config types", () => {
    // Config is the 3rd type param: GraphNode<Schema, Nodes, Config>
    const myNode: GraphNode<typeof AgentAnnotation, string, MyConfig> = (
      state,
      config
    ) => {
      expectTypeOf(config.configurable?.customSetting).toEqualTypeOf<
        string | undefined
      >();
      return { count: state.count + 1 };
    };

    expectTypeOf(myNode).not.toBeNever();
  });
});
