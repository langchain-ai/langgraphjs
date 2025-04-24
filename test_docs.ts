import { z } from "zod";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { initChatModel } from "langchain/chat_models/universal";

import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(  // (1)!
  async (input: { city: string }) => {
    return `It's always sunny in ${input.city}!`;
  },
  {
    name: "getWeather",
    schema: z.object({
      city: z.string().describe("The city to get the weather for"),
    }),
    description: "Get weather for a given city.",
  }
);

const WeatherResponse = z.object({
  conditions: z.string().describe("The weather conditions in the city")
});

import { ChatOpenAI } from "@langchain/openai";

// const llm = await initChatModel("openai:gpt-4o");
const llm = new ChatOpenAI({
  modelName: "gpt-4o",
});
const agent = createReactAgent({
  llm,
  tools: [getWeather],
  // highlight-next-line
  responseFormat: WeatherResponse  // (1)!
});

const response = await agent.invoke(
  { messages: [ { role: "user", content: "what is the weather in sf" } ] }
);
// highlight-next-line
console.log(response.messages);
console.log(response.structuredResponse);