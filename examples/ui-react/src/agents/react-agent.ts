import { createAgent } from "langchain";

import {
  calculator,
  deepResearch,
  model,
  searchWeb,
  summarizeFindings,
} from "./shared";

export const agent = createAgent({
  model,
  tools: [searchWeb, summarizeFindings, calculator, deepResearch],
  systemPrompt: `You are a helpful research assistant. When the user asks for
facts, use search_web. When they ask to summarize, call summarize_findings.
Use calculator for any arithmetic. When the user asks explicitly for
deep/slow/long research, call deep_research. Keep your final answers short
and actionable.`,
});
