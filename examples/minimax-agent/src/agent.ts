/**
 * MiniMax ReAct Agent Example
 *
 * This example demonstrates how to use MiniMax's M2.7 model as the LLM
 * provider for a LangGraph ReAct agent with tool calling.
 *
 * MiniMax provides an OpenAI-compatible API, so it works seamlessly with
 * @langchain/openai's ChatOpenAI or the dedicated ChatMiniMax wrapper
 * from @langchain/langgraph-supervisor.
 *
 * Prerequisites:
 *   export MINIMAX_API_KEY="your-api-key"
 *
 * Run:
 *   npx tsx src/agent.ts
 */

import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatMiniMax } from "@langchain/langgraph-supervisor";

// Create a MiniMax model instance
const model = new ChatMiniMax({
  model: "MiniMax-M2.7",
  apiKey: process.env.MINIMAX_API_KEY,
  temperature: 0.01,
});

// Define tools for the agent
const getWeather = tool(
  async ({ city }) => {
    const weatherData: Record<string, string> = {
      "san francisco": "60°F, foggy",
      "new york": "75°F, sunny",
      beijing: "85°F, clear",
      london: "55°F, rainy",
    };
    const key = city.toLowerCase();
    return weatherData[key] ?? `Weather data not available for ${city}`;
  },
  {
    name: "get_weather",
    description: "Get the current weather for a city.",
    schema: z.object({
      city: z.string().describe("The name of the city"),
    }),
  }
);

const calculate = tool(
  async ({ expression }) => {
    try {
      // Simple expression evaluator for basic math
      const result = Function(`"use strict"; return (${expression})`)();
      return `${expression} = ${result}`;
    } catch {
      return `Cannot evaluate: ${expression}`;
    }
  },
  {
    name: "calculate",
    description: "Evaluate a mathematical expression.",
    schema: z.object({
      expression: z.string().describe("The math expression to evaluate"),
    }),
  }
);

// Create a ReAct agent with MiniMax model
const checkpointer = new MemorySaver();
const agent = createReactAgent({
  llm: model,
  tools: [getWeather, calculate],
  checkpointSaver: checkpointer,
});

// Run the agent
async function main() {
  console.log("MiniMax ReAct Agent Example\n");

  // First interaction
  const result1 = await agent.invoke(
    {
      messages: [
        new HumanMessage("What's the weather in San Francisco and Beijing?"),
      ],
    },
    { configurable: { thread_id: "minimax-demo" } }
  );

  console.log("Q: What's the weather in San Francisco and Beijing?");
  console.log(
    "A:",
    result1.messages[result1.messages.length - 1].content,
    "\n"
  );

  // Follow-up with memory
  const result2 = await agent.invoke(
    {
      messages: [
        new HumanMessage(
          "What's the temperature difference between those two cities?"
        ),
      ],
    },
    { configurable: { thread_id: "minimax-demo" } }
  );

  console.log(
    "Q: What's the temperature difference between those two cities?"
  );
  console.log(
    "A:",
    result2.messages[result2.messages.length - 1].content
  );
}

main().catch(console.error);
