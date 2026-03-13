import { z } from "zod";
import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";

const weatherTool = tool(
  async ({ city }) => {
    const conditions = ["Sunny", "Cloudy", "Rainy", "Partly Cloudy"];
    const temp = Math.floor(Math.random() * 30) + 50;
    return JSON.stringify({
      city,
      temperature: temp,
      condition: conditions[Math.floor(Math.random() * conditions.length)],
      unit: "fahrenheit",
    });
  },
  {
    name: "get_weather",
    description: "Get the current weather for a given city",
    schema: z.object({
      city: z.string().describe("The city to get weather for"),
    }),
  },
);

const searchWebTool = tool(
  async ({ query }) => {
    const slug = query.toLowerCase().replace(/\s+/g, "-");
    return JSON.stringify({
      query,
      results: [
        {
          title: `Getting Started with ${query}`,
          url: `https://example.com/${slug}`,
          snippet:
            "A comprehensive guide covering the fundamentals and best practices for getting started.",
        },
        {
          title: `${query} — Official Documentation`,
          url: `https://docs.example.com/${slug}`,
          snippet:
            "Official reference documentation with detailed API specifications and usage examples.",
        },
        {
          title: `${query}: Best Practices & Tips`,
          url: `https://blog.example.com/${slug}`,
          snippet:
            "Expert tips and industry best practices compiled from real-world production experience.",
        },
      ],
    });
  },
  {
    name: "search_web",
    description: "Search the web for information about a topic",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  },
);

const model = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
  reasoning: { effort: "low", summary: "auto" },
});

export const agent = createAgent({
  model,
  tools: [weatherTool, searchWebTool],
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful assistant that can check the weather and search the web.

When asked about weather, always use the get_weather tool.
When asked to search or find information, use the web_search tool.
After using a tool, summarize the results clearly and helpfully.`,
});
