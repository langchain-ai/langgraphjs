import { describe, it, expect } from "@jest/globals";
import { z } from "zod";
import { StateGraph } from "../graph/state.js";
import { END, START } from "../constants.js";
import "../graph/zod/plugin.js";

describe("StateGraph with Zod schemas", () => {
  it("should accept Zod schema as input in addNode", async () => {
    // Create a Zod schema for the state
    const stateSchema = z.object({
      messages: z.array(z.string()),
      count: z.number(),
    });

    // Create a node that uses a different Zod schema for input
    const nodeInputSchema = z.object({
      messages: z.array(z.string()),
    });

    type NodeInput = z.infer<typeof nodeInputSchema>;

    const graph = new StateGraph(stateSchema)
      .addNode(
        "process",
        (input: NodeInput) => {
          // input should be typed according to the node's input schema
          expect(input.messages).toBeDefined();
          // @ts-expect-error count is not in the node's input schema, but we still want to check that it's not in the input
          expect(input.count).toBeUndefined();
          return { messages: [...input.messages, "processed"] };
        },
        {
          input: nodeInputSchema,
        }
      )
      .addEdge(START, "process")
      .addEdge("process", END)
      .compile();

    const result = await graph.invoke({ messages: ["hello"], count: 1 });
    expect(result).toEqual({
      messages: ["hello", "processed"],
      count: 1,
    });
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
});
