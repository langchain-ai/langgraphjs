import { createAgent, tool, summarizationMiddleware } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod/v4";

const model = new ChatOpenAI({ model: "gpt-4o-mini" });

/**
 * Simple calculator tool to make conversations more interactive
 */
export const calculate = tool(
  async ({ expression }) => {
    try {
      // Safe evaluation using Function constructor
      // Only allow numbers and basic operators
      if (!/^[\d\s+\-*/().]+$/.test(expression)) {
        return JSON.stringify({
          status: "error",
          content: "Invalid expression. Only numbers and basic operators (+, -, *, /, parentheses) are allowed.",
        });
      }
      const result = new Function(`return ${expression}`)();
      return JSON.stringify({
        status: "success",
        content: `${expression} = ${result}`,
      });
    } catch (e) {
      return JSON.stringify({
        status: "error",
        content: `Failed to evaluate expression: ${(e as Error).message}`,
      });
    }
  },
  {
    name: "calculate",
    description: "Perform a mathematical calculation",
    schema: z.object({
      expression: z.string().describe("The mathematical expression to evaluate, e.g., '2 + 2' or '(10 * 5) / 2'"),
    }),
  }
);

/**
 * Simple note-taking tool to make the conversation more dynamic
 */
export const takeNote = tool(
  async ({ title, content }) => {
    return JSON.stringify({
      status: "success",
      content: `Note saved: "${title}" - ${content}`,
    });
  },
  {
    name: "take_note",
    description: "Save a note for later reference",
    schema: z.object({
      title: z.string().describe("The title of the note"),
      content: z.string().describe("The content of the note"),
    }),
  }
);

/**
 * Create a ReAct agent with summarization middleware.
 * 
 * The summarization middleware will automatically condense the conversation
 * history when it exceeds the trigger threshold, preserving the most recent
 * messages while summarizing older ones.
 */
export const agent = createAgent({
  model,
  tools: [calculate, takeNote],
  middleware: [
    summarizationMiddleware({
      model,
      // Trigger summarization when messages exceed 8 AND the conversation has been going
      trigger: { messages: 8 },
      // Keep the 4 most recent messages after summarization
      keep: { messages: 4 },
      // Custom prefix for the summary message
      summaryPrefix: "📋 **Conversation Summary:**\n\n",
    }),
  ],
  // Required for maintaining state across turns and for summarization to persist
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful travel planning assistant. You help users plan trips, provide recommendations, and answer questions about destinations.

When summarization occurs (you see a summary message), acknowledge it naturally by saying something like "I see we've been having quite a conversation! Let me continue helping you..."

You have access to these tools:
- calculate: For any math calculations (currency conversion estimates, budget calculations, etc.)
- take_note: To save important notes for the user

Be friendly, informative, and proactive in offering helpful suggestions.`,
});

