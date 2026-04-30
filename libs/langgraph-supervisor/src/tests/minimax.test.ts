import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import {
  clampTemperature,
  stripThinkTags,
  MINIMAX_BASE_URL,
  MINIMAX_MODELS,
} from "../minimax.js";
import { createSupervisor } from "../supervisor.js";
import { FakeToolCallingChatModel } from "./utils.js";

describe("MiniMax utilities", () => {
  describe("clampTemperature", () => {
    it("should clamp temperature below 0 to 0", () => {
      expect(clampTemperature(-0.5)).toBe(0);
    });

    it("should clamp temperature above 1 to 1", () => {
      expect(clampTemperature(1.5)).toBe(1);
    });

    it("should keep valid temperature unchanged", () => {
      expect(clampTemperature(0.7)).toBe(0.7);
    });

    it("should handle temperature of 0", () => {
      expect(clampTemperature(0)).toBe(0);
    });

    it("should handle temperature of 1", () => {
      expect(clampTemperature(1)).toBe(1);
    });

    it("should return 0.01 for undefined", () => {
      expect(clampTemperature(undefined)).toBe(0.01);
    });
  });

  describe("stripThinkTags", () => {
    it("should strip single think block", () => {
      const input =
        "<think>Let me reason about this...</think>The answer is 42.";
      expect(stripThinkTags(input)).toBe("The answer is 42.");
    });

    it("should strip multiple think blocks", () => {
      const input =
        "<think>First thought</think>Hello <think>Second thought</think>World";
      expect(stripThinkTags(input)).toBe("Hello World");
    });

    it("should handle multiline think blocks", () => {
      const input =
        "<think>\nStep 1: Consider the problem\nStep 2: Solve it\n</think>\nThe solution is here.";
      expect(stripThinkTags(input)).toBe("The solution is here.");
    });

    it("should return content unchanged when no think tags present", () => {
      const input = "Just a normal response without any think tags.";
      expect(stripThinkTags(input)).toBe(input);
    });

    it("should handle empty content", () => {
      expect(stripThinkTags("")).toBe("");
    });

    it("should trim whitespace after stripping", () => {
      const input = "  <think>reasoning</think>  Result  ";
      expect(stripThinkTags(input)).toBe("Result");
    });
  });

  describe("constants", () => {
    it("should have correct MiniMax base URL", () => {
      expect(MINIMAX_BASE_URL).toBe("https://api.minimax.io/v1");
    });

    it("should have expected MiniMax models", () => {
      expect(MINIMAX_MODELS).toContain("MiniMax-M2.7");
      expect(MINIMAX_MODELS).toContain("MiniMax-M2.7-highspeed");
      expect(MINIMAX_MODELS).toContain("MiniMax-M2.5");
      expect(MINIMAX_MODELS).toContain("MiniMax-M2.5-highspeed");
    });
  });
});

describe("Supervisor with MiniMax-style model", () => {
  it("should work with a model mimicking ChatMiniMax behavior", async () => {
    // Create a FakeToolCallingChatModel that simulates MiniMax behavior
    const supervisorMessages = [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "transfer_to_worker",
            args: {},
            id: "call_minimax_1",
            type: "tool_call",
          },
        ],
      }),
      new AIMessage({
        content: "Task completed by the worker agent.",
      }),
    ];

    const workerMessages = [
      new AIMessage({
        content: "I have completed the assigned task.",
      }),
    ];

    const supervisorModel = new FakeToolCallingChatModel({
      responses: supervisorMessages,
    });

    const workerModel = new FakeToolCallingChatModel({
      responses: workerMessages,
    });

    const workerTool = tool(async (_args) => "Task result", {
      name: "execute_task",
      description: "Execute a task.",
      schema: z.object({
        task: z.string().describe("The task to execute"),
      }),
    });

    const workerAgent = createReactAgent({
      llm: workerModel,
      tools: [workerTool],
      name: "worker",
      description: "A worker agent that executes tasks.",
    });

    const workflow = createSupervisor({
      agents: [workerAgent],
      llm: supervisorModel,
      prompt: "You are a supervisor managing a worker agent.",
    });

    const app = workflow.compile();
    expect(app).toBeDefined();

    const result = await app.invoke({
      messages: [new HumanMessage("Execute the task please.")],
    });

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);

    // Final message should be the supervisor's completion message
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.content).toBe(
      "Task completed by the worker agent."
    );
  });

  it("should handle think tags in model responses", async () => {
    // Simulate a MiniMax M2.5 model that includes think tags
    const supervisorMessages = [
      new AIMessage({
        content:
          "<think>Let me think about which agent to delegate to...</think>",
        tool_calls: [
          {
            name: "transfer_to_analyst",
            args: {},
            id: "call_think_1",
            type: "tool_call",
          },
        ],
      }),
      new AIMessage({
        content:
          "<think>The analyst has provided the results. Let me summarize.</think>The analysis is complete. Revenue grew 15% year over year.",
      }),
    ];

    const analystMessages = [
      new AIMessage({
        content:
          "<think>Analyzing the data...</think>Revenue data shows 15% YoY growth.",
      }),
    ];

    const supervisorModel = new FakeToolCallingChatModel({
      responses: supervisorMessages,
    });

    const analystModel = new FakeToolCallingChatModel({
      responses: analystMessages,
    });

    const analyzeTool = tool(async (_args) => "Revenue: $1.2M (up 15%)", {
      name: "analyze_data",
      description: "Analyze financial data.",
      schema: z.object({
        query: z.string().describe("Analysis query"),
      }),
    });

    const analystAgent = createReactAgent({
      llm: analystModel,
      tools: [analyzeTool],
      name: "analyst",
      description: "A financial analyst agent.",
    });

    const workflow = createSupervisor({
      agents: [analystAgent],
      llm: supervisorModel,
      prompt: "You are a supervisor managing an analyst.",
    });

    const app = workflow.compile();
    const result = await app.invoke({
      messages: [new HumanMessage("Analyze the revenue data.")],
    });

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();

    // The final message content includes think tags (stripping is done by ChatMiniMax, not the supervisor)
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.content).toContain("analysis is complete");
  });

  it("should work with multiple agents using MiniMax-style model", async () => {
    const supervisorMessages = [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "transfer_to_researcher",
            args: {},
            id: "call_mm_multi_1",
            type: "tool_call",
          },
        ],
      }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "transfer_to_writer",
            args: {},
            id: "call_mm_multi_2",
            type: "tool_call",
          },
        ],
      }),
      new AIMessage({
        content: "Article about AI trends has been written.",
      }),
    ];

    const researcherMessages = [
      new AIMessage({
        content: "AI trends: 1) Multi-modal models 2) Agent frameworks 3) Edge AI",
      }),
    ];

    const writerMessages = [
      new AIMessage({
        content: "Article draft: Top 3 AI Trends for 2024...",
      }),
    ];

    const supervisorModel = new FakeToolCallingChatModel({
      responses: supervisorMessages,
    });

    const researcherModel = new FakeToolCallingChatModel({
      responses: researcherMessages,
    });

    const writerModel = new FakeToolCallingChatModel({
      responses: writerMessages,
    });

    const searchTool = tool(async (_args) => "AI trend results", {
      name: "web_search",
      description: "Search the web.",
      schema: z.object({ query: z.string() }),
    });

    const writeTool = tool(async (_args) => "Article written", {
      name: "write_article",
      description: "Write an article.",
      schema: z.object({ topic: z.string() }),
    });

    const researcher = createReactAgent({
      llm: researcherModel,
      tools: [searchTool],
      name: "researcher",
      description: "Research agent that searches the web.",
    });

    const writer = createReactAgent({
      llm: writerModel,
      tools: [writeTool],
      name: "writer",
      description: "Writer agent that creates articles.",
    });

    const workflow = createSupervisor({
      agents: [researcher, writer],
      llm: supervisorModel,
      prompt: "You are a team supervisor managing a researcher and a writer.",
    });

    const app = workflow.compile();
    const result = await app.invoke({
      messages: [
        new HumanMessage("Write an article about the latest AI trends."),
      ],
    });

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);

    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.content).toBe(
      "Article about AI trends has been written."
    );
  });
});
