/**
 * Human-in-the-loop — interrupt, inspect, resume.
 *
 * Demonstrates the stream_experimental() interrupt/resume lifecycle:
 *
 *   Turn 1: graph runs until interrupt() → run.interrupted is true,
 *           run.interrupts contains the interrupt payloads.
 *
 *   Turn 2: resume with Command({ resume }) → graph continues from
 *           the interrupt point with the user's decision.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/human-in-the-loop.ts
 */

import { Command } from "@langchain/langgraph";
import { graph } from "./agents/approval-graph.js";

const threadId = `hitl-example-${Date.now()}`;
const config = { configurable: { thread_id: threadId } };

// ── Turn 1: run until interrupt ─────────────────────────────────────────────

console.log("=== Turn 1: Run until interrupt ===\n");

const run1 = await graph.stream_experimental(
  { messages: [{ role: "user", content: "Deploy the latest build to staging." }] },
  config
);

for await (const msg of run1.messages) {
  const text = await msg.text;
  if (text.length > 0) {
    console.log(`  [planner] ${text}`);
  }
}

// After all events are consumed, check interrupt status
await run1.output;

console.log(`\n  interrupted: ${run1.interrupted}`);
console.log(`  interrupts:  ${JSON.stringify(run1.interrupts, null, 2)}`);

if (!run1.interrupted) {
  console.log("\n  (graph completed without interrupting — unexpected)");
  process.exit(1);
}

// ── Simulate user decision ──────────────────────────────────────────────────

const userApproves = true;
console.log(`\n  User decision: ${userApproves ? "APPROVED" : "REJECTED"}`);

// ── Turn 2: resume with decision ────────────────────────────────────────────

console.log("\n=== Turn 2: Resume after approval ===\n");

const run2 = await graph.stream_experimental(
  new Command({ resume: { approved: userApproves } }),
  config
);

for await (const msg of run2.messages) {
  const text = await msg.text;
  if (text.length > 0) {
    console.log(`  [executor] ${text}`);
  }
}

const finalState = await run2.output;
console.log(`\n  interrupted: ${run2.interrupted}`);
console.log(
  `  final messages: ${(finalState?.messages as unknown[])?.length ?? 0}`
);
console.log("\nDone.");
