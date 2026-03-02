/**
 * Test graph using Zod with withLangGraph and jsonSchemaExtra.
 * This tests Priority 2 of the schema extraction strategy.
 */
import { z } from "zod/v3";
import {
  StateGraph,
  START,
  END,
  GraphNode,
  COMMAND_SYMBOL,
} from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";

// Ensure COMMAND_SYMBOL is available for type resolution
// This prevents TS2742 error when exporting graph types
void COMMAND_SYMBOL;

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

// TS2742: TypeScript cannot export inferred types containing symbols from other modules.
// COMMAND_SYMBOL is properly exported from @langchain/langgraph for runtime use,
// but TypeScript's declaration emit cannot handle symbols used as computed property keys
// in cross-module scenarios. Using `as any` for the export while preserving full type
// information at all usage sites within this module and at import sites.
export const graph = workflow.compile() as any;
