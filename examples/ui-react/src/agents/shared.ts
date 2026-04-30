import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "langchain";
import { z } from "zod/v4";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const modelName = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

export const model = new ChatAnthropic({
  model: modelName,
  temperature: 0.2,
  // Emit token-level deltas so the UI can render assistant text as it
  // arrives. Without this flag the agent uses `.invoke()` and the LLM
  // returns a single fully-formed `AIMessage`, which makes the demo
  // look choppy even though the underlying protocol is streaming.
  streaming: true,
});

export const searchWeb = tool(
  async ({ query }: { query: string }) => {
    await sleep(220);
    return JSON.stringify({
      query,
      results: [
        {
          title: `Intro to ${query}`,
          snippet: `An overview of key ideas and landmarks in ${query}.`,
        },
        {
          title: `${query}: recent developments`,
          snippet: `What changed recently and why it matters.`,
        },
      ],
    });
  },
  {
    name: "search_web",
    description: "Search the web for information on a topic.",
    schema: z.object({
      query: z.string().describe("Search query."),
    }),
  }
);

export const summarizeFindings = tool(
  async ({
    text,
    format,
  }: {
    text: string;
    format: "bullets" | "prose";
  }) => {
    await sleep(180);
    const clean = text.trim();
    if (format === "bullets") {
      const parts = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
      return JSON.stringify({
        summary: parts.map((s) => `- ${s.trim()}`).join("\n"),
      });
    }
    return JSON.stringify({ summary: clean });
  },
  {
    name: "summarize_findings",
    description: "Summarize text into bullets or prose.",
    schema: z.object({
      text: z.string(),
      format: z.enum(["bullets", "prose"]),
    }),
  }
);

export const scoreRisks = tool(
  async ({ risks }: { risks: string[] }) => {
    await sleep(160);
    const scored = risks.map((risk, index) => ({
      risk,
      severity: (["low", "medium", "high"] as const)[index % 3],
      likelihood: (["low", "medium", "high"] as const)[(index + 1) % 3],
    }));
    return JSON.stringify({ scored });
  },
  {
    name: "score_risks",
    description: "Score a list of risks by severity and likelihood.",
    schema: z.object({
      risks: z.array(z.string()).describe("Risks to evaluate."),
    }),
  }
);

/**
 * Deliberately slow tool used by the re-attach verification harness.
 * Sleeps long enough for a human to refresh the page or remount the
 * hook mid-run and observe whether the client re-attaches to the
 * in-flight run on hydration.
 */
export const deepResearch = tool(
  async ({ topic }: { topic: string }) => {
    const steps = [
      `Gathering primary sources for "${topic}"...`,
      `Cross-referencing secondary sources...`,
      `Synthesising findings...`,
    ];
    const notes: string[] = [];
    for (const step of steps) {
      notes.push(step);
      await sleep(7_000);
    }
    notes.push(`Done researching "${topic}".`);
    return JSON.stringify({ topic, notes });
  },
  {
    name: "deep_research",
    description:
      "Long-running deep research simulation (~21s). Use when the user " +
      "explicitly asks for deep / slow / long research. Do NOT use for " +
      "ordinary questions.",
    schema: z.object({
      topic: z.string().describe("Topic to research deeply."),
    }),
  }
);

export const calculator = tool(
  async ({ expression }: { expression: string }) => {
    await sleep(80);
    try {
      return JSON.stringify({
        expression,
        value: Function(`"use strict"; return (${expression})`)(),
      });
    } catch (error) {
      return JSON.stringify({
        expression,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  {
    name: "calculator",
    description: "Evaluate a simple math expression.",
    schema: z.object({
      expression: z.string().describe("Math expression to evaluate."),
    }),
  }
);
