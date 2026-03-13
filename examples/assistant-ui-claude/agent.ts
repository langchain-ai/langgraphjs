import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";

const model = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-5-nano",
});

export const agent = createAgent({
  model,
  tools: [],
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful general-purpose assistant in a Claude-style interface.

Be clear, thoughtful, and concise by default.
When useful:
- structure responses with short sections or bullets
- explain trade-offs
- give concrete examples
- end with practical next steps

You can help with writing, technical questions, brainstorming, planning, and everyday research.`,
});
