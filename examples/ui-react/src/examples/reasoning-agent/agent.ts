import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";

/**
 * Create an OpenAI model with extended reasoning enabled.
 * 
 * Extended reasoning allows the model to think through complex problems step-by-step,
 * with the reasoning process visible in the response. This is particularly useful
 * for math, logic, coding, and multi-step reasoning tasks.
 */
const model = new ChatOpenAI({
  model: "gpt-5.2",
  reasoning: {
    effort: 'low', // 'low' | 'medium' | 'high' - controls reasoning depth
    summary: 'auto', // Enable reasoning summary output for streaming
  },
  // Extended thinking requires a higher max_tokens value
  maxTokens: 16000,
});

/**
 * Reasoning Agent - Demonstrates streaming of extended thinking/reasoning tokens.
 * 
 * When you ask a complex question, the model will:
 * 1. First show its thinking/reasoning process (reasoning tokens)
 * 2. Then provide the final answer (text tokens)
 * 
 * This creates a more transparent AI experience where users can see
 * how the model arrives at its conclusions.
 */
export const agent = createAgent({
  model,
  tools: [], // No tools needed for reasoning demo
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful assistant that excels at reasoning through complex problems.

When presented with questions that require careful thought, use your extended thinking capabilities to:
1. Break down the problem into steps
2. Consider different approaches
3. Work through the logic carefully
4. Arrive at a well-reasoned conclusion

Be thorough in your thinking process, as users can see and learn from how you reason.
Focus on mathematical problems, logic puzzles, and analytical questions to showcase your reasoning abilities.`,
});

