/**
 * Shared model instance and tools used across streaming examples.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "langchain";
import { z } from "zod/v4";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const modelName = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

export const model = new ChatAnthropic({
  model: modelName,
  thinking: { type: "enabled", budget_tokens: 1024 },
});

export const searchWeb = tool(
  async ({ query }: { query: string }) => {
    await sleep(300);
    return JSON.stringify({
      results: [
        { title: `Result for: ${query}`, snippet: `Found info about ${query}.` },
      ],
    });
  },
  {
    name: "search_web",
    description: "Search the web for information.",
    schema: z.object({ query: z.string().describe("Search query.") }),
  }
);

export const calculator = tool(
  async ({ expression }: { expression: string }) => {
    await sleep(100);
    try {
      return String(Function(`"use strict"; return (${expression})`)());
    } catch {
      return `Error evaluating: ${expression}`;
    }
  },
  {
    name: "calculator",
    description: "Evaluate a math expression.",
    schema: z.object({
      expression: z.string().describe("Math expression to evaluate."),
    }),
  }
);
