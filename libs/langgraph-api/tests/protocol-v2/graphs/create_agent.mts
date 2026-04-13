import { tool } from "langchain";
import { createAgent } from "langchain";
import { z } from "zod/v4";

import { createDeterministicToolCallingModel } from "./shared.mjs";

const weatherTool = tool(
  async ({ city }: { city: string }) => {
    await new Promise((r) => setTimeout(r, 200));
    return JSON.stringify({
      city,
      temp_f: 64,
      condition: "Foggy",
    });
  },
  {
    name: "get_weather",
    description: "Get weather for a city",
    schema: z.object({
      city: z.string(),
    }),
  }
);

export const graph = createAgent({
  model: createDeterministicToolCallingModel({
    toolCallId: "call-weather-1",
    toolName: "get_weather",
    toolArgs: { city: "San Francisco" },
    finalText: "It's 64F and foggy in San Francisco.",
  }),
  tools: [weatherTool],
  systemPrompt: "You are a deterministic weather agent for protocol testing.",
});
