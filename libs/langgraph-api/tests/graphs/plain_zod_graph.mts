/**
 * Test graph using plain Zod without withLangGraph.
 * This tests Priority 3 of the schema extraction strategy (direct Zod fallback).
 */
import { z } from "zod/v4";
import { StateGraph, START, END, GraphNode } from "@langchain/langgraph";

// Define state using plain Zod (no withLangGraph, no jsonSchemaExtra)
const AgentState = z.object({
  items: z.array(z.string()).default([]),
  counter: z.number().default(0),
  label: z.string().optional(),
});

const processNode: GraphNode<typeof AgentState> = (state) => {
  return {
    items: [...state.items, `Item ${state.counter + 1}`],
    counter: state.counter + 1,
    label: "processed",
  };
};

const workflow = new StateGraph(AgentState)
  .addNode("process", processNode)
  .addEdge(START, "process")
  .addEdge("process", END);

export const graph = workflow.compile();
