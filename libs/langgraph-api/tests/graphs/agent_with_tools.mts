/**
 * Minimal agent graph that uses ToolNode so that streamMode: "tools" emits
 * tool lifecycle events (on_tool_start, on_tool_end). Used by embed tests.
 */
import {
  StateGraph,
  START,
  END,
  MessagesAnnotation,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import {
  AIMessage,
  isAIMessage,
  isToolMessage,
} from "@langchain/core/messages";
import { z } from "zod/v3";

const weatherTool = tool(
  async ({ query }: { query: string }) => {
    if (
      query.toLowerCase().includes("sf") ||
      query.toLowerCase().includes("san francisco")
    ) {
      return "It's 60 degrees and foggy.";
    }
    return "It's 90 degrees and sunny.";
  },
  {
    name: "weather",
    description: "Get the current weather for a location.",
    schema: z.object({
      query: z.string().describe("The location to get weather for."),
    }),
  }
);

const aiWithToolCall = new AIMessage({
  content: "",
  tool_calls: [
    {
      id: "call_embed_1",
      args: { query: "SF" },
      name: "weather",
      type: "tool_call",
    },
  ],
});

const aiDone = new AIMessage({ content: "Done." });

async function agentNode(state: typeof MessagesAnnotation.State) {
  const last = state.messages[state.messages.length - 1];
  if (last && isToolMessage(last)) {
    return { messages: [aiDone] };
  }
  return { messages: [aiWithToolCall] };
}

function shouldContinue(
  state: typeof MessagesAnnotation.State
): "tools" | typeof END {
  const lastMessage = state.messages[state.messages.length - 1];
  if (!isAIMessage(lastMessage)) return END;
  if ((lastMessage.tool_calls?.length ?? 0) > 0) return "tools";
  return END;
}

const workflow = new StateGraph(MessagesAnnotation)
  .addNode("agent", agentNode)
  .addNode("tools", new ToolNode([weatherTool]))
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("tools", "agent");

export const graph = workflow.compile();
