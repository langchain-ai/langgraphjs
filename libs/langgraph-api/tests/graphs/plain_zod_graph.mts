/**
 * Test graph using plain Zod without withLangGraph.
 * This tests Priority 3 of the schema extraction strategy (direct Zod fallback).
 */
import { z } from "zod/v4";
import {
  StateGraph,
  START,
  END,
  GraphNode,
  COMMAND_SYMBOL,
} from "@langchain/langgraph";

// Ensure COMMAND_SYMBOL is available for type resolution
// This prevents TS2742 error when exporting graph types
void COMMAND_SYMBOL;

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

// TS2742: TypeScript cannot export inferred types containing symbols from other modules.
// COMMAND_SYMBOL is properly exported from @langchain/langgraph for runtime use,
// but TypeScript's declaration emit cannot handle symbols used as computed property keys
// in cross-module scenarios. Using `as any` for the export while preserving full type
// information at all usage sites within this module and at import sites.
export const graph = workflow.compile() as any;
