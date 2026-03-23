import { describe, it, expect } from "vitest";
import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatMiniMax } from "../minimax.js";
import { createSupervisor } from "../supervisor.js";

// Integration tests require MINIMAX_API_KEY to be set
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;

describe.skipIf(!MINIMAX_API_KEY)("ChatMiniMax integration tests", () => {
  it("should create a ChatMiniMax instance with default config", () => {
    const model = new ChatMiniMax({
      apiKey: MINIMAX_API_KEY,
    });
    expect(model).toBeDefined();
  });

  it("should invoke ChatMiniMax and get a response", async () => {
    const model = new ChatMiniMax({
      model: "MiniMax-M2.7",
      apiKey: MINIMAX_API_KEY,
      temperature: 0.01,
    });

    const response = await model.invoke([
      new HumanMessage("Say 'hello' and nothing else."),
    ]);

    expect(response).toBeDefined();
    expect(typeof response.content).toBe("string");
    expect((response.content as string).toLowerCase()).toContain("hello");
    // Verify think tags are stripped
    expect(response.content).not.toContain("<think>");
  });

  it("should work with tool calling", async () => {
    const model = new ChatMiniMax({
      model: "MiniMax-M2.7",
      apiKey: MINIMAX_API_KEY,
      temperature: 0.01,
    });

    const weatherTool = tool(
      async ({ city }) => `The weather in ${city} is sunny, 25°C.`,
      {
        name: "get_weather",
        description: "Get the current weather for a city.",
        schema: z.object({
          city: z.string().describe("The city name"),
        }),
      }
    );

    const agent = createReactAgent({
      llm: model,
      tools: [weatherTool],
    });

    const result = await agent.invoke({
      messages: [
        new HumanMessage("What's the weather in Beijing? Use the get_weather tool."),
      ],
    });

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(1);

    // The final message should contain weather info
    const lastMessage = result.messages[result.messages.length - 1];
    expect(typeof lastMessage.content).toBe("string");
  });

  it("should work with supervisor multi-agent pattern", async () => {
    const model = new ChatMiniMax({
      model: "MiniMax-M2.7",
      apiKey: MINIMAX_API_KEY,
      temperature: 0.01,
    });

    const calcTool = tool(
      async ({ a, b }) => `${a + b}`,
      {
        name: "add",
        description: "Add two numbers together.",
        schema: z.object({
          a: z.number().describe("First number"),
          b: z.number().describe("Second number"),
        }),
      }
    );

    const calcAgent = createReactAgent({
      llm: model,
      tools: [calcTool],
      name: "calculator",
      description: "A calculator agent that can add numbers.",
    });

    const workflow = createSupervisor({
      agents: [calcAgent],
      llm: model,
      prompt:
        "You are a supervisor. Delegate math questions to the calculator agent.",
    });

    const app = workflow.compile();
    const result = await app.invoke({
      messages: [new HumanMessage("What is 3 + 5?")],
    });

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
