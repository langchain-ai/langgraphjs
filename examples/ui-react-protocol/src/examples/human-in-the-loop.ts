/**
 * Human-in-the-loop: detect an interrupt, inspect the payload, and resume.
 *
 * Demonstrates: session.interrupted, session.interrupts, session.input.respond()
 *
 * The "human-in-the-loop" agent uses humanInTheLoopMiddleware with an
 * interruptOn config for the "send_release_update_email" tool. When
 * the model tries to call that tool, the run pauses and emits an
 * interrupt. This script detects it, prints the pending action, and
 * resumes with an "approve" decision.
 *
 * Subscriptions are session-scoped: a single `values` subscription
 * survives across the interrupt and resumed run without re-subscribing.
 *
 * Run against a running LangGraph server:
 *   npx tsx src/examples/human-in-the-loop.ts
 */

import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });

const session = await client.stream.open({
  protocol_version: "0.3.0",
  target: { id: "human-in-the-loop" },
});

const values = await session.subscribe("values");

await session.run.input({
  input: {
    messages: [
      {
        role: "user",
        content: "Send a release update email about the new streaming API",
      },
    ],
  },
});

console.log("Streaming state snapshots...\n");

for await (const snapshot of values) {
  const state = snapshot as Record<string, unknown>;
  const msgCount = (state.messages as unknown[])?.length ?? 0;
  console.log(`  State snapshot: ${msgCount} message(s)`);

  if (session.interrupted) break;
}

if (session.interrupted) {
  console.log(
    `\nRun interrupted with ${session.interrupts.length} interrupt(s):\n`
  );

  for (const interrupt of session.interrupts) {
    console.log(`  Interrupt ID: ${interrupt.interruptId}`);
    console.log(`  Namespace:    ${interrupt.namespace.join("/") || "(root)"}`);
    console.log(`  Payload:      ${JSON.stringify(interrupt.payload, null, 2)}`);
  }

  console.log("\nApproving all pending actions...");

  for (const interrupt of session.interrupts) {
    const payload = interrupt.payload as {
      actionRequests?: Array<{ name: string }>;
    };
    const decisions = (payload.actionRequests ?? []).map((req) => ({
      action: req.name,
      type: "approve" as const,
    }));

    await session.input?.respond({
      namespace: interrupt.namespace,
      interrupt_id: interrupt.interruptId,
      response: { decisions },
    });
  }

  console.log("Resumed. Waiting for final state...\n");

  for await (const snapshot of values) {
    const state = snapshot as Record<string, unknown>;
    const msgCount = (state.messages as unknown[])?.length ?? 0;
    console.log(`  State snapshot: ${msgCount} message(s)`);
  }

  const finalState = await values.output;
  const messages = (finalState as { messages: unknown[] })?.messages ?? [];
  console.log(`\nFinal state: ${messages.length} messages`);
} else {
  console.log("\nRun completed without interrupts.");
  const finalState = await values.output;
  console.log(`Final state: ${JSON.stringify(finalState).slice(0, 200)}`);
}

await session.close();
console.log("Done.");
