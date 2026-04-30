/**
 * Human-in-the-loop (in-process) — interrupt, inspect, resume.
 *
 * Demonstrates the `streamEvents(..., { version: "v3" })` interrupt/resume lifecycle
 * when the graph is a `createAgent(...)` flow guarded by
 * `humanInTheLoopMiddleware`. When the model tries to call the
 * `send_release_update_email` tool, the middleware pauses the run and
 * surfaces an interrupt. The example inspects the pending action,
 * approves it, and resumes with `Command({ resume })` carrying the
 * decision payload expected by the middleware.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/human-in-the-loop/in-process.ts
 */

import { Command } from "@langchain/langgraph";

import { agent } from "../agents/hitl-agent.js";

const threadId = `hitl-example-${Date.now()}`;
const config = { configurable: { thread_id: threadId } };

// ── Turn 1: run until interrupt ─────────────────────────────────────────────

console.log("=== Turn 1: Run until interrupt ===\n");

const run1 = await agent.streamEvents(
  {
    messages: [
      {
        role: "user",
        content: "Send a release update email about the new streaming API",
      },
    ],
  },
  { ...config, version: "v3" }
);

for await (const msg of run1.messages) {
  const text = await msg.text;
  if (text.length > 0) {
    console.log(`  [assistant] ${text}`);
  }
}

await run1.output;

console.log(`\n  interrupted: ${run1.interrupted}`);
console.log(`  interrupts:  ${JSON.stringify(run1.interrupts, null, 2)}`);

if (!run1.interrupted) {
  console.log("\n  (graph completed without interrupting — unexpected)");
  process.exit(1);
}

// ── Build the approval payload the middleware expects ───────────────────────

type ActionRequest = { name: string };
type InterruptPayload = { actionRequests?: ActionRequest[] };

const decisions = run1.interrupts.flatMap((interrupt) => {
  const payload = interrupt.payload as InterruptPayload;
  return (payload.actionRequests ?? []).map((req) => ({
    action: req.name,
    type: "approve" as const,
  }));
});

console.log(
  `\n  User decision: APPROVED ${decisions.length} pending action(s)`
);

// ── Turn 2: resume with decision ────────────────────────────────────────────

console.log("\n=== Turn 2: Resume after approval ===\n");

const run2 = await agent.streamEvents(
  new Command({ resume: { decisions } }) as any,
  { ...config, version: "v3" }
);

for await (const msg of run2.messages) {
  const text = await msg.text;
  if (text.length > 0) {
    console.log(`  [assistant] ${text}`);
  }
}

const finalState = await run2.output;
console.log(`\n  interrupted: ${run2.interrupted}`);
console.log(
  `  final messages: ${(finalState?.messages as unknown[])?.length ?? 0}`
);
console.log("\nDone.");
