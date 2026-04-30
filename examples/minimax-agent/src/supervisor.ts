/**
 * MiniMax Multi-Agent Supervisor Example
 *
 * This example shows how to use MiniMax models with LangGraph's
 * multi-agent supervisor pattern. A supervisor agent coordinates
 * between specialized worker agents using tool-based handoffs.
 *
 * Prerequisites:
 *   export MINIMAX_API_KEY="your-api-key"
 *
 * Run:
 *   npx tsx src/supervisor.ts
 */

import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatMiniMax, createSupervisor } from "@langchain/langgraph-supervisor";

// Create MiniMax model instances
// Use M2.7 (latest, most capable) for the supervisor
const supervisorModel = new ChatMiniMax({
  model: "MiniMax-M2.7",
  apiKey: process.env.MINIMAX_API_KEY,
  temperature: 0.01,
});

// Use M2.7-highspeed for workers (faster, cost-effective)
const workerModel = new ChatMiniMax({
  model: "MiniMax-M2.7-highspeed",
  apiKey: process.env.MINIMAX_API_KEY,
  temperature: 0.01,
});

// Define tools for each specialist agent
const searchWeb = tool(
  async ({ query }) => {
    // Simulated web search results
    return `Search results for "${query}": Found 3 relevant articles about the topic.`;
  },
  {
    name: "search_web",
    description: "Search the web for information on a topic.",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  }
);

const analyzeData = tool(
  async ({ data }) => {
    return `Analysis of "${data}": Key findings - growth trend detected, 3 anomalies noted.`;
  },
  {
    name: "analyze_data",
    description: "Analyze data and provide insights.",
    schema: z.object({
      data: z.string().describe("The data or topic to analyze"),
    }),
  }
);

// Create specialized agents
const researcher = createReactAgent({
  llm: workerModel,
  tools: [searchWeb],
  name: "researcher",
  description: "Expert researcher who searches the web for information.",
  prompt:
    "You are an expert researcher. Use web search to find relevant information. " +
    "Be thorough in your research and provide detailed findings.",
});

const analyst = createReactAgent({
  llm: workerModel,
  tools: [analyzeData],
  name: "analyst",
  description: "Data analyst who provides insights from data.",
  prompt:
    "You are a skilled data analyst. Analyze the data provided to you " +
    "and return clear, actionable insights.",
});

// Create the supervisor
const workflow = createSupervisor({
  agents: [researcher, analyst],
  llm: supervisorModel,
  prompt:
    "You are a team supervisor managing a researcher and an analyst. " +
    "Delegate research tasks to the researcher and analysis tasks to the analyst. " +
    "Coordinate between them to provide comprehensive answers.",
});

// Compile and run
async function main() {
  console.log("MiniMax Multi-Agent Supervisor Example\n");

  const app = workflow.compile();

  const result = await app.invoke({
    messages: [
      new HumanMessage(
        "Research the latest trends in AI agent frameworks, then analyze the key patterns."
      ),
    ],
  });

  console.log("Q: Research AI agent framework trends and analyze patterns\n");

  // Print the conversation flow
  for (const msg of result.messages) {
    const role =
      msg._getType() === "human"
        ? "User"
        : msg._getType() === "ai"
          ? msg.name ?? "AI"
          : "Tool";
    const content =
      typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    if (content) {
      console.log(`[${role}]: ${content.slice(0, 200)}`);
    }
  }
}

main().catch(console.error);
