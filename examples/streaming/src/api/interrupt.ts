/**
 * Human-in-the-loop against the Python `agent_interrupt` graph.
 *
 * The graph calls `interrupt({type: "foo"})` once and expects a resume
 * value of shape `{"the-answer": "<something>"}`. This script:
 *
 *   1. Drives the graph until it interrupts.
 *   2. Prints the pending interrupt metadata.
 *   3. Sends an intentionally wrong-namespace `input.respond` to verify
 *      the server rejects it with `no_such_interrupt` — the fix added in
 *      the v2 spec-compliance round.
 *   4. Retries with the correct namespace and lets the run complete.
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/interrupt.ts
 */

import { Client, ProtocolError } from "@langchain/langgraph-sdk";
import type { BaseMessage } from "@langchain/core/messages";

import { apiUrl, requireServer, short } from "./_shared.js";

async function main() {
  const url = apiUrl();
  await requireServer(url);

  const client = new Client({ apiUrl: url });
  const thread = client.threads.stream({ assistantId: "agent_interrupt" });

  await thread.run.start({
    input: {
      messages: [{ role: "user", content: "please interrupt me" }],
    },
  });

  console.log("--- Draining values until interrupt ---\n");
  for await (const snapshot of thread.values) {
    const msgs = (snapshot as { messages: BaseMessage[] }).messages ?? [];
    console.log(`  snapshot: ${msgs.length} message(s)`);
    if (thread.interrupted) break;
  }

  if (!thread.interrupted) {
    console.error("Graph completed without interrupting. Aborting.");
    await thread.close();
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n--- ${thread.interrupts.length} pending interrupt(s) ---\n`
  );
  for (const entry of thread.interrupts) {
    console.log(`  id:        ${entry.interruptId}`);
    console.log(
      `  namespace: ${entry.namespace.length ? entry.namespace.join("/") : "(root)"}`
    );
    console.log(`  payload:   ${short(entry.payload)}\n`);
  }

  const first = thread.interrupts[0];

  // --- Verify namespace validation ---
  //
  // The Python server's `input.respond` handler cross-checks the
  // claimed namespace against the one that emitted the interrupt and
  // returns `no_such_interrupt` on mismatch. We expect this call to
  // throw a `ProtocolError`.
  console.log(
    "--- Expecting rejection for wrong namespace ---",
  );
  try {
    await thread.input.respond({
      namespace: ["definitely-not-the-real-ns"],
      interrupt_id: first.interruptId,
      response: { "the-answer": "denied" },
    });
    console.error(
      "  ❌ Server accepted a mismatched namespace — validation regression."
    );
    process.exitCode = 1;
  } catch (err) {
    if (err instanceof ProtocolError) {
      console.log(`  ✓ rejected with ${err.code}: ${err.message}\n`);
    } else {
      throw err;
    }
  }

  // --- Happy path ---
  console.log("--- Resuming with correct namespace ---\n");
  await thread.input.respond({
    namespace: first.namespace,
    interrupt_id: first.interruptId,
    response: { "the-answer": "42" },
  });

  for await (const snapshot of thread.values) {
    const msgs = (snapshot as { messages?: unknown[] })?.messages ?? [];
    console.log(`  snapshot: ${msgs.length} message(s)`);
  }

  const finalState = (await thread.output) as
    | { messages?: { content?: unknown }[] }
    | undefined;
  const last = finalState?.messages?.at(-1);
  console.log(
    `\n--- Run complete. Last message: ${short(last?.content ?? "", 200)} ---`
  );

  await thread.close();
}

await main();
