import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";

const model = new ChatOpenAI({ model: "gpt-4o-mini" });

/**
 * Stream Reconnection Agent
 *
 * A conversational agent designed to generate longer responses,
 * making it easier to test the stream reconnection feature.
 *
 * The checkpointer (MemorySaver) stores conversation state, which
 * combined with reconnectOnMount in the React hook, enables
 * resuming streams after page refresh.
 */
export const agent = createAgent({
  model,
  tools: [],
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful assistant that provides detailed, comprehensive responses.

When asked to write stories, explain concepts, or create guides:
- Provide thorough, well-structured responses
- Use headings and bullet points for organization
- Include examples and details
- Aim for responses that take 10-20 seconds to stream

This helps demonstrate the stream reconnection feature - users can refresh
the page mid-response and the stream will automatically resume.`,
});
