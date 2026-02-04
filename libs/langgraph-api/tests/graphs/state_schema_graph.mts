/**
 * Test graph using StateSchema with MessagesValue (prebuilt ReducedValue).
 * This tests Priority 1 of the schema extraction strategy.
 *
 * MessagesValue has jsonSchemaExtra: { langgraph_type: "messages" }
 */
import { z } from "zod/v4";
import { AIMessage } from "@langchain/core/messages";
import {
  StateGraph,
  StateSchema,
  MessagesValue,
  START,
  END,
} from "@langchain/langgraph";

// Define state using StateSchema with MessagesValue (has langgraph_type: "messages")
const AgentState = new StateSchema({
  messages: MessagesValue,
  count: z.number().default(0),
});

async function processNode(
  state: typeof AgentState.State
): Promise<typeof AgentState.Update> {
  return {
    messages: [new AIMessage(`Response ${state.count + 1}`)],
    count: state.count + 1,
  };
}

const workflow = new StateGraph(AgentState)
  .addNode("process", processNode)
  .addEdge(START, "process")
  .addEdge("process", END);

export const graph = workflow.compile();
