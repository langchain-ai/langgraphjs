/**
 * Deepagents agent factory for the memory MRE.
 *
 * Configures a supervisor with parallel general-purpose subagents and
 * stub tools that produce realistic-sized payloads. The topology
 * matches the customer's deployment: supervisor fans out to N research
 * subagents, each making multiple LLM calls with tool use.
 */
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { createDeepAgent } from "deepagents";
import { tool } from "langchain";
import { z } from "zod";

const SYSTEM_PROMPT = `You are a helpful research assistant. When asked to research multiple topics, delegate each topic to a separate subagent for parallel research. Always use the available tools to gather information before responding.`;

/**
 * Stub tools with realistic payload sizes — the LLM sees a tool
 * surface that encourages tool use and produces sizable responses.
 */
const stubTools = [
  tool(
    async ({ input }) => {
      await new Promise((r) => setTimeout(r, 100));
      return JSON.stringify({
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `Result ${i}: ${input.slice(0, 30)}`,
          content: `Detailed result content. `.repeat(20),
        })),
      });
    },
    {
      name: "webSearch",
      description: "Search the web for information on a topic.",
      schema: z.object({
        input: z.string(),
        time_range: z.string().optional(),
      }),
    },
  ),
  tool(
    async ({ urls }) => {
      await new Promise((r) => setTimeout(r, 200));
      return JSON.stringify({
        results: urls.map((u) => ({
          url: u,
          content: `Page content for ${u}. `.repeat(50),
        })),
      });
    },
    {
      name: "webUrlExtract",
      description: "Extract content from one or more URLs.",
      schema: z.object({
        urls: z.array(z.string()),
      }),
    },
  ),
  tool(
    async ({ query }) => {
      await new Promise((r) => setTimeout(r, 50));
      return JSON.stringify({
        results: [
          { title: query, content: `Knowledge base result. `.repeat(10) },
        ],
      });
    },
    {
      name: "knowledgeBaseSearch",
      description: "Search the knowledge base.",
      schema: z.object({
        query: z.string(),
      }),
    },
  ),
];

/**
 * Build the deepagents agent graph.
 */
export function buildAgent(options: {
  model: BaseLanguageModel;
}): ReturnType<typeof createDeepAgent> {
  const { model } = options;

  return createDeepAgent({
    model,
    tools: stubTools,
    systemPrompt: SYSTEM_PROMPT,
  });
}
