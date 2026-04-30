import { MemorySaver } from "@langchain/langgraph";
import { createAgent, summarizationMiddleware, tool } from "langchain";
import { z } from "zod/v4";

import { model } from "./shared";

const calculate = tool(
  async ({ expression }: { expression: string }) => {
    try {
      if (!/^[\d\s+\-*/().]+$/.test(expression)) {
        return JSON.stringify({
          status: "error",
          content: "Only numbers and basic arithmetic operators are allowed.",
        });
      }
      return JSON.stringify({
        status: "success",
        content: `${expression} = ${Function(`return ${expression}`)()}`,
      });
    } catch (error) {
      return JSON.stringify({
        status: "error",
        content: error instanceof Error ? error.message : String(error),
      });
    }
  },
  {
    name: "calculate",
    description: "Perform a basic arithmetic calculation.",
    schema: z.object({
      expression: z.string().describe("A basic arithmetic expression."),
    }),
  }
);

const takeNote = tool(
  async ({ title, content }: { title: string; content: string }) =>
    JSON.stringify({
      status: "success",
      content: `Note saved: "${title}" - ${content}`,
    }),
  {
    name: "take_note",
    description: "Save an important note for the current conversation.",
    schema: z.object({
      title: z.string().describe("The note title."),
      content: z.string().describe("The note content."),
    }),
  }
);

export const agent = createAgent({
  model,
  tools: [calculate, takeNote],
  middleware: [
    summarizationMiddleware({
      model,
      trigger: { messages: 8 },
      keep: { messages: 4 },
      summaryPrefix: "Conversation Summary:\n\n",
    }),
  ],
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful travel planning assistant. Keep track of
the user's trip details and continue naturally after conversation history has
been summarized. Use tools for calculations or notes when helpful.`,
});
