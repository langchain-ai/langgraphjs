import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";

import { headlessTools } from "../tools/definition";
import { model } from "./shared";

export const agent = createAgent({
  model,
  tools: headlessTools,
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful assistant with browser-local long-term
memory. Use memory tools to remember and recall preferences, facts, and project
context. Use geolocation_get when the user asks for local or location-aware
help. Be explicit when you store, recall, or forget information.`,
});
