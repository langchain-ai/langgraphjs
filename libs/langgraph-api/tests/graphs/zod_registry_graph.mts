/**
 * Test graph using Zod with withLangGraph and jsonSchemaExtra.
 * This tests Priority 2 of the schema extraction strategy.
 */
import { z } from "zod/v3";
import { StateGraph, START, END, GraphNode } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";

// Define state using Zod with withLangGraph for jsonSchemaExtra
const AgentState = z.object({
  messages: withLangGraph(z.array(z.string()), {
    reducer: {
      schema: z.string(),
      fn: (a: string[], b: string) => [...a, b],
    },
    default: () => [],
    jsonSchemaExtra: {
      langgraph_type: "messages",
    },
  }),
  count: z.number().default(0),
  status: z.enum(["idle", "processing", "done"]).default("idle"),
});

const processNode: GraphNode<typeof AgentState> = (state) => {
  return {
    messages: `Message ${state.count + 1}`,
    count: state.count + 1,
    status: "processing",
  };
};

const workflow = new StateGraph(AgentState)
  .addNode("process", processNode)
  .addEdge(START, "process")
  .addEdge("process", END);

export const graph = workflow.compile();
