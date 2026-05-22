/**
 * Deep agent with multiple poem-writing subagents.
 *
 * Used by the `subagents/` and `subagent-status/` examples to demonstrate
 * how to observe a fan-out of subagents — both in-process (via the
 * `run.subgraphs` projection) and remotely (via `thread.subagents`).
 */

import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";

import { modelName } from "./shared.js";

const checkpointer = new MemorySaver();

export const agent = createDeepAgent({
  model: modelName,
  checkpointer,
  subagents: [
    {
      name: "haiku-drafter",
      description: "Writes a short haiku about the user's topic.",
      systemPrompt: `You are the haiku drafter.

Write exactly one haiku with three lines.
Aim for a simple 5-7-5 rhythm and keep the imagery vivid.`,
    },
    {
      name: "limerick-writer",
      description: "Writes a playful limerick about the user's topic.",
      systemPrompt: `You are the limerick writer.

Write exactly one limerick with five lines.
Make it light, rhythmic, and fun while staying on the user's topic.`,
    },
    {
      name: "quatrain-poet",
      description: "Writes a four-line poem about the user's topic.",
      systemPrompt: `You are the quatrain poet.

Write exactly one poem with four lines.
Keep it lyrical, compact, and easy to compare with the other poems.`,
    },
    {
      name: "fifty-line-poet",
      description: "Writes a fifty-line poem about the user's topic.",
      systemPrompt: `You are the fifty-line poet.

Write exactly one poem with 50 lines.
Keep it lyrical, clear, and much more expansive than the shorter poems.`,
    },
  ],
  systemPrompt: `You are the poetry coordinator.

When the user asks for a poem or creative writing, ask all four subagents to work
on the same topic in parallel so the frontend can show four subagents running at
the same time.

Then return all four results with short labels so the user can compare the haiku,
limerick, quatrain, and fifty-line poem.`,
});
