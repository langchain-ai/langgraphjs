import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";

import { modelName } from "./shared";

const checkpointer = new MemorySaver();

export const agent = createDeepAgent({
  model: modelName,
  checkpointer,
  subagents: [
    {
      name: "haiku-drafter",
      description: "Writes a short haiku about the user's topic.",
      systemPrompt: `You are the haiku drafter.

Write exactly one haiku with three lines following a 5-7-5 rhythm.
Keep the imagery vivid and return only the haiku.`,
    },
    {
      name: "limerick-writer",
      description: "Writes a playful limerick about the user's topic.",
      systemPrompt: `You are the limerick writer.

Write exactly one limerick with five lines on the user's topic.
Make it playful, rhythmic, and return only the limerick.`,
    },
    {
      name: "quatrain-poet",
      description: "Writes a four-line poem about the user's topic.",
      systemPrompt: `You are the quatrain poet.

Write exactly one four-line poem on the user's topic.
Keep it lyrical and compact; return only the poem.`,
    },
    {
      name: "long-poet",
      description: "Writes a 20-line poem about the user's topic.",
      systemPrompt: `You are the long-form poet.

Write exactly one 20-line poem on the user's topic.
Keep it coherent and structured; return only the poem.`,
    },
  ],
  systemPrompt: `You are the poetry coordinator.

When the user asks for a poem, dispatch every subagent in parallel on the
same topic so the UI can render four live subagent streams at once. Once all
four return, present the results side by side under short headings so the
reader can compare the haiku, limerick, quatrain, and long poem.`,
});
