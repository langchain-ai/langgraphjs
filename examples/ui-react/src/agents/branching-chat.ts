import { MemorySaver } from "@langchain/langgraph";
import { createAgent, tool } from "langchain";
import { z } from "zod/v4";

import { model } from "./shared";

const calculate = tool(
  async ({ expression }: { expression: string }) => {
    try {
      const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
      const result = Function(`"use strict"; return (${sanitized})`)();
      return JSON.stringify({ status: "success", expression, result });
    } catch {
      return JSON.stringify({
        status: "error",
        content: `Could not evaluate: ${expression}`,
      });
    }
  },
  {
    name: "calculate",
    description: "Evaluate a mathematical expression.",
    schema: z.object({
      expression: z.string().describe("The expression to evaluate."),
    }),
  }
);

const getFact = tool(
  async ({ topic }: { topic: string }) =>
    JSON.stringify({
      status: "success",
      topic,
      fact: `A useful fact about ${topic}: alternate branches let you compare different answers without losing the original path.`,
    }),
  {
    name: "get_fact",
    description: "Get a short interesting fact about a topic.",
    schema: z.object({
      topic: z.string().describe("The topic to get a fact about."),
    }),
  }
);

export const agent = createAgent({
  model,
  tools: [calculate, getFact],
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a concise, curious assistant for demonstrating
conversation branching. Use calculate for math and get_fact for fact requests.
When users edit or regenerate earlier messages, answer naturally from that new
conversation path.`,
});
