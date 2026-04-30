/**
 * Research agent wired to the timeline stream transformer.
 *
 * The agent itself is an ordinary `createAgent` ReAct loop — it has no
 * knowledge that the UI exists. The magic happens in
 * {@link createTimelineTransformer}, which watches raw protocol events
 * and republishes a curated {@link TimelineEvent} union on a single
 * custom stream channel (`custom:timeline`).
 *
 * The React view for this agent subscribes **only** to
 * `custom:timeline` — no `useMessages`, no `useValues`, no
 * `useToolCalls`. Everything the browser renders comes from that
 * single projection.
 *
 * This works across package copies thanks to the symbol brand on
 * {@link StreamChannel} — `langchain` bundles its own
 * `@langchain/langgraph` copy, but both copies mint their channels
 * with the shared `Symbol.for("langgraph.stream_channel")` brand, so
 * the mux inside `createAgent` still recognises channels created
 * against the workspace copy.
 */

import { createAgent } from "langchain";

import {
  calculator,
  model,
  scoreRisks,
  searchWeb,
  summarizeFindings,
} from "./shared";
import { createTimelineTransformer } from "./timeline-transformer";

const SYSTEM_PROMPT = `You are a research assistant. For every question:

1. Call search_web at least once with a focused query.
2. Call summarize_findings on what you learned.
3. If the topic has obvious risks or trade-offs, call score_risks with
   2-4 concrete risks drawn from the summary.
4. Use calculator for any arithmetic.
5. Close with a short natural-language reply (1-3 sentences) that
   restates the headline finding.

Keep tool arguments short and focused. Prefer several small tool
calls over one giant one — it makes the timeline easier to read.`;

export const agent = createAgent({
  model,
  tools: [searchWeb, summarizeFindings, scoreRisks, calculator],
  systemPrompt: SYSTEM_PROMPT,
  streamTransformers: [createTimelineTransformer],
});
