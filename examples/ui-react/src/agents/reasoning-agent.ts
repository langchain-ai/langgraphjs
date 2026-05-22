import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";

import { model } from "./shared";

export const agent = createAgent({
  model,
  tools: [],
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a reasoning-focused assistant. For complex problems,
show a compact "Reasoning summary" before the final answer. Break down the
important steps, call out assumptions, and keep the final answer crisp.`,
});
